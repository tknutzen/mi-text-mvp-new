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

type NormalisertRolle = "jobbkonsulent" | "jobbsøker"

function normSpeaker(x: string | undefined): NormalisertRolle {
  const v = (x || "").toLowerCase().trim()

  const konsulentAliaser = new Set([
    "jobbkonsulent", "konsulent", "veileder", "coach", "rådgiver", "raadgiver", "rådgjevar", "student", "mentor", "terapeut",
    "user" // mange logger bruker "user" for veileder
  ])
  const søkerAliaser = new Set([
    "jobbsøker", "jobbsoker", "søker", "soker", "bruker", "klient", "pasient", "deltaker", "deltakar",
    "assistant" // mange logger bruker "assistant" for kandidaten
  ])

  if (konsulentAliaser.has(v)) return "jobbkonsulent"
  if (søkerAliaser.has(v)) return "jobbsøker"

  // Fallback-heuristikk hvis det kom inn fritekst
  if (v.includes("konsulent") || v.includes("veileder") || v.includes("coach") || v.includes("råd") || v === "user") {
    return "jobbkonsulent"
  }
  if (v.includes("søker") || v.includes("soker") || v.includes("bruker") || v.includes("klient") || v === "assistant") {
    return "jobbsøker"
  }
  return "jobbsøker"
}

function tilTranskript(turns: InTurn[]): { speaker: NormalisertRolle; text: string }[] {
  return (turns || [])
    .map(t => ({
      speaker: normSpeaker(t.speaker ?? t.rolle),
      text: (t.text ?? t.tekst ?? "").toString().trim()
    }))
    .filter(t => t.text.length > 0)
}

const FALLBACK_MODELLER = ["gpt-5-mini", "gpt-4o-mini", "gpt-4.1-mini"]

async function kallOpenAI(model: string, messages: any[], brukJsonModus: boolean) {
  const body: any = { model, messages, temperature: 0 }
  if (brukJsonModus) body.response_format = { type: "json_object" }

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  })

  const text = await r.text()
  if (!r.ok) {
    const msg = text || ""
    const err = new Error(`OpenAI-feil ${r.status}: ${msg}`)
    ;(err as any).status = r.status
    ;(err as any).raw = msg
    throw err
  }
  let j: any = {}
  try { j = JSON.parse(text) } catch {}
  const content = j?.choices?.[0]?.message?.content || "{}"
  return content
}

function skalFalleTilbakeUtenJsonFormat(rawErr: string) {
  return /response_format|Unrecognized request argument|does not support/i.test(rawErr || "")
}

function erModellFeil(rawErr: string) {
  return /model.*not.*found|unknown model|does not exist|not available/i.test(rawErr || "")
}

async function kallLLM(transkript: { speaker: NormalisertRolle; text: string }[]) {
  const sysBase = MI_KLASSIFISERING_PROMPT_NB
  const usr = { role: "user", content: byggAnalyseInndata(transkript as any) }

  const ønsket = process.env.OPENAI_MODEL || FALLBACK_MODELLER[0]
  const kandidater = [ønsket, ...FALLBACK_MODELLER.filter(m => m !== ønsket)]

  let sisteFeil: any = null

  for (const modell of kandidater) {
    try {
      const sys = { role: "system", content: sysBase }
      const content = await kallOpenAI(modell, [sys, usr], true)
      try { return JSON.parse(content) as KlassifiseringSvar } catch {}
    } catch (e: any) {
      sisteFeil = e
      const raw = String(e?.raw || e?.message || "")
      if (skalFalleTilbakeUtenJsonFormat(raw)) {
        try {
          const sysFallback = {
            role: "system",
            content: sysBase + "\nSvar kun med gyldig JSON-objekt, ingen fritekst, ingen forklaringer."
          }
          const content2 = await kallOpenAI(modell, [sysFallback, usr], false)
          return JSON.parse(content2) as KlassifiseringSvar
        } catch (e2: any) {
          sisteFeil = e2
        }
      }
      if (erModellFeil(raw)) {
        continue
      }
    }
  }

  const msg = String(sisteFeil?.message || "Ukjent OpenAI-feil")
  throw new Error(msg)
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error("Mangler OPENAI_API_KEY i miljøvariabler")

    const body = (await req.json()) as Body
    const base = tilTranskript(body.turns || [])
    const medIndex: RåYtring[] = base.map((t, i) => ({ index: i, speaker: t.speaker as Rolle, text: t.text }))

    if (base.length === 0) {
      return new Response(JSON.stringify({ error: "Tomt transkript" }), { status: 400 })
    }

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