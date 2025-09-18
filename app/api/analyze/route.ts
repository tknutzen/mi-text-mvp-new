// app/api/analyze/route.ts
import { NextRequest } from "next/server"
import {
  MI_KLASSIFISERING_PROMPT_NB,
  byggAnalyseInndata,
  etterbehandleKlassifisering,
  tellingerFraKlassifisering,
  type Rolle,
  type RåYtring,
  type KlassifiseringSvar
} from "@/lib/mi_prompt"
import { scoreFromAnalysis } from "@/lib/report"

export const runtime = "nodejs"

type InTurn = { speaker?: string; rolle?: string; text?: string; tekst?: string }
type Body = { turns?: InTurn[]; topic?: string }

function normSpeaker(x: string | undefined): Rolle {
  const v = (x || "").toLowerCase()
  if (v.includes("konsulent")) return "jobbkonsulent"
  if (v.includes("søker") || v.includes("soker")) return "jobbsøker"
  return v === "user" ? "jobbkonsulent" : "jobbsøker"
}

function tilTranskript(turns: InTurn[]): { speaker: Rolle; text: string }[] {
  return (turns || [])
    .map(t => ({
      speaker: normSpeaker(t.speaker ?? t.rolle),
      text: (t.text ?? t.tekst ?? "").toString().trim()
    }))
    .filter(t => t.text.length > 0)
}

async function kallLLM(transkript: { speaker: Rolle; text: string }[]) {
  const model = process.env.OPENAI_MODEL || "gpt-5-mini"
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: MI_KLASSIFISERING_PROMPT_NB },
        { role: "user", content: byggAnalyseInndata(transkript) }
      ],
      temperature: 0
    })
  })
  if (!r.ok) throw new Error(`OpenAI-feil ${r.status}`)
  const j = await r.json()
  const content = j?.choices?.[0]?.message?.content || "{}"
  let parsed: KlassifiseringSvar
  try { parsed = JSON.parse(content) } catch { parsed = { per_turn: [] } }
  return parsed
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Body
    const base = tilTranskript(body.turns || [])
    const medIndex: RåYtring[] = base.map((t, i) => ({ index: i, speaker: t.speaker, text: t.text }))

    const rå = await kallLLM(base)
    const klass = etterbehandleKlassifisering(medIndex, rå)
    const tellinger = tellingerFraKlassifisering(klass)

    const aapne = tellinger.aapne
    const lukkede = tellinger.lukkede
    const spTot = Math.max(0, tellinger.spørsmålTotalt || 0)
    const reflE = tellinger.refleksjonEnkel
    const reflK = tellinger.refleksjonKompleks
    const reflTot = Math.max(0, tellinger.refleksjonerTotalt || 0)
    const sums = tellinger.oppsummeringer
    const affs = tellinger.bekreftelser

    const ratios = {
      open_question_share: spTot ? aapne / spTot : 0,
      reflection_to_question: spTot ? reflTot / spTot : 0,
      complex_reflection_share: reflTot ? reflK / reflTot : 0
    }

    const counts = {
      open_questions: aapne,
      closed_questions: lukkede,
      reflections_simple: reflE,
      reflections_complex: reflK,
      summaries: sums,
      affirmations: affs
    }

    const analysisLike = {
      counts,
      ratios,
      length: { student_turns: base.filter(t => t.speaker === "jobbkonsulent").length },
      topics: { topic_shifts: 0 }
    } as any

    const total_score = scoreFromAnalysis(analysisLike)

    const resultat = {
      tellinger,
      klassifisering: klass.per_turn,
      tema: body.topic || "",
      total_score
    }

    return new Response(JSON.stringify(resultat), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || "Ukjent feil" }), { status: 500 })
  }
}