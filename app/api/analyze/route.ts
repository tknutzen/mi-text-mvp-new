// app/api/analyze/route.ts
import { NextRequest } from "next/server"
import crypto from "crypto"

import {
  MI_KLASSIFISERING_PROMPT_NB_STRICT,
  MI_KLASSIFISERING_PROMPT_NB_LITE,
  byggAnalyseInndata,
  etterbehandleKlassifisering,
  tellingerFraKlassifisering,
  type Rolle,
  type RåYtring,
  type KlassifiseringSvar
} from "@/lib/mi_prompt"
import { scoreFromAnalysis } from "@/lib/report"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

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

const FALLBACK_MODELLER = ["gpt-5-mini", "gpt-4o-mini", "gpt-4.1-mini"]

function sha256(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex")
}

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
    const err = new Error(`OpenAI-feil ${r.status}: ${text}`)
    ;(err as any).status = r.status
    ;(err as any).raw = text
    throw err
  }
  const j = JSON.parse(text)
  const content = j?.choices?.[0]?.message?.content || "{}"
  return content
}

function skalFalleTilbakeUtenJsonFormat(rawErr: string) {
  return /response_format|Unrecognized request argument|does not support/i.test(rawErr || "")
}
function erModellFeil(rawErr: string) {
  return /model.*not.*found|unknown model|does not exist|not available/i.test(rawErr || "")
}

async function kallLLM(base: { speaker: Rolle; text: string }[], prompt: string) {
  const usr = { role: "user", content: byggAnalyseInndata(base) }
  const sys = { role: "system", content: prompt }

  const ønsket = process.env.OPENAI_MODEL || FALLBACK_MODELLER[0]
  const kandidater = [ønsket, ...FALLBACK_MODELLER.filter(m => m !== ønsket)]
  let sisteFeil: any = null

  for (const modell of kandidater) {
    try {
      const content = await kallOpenAI(modell, [sys, usr], true)
      try { return JSON.parse(content) as KlassifiseringSvar } catch {}
    } catch (e: any) {
      sisteFeil = e
      const raw = String(e?.raw || e?.message || "")
      if (skalFalleTilbakeUtenJsonFormat(raw)) {
        try {
          const sysFB = { role: "system", content: prompt + "\nSvar KUN med gyldig JSON-objekt." }
          const content2 = await kallOpenAI(modell, [sysFB, usr], false)
          return JSON.parse(content2) as KlassifiseringSvar
        } catch (e2: any) { sisteFeil = e2 }
      }
      if (erModellFeil(raw)) continue
    }
  }
  throw new Error(String(sisteFeil?.message || "Ukjent OpenAI-feil"))
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error("Mangler OPENAI_API_KEY")

    const url = new URL(req.url)
    const modeFromQuery = (url.searchParams.get("mode") || "").toLowerCase()
    const modeFromEnv = (process.env.MI_PROMPT_MODE || "strict").toLowerCase()
    const prompt_mode = (modeFromQuery === "lite" || modeFromQuery === "strict") ? modeFromQuery : modeFromEnv

    const prompt = prompt_mode === "lite" ? MI_KLASSIFISERING_PROMPT_NB_LITE : MI_KLASSIFISERING_PROMPT_NB_STRICT
    const prompt_sha256 = sha256(prompt)

    const body = (await req.json().catch(() => ({}))) as Body
    const base = tilTranskript(body.turns || [])
    if (base.length === 0) {
      return new Response(JSON.stringify({ error: "Tomt transkript" }), { status: 400 })
    }

    // Kjør modell
    const rå = await kallLLM(base, prompt)

    // Etterbehandling og tellinger
    const medIndex: RåYtring[] = base.map((t, i) => ({ index: i, speaker: t.speaker, text: t.text }))
    const klass = etterbehandleKlassifisering(medIndex, rå)
    const tellinger = tellingerFraKlassifisering(klass)

    // counts/ratios for scoring/rapport
    const counts = {
      open_questions: tellinger.aapne,
      closed_questions: tellinger.lukkede,
      reflections_simple: tellinger.refleksjonEnkel,
      reflections_complex: tellinger.refleksjonKompleks,
      summaries: tellinger.oppsummeringer,
      affirmations: tellinger.bekreftelser
    }
    const ratios = {
      open_question_share: (tellinger.spørsmålTotalt ? tellinger.aapne / tellinger.spørsmålTotalt : 0),
      reflection_to_question: (tellinger.spørsmålTotalt ? (tellinger.refleksjonerTotalt) / tellinger.spørsmålTotalt : 0),
      complex_reflection_share: (tellinger.refleksjonerTotalt ? tellinger.refleksjonKompleks / tellinger.refleksjonerTotalt : 0)
    }

    // Eksempler (til klikkbare lister i rapporten)
    const byIndex: Record<number, string> = {}
    for (const t of medIndex) if (t.speaker === "jobbkonsulent") byIndex[t.index] = t.text

    const examples = {
      open_questions: [] as string[],
      closed_questions: [] as string[],
      reflections_simple: [] as string[],
      reflections_complex: [] as string[],
      affirmations: [] as string[],
      summaries: [] as string[]
    }
    for (const r of klass.per_turn || []) {
      const txt = byIndex[r.index] || ""
      if (!txt) continue
      if (r.labels.open_question) examples.open_questions.push(txt)
      if (r.labels.closed_question) examples.closed_questions.push(txt)
      if (r.labels.reflection_simple) examples.reflections_simple.push(txt)
      if (r.labels.reflection_complex) examples.reflections_complex.push(txt)
      if (r.labels.affirmation) examples.affirmations.push(txt)
      if (r.labels.summary) examples.summaries.push(txt)
    }

    // analysis-like for scoring
    const analysisLike = {
      counts,
      ratios,
      length: { student_turns: base.filter(t => t.speaker === "jobbkonsulent").length },
      topics: { topic_shifts: 0 }
    } as any

    const total_score = scoreFromAnalysis(analysisLike)

    // Svarobjekt til klient/rapport
    const resultat = {
      prompt_mode,
      prompt_sha256,
      tellinger,
      counts,
      ratios,
      examples,               // ⬅️ brukes av /api/report til «Vis eksempler»
      klassifisering: klass.per_turn,
      tema: body.topic || "",
      total_score
    }

    return new Response(JSON.stringify(resultat), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Prompt-Mode": prompt_mode,
        "X-Prompt-SHA256": prompt_sha256
      }
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || "Ukjent feil" }), { status: 500 })
  }
}
