// app/api/analyze/route.ts
import { NextRequest } from "next/server";
import crypto from "crypto";

import {
  MI_KLASSIFISERING_PROMPT_NB_STRICT,
  MI_KLASSIFISERING_PROMPT_NB_LITE,
  byggAnalyseInndata,
  etterbehandleKlassifisering,
  tellingerFraKlassifisering,
  type Rolle,
  type RåYtring,
  type KlassifiseringSvar
} from "@/lib/mi_prompt";
import { scoreFromAnalysis } from "@/lib/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type InTurn = { speaker?: string; rolle?: string; text?: string; tekst?: string };
type Body = { turns?: InTurn[]; topic?: string };

/* ---------------- Helpers (lokale) ---------------- */

const FALLBACK_MODELLER = ["gpt-5-mini", "gpt-4o-mini", "gpt-4.1-mini"];
const FEEDBACK_MODELLER = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-5-mini"]; // feedback prioriterer stabile chat-modeller

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function normSpeaker(x: string | undefined): Rolle {
  const v = (x || "").toLowerCase();
  if (v.includes("konsulent")) return "jobbkonsulent";
  if (v.includes("søker") || v.includes("soker")) return "jobbsøker";
  return v === "user" ? "jobbkonsulent" : "jobbsøker";
}
function tilTranskript(turns: InTurn[]): { speaker: Rolle; text: string }[] {
  return (turns || [])
    .map(t => ({
      speaker: normSpeaker(t.speaker ?? t.rolle),
      text: (t.text ?? t.tekst ?? "").toString().trim()
    }))
    .filter(t => t.text.length > 0);
}

/* ---------------- OpenAI low-level ---------------- */

async function kallOpenAI(model: string, messages: any[], brukJsonModus: boolean) {
  const body: any = { model, messages, temperature: 0 };
  if (brukJsonModus) body.response_format = { type: "json_object" };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`OpenAI-feil ${r.status}: ${text}`);
    (err as any).status = r.status;
    (err as any).raw = text;
    throw err;
  }
  const j = JSON.parse(text);
  const content = j?.choices?.[0]?.message?.content || "{}";
  return content;
}
const skalFalleTilbakeUtenJsonFormat = (rawErr: string) =>
  /response_format|Unrecognized request argument|does not support/i.test(rawErr || "");
const erModellFeil = (rawErr: string) =>
  /model.*not.*found|unknown model|does not exist|not available/i.test(rawErr || "");

/* ---------------- Klassifisering (OARS via LLM) ---------------- */

async function kallLLM(base: { speaker: Rolle; text: string }[], prompt: string) {
  const usr = { role: "user", content: byggAnalyseInndata(base) };
  const sys = { role: "system", content: prompt };

  const ønsket = process.env.OPENAI_MODEL || FALLBACK_MODELLER[0];
  const kandidater = [ønsket, ...FALLBACK_MODELLER.filter(m => m !== ønsket)];
  let sisteFeil: any = null;

  for (const modell of kandidater) {
    try {
      const content = await kallOpenAI(modell, [sys, usr], true);
      try {
        return JSON.parse(content) as KlassifiseringSvar;
      } catch {}
    } catch (e: any) {
      sisteFeil = e;
      const raw = String(e?.raw || e?.message || "");
      if (skalFalleTilbakeUtenJsonFormat(raw)) {
        try {
          const sysFB = { role: "system", content: prompt + "\nReturner KUN gyldig JSON-objekt uten kodegjerder." };
          const content2 = await kallOpenAI(modell, [sysFB, usr], false);
          return JSON.parse(content2) as KlassifiseringSvar;
        } catch (e2: any) {
          sisteFeil = e2;
        }
      }
      if (erModellFeil(raw)) continue;
    }
  }
  throw new Error(String(sisteFeil?.message || "Ukjent OpenAI-feil"));
}

/* ---------------- Setningshjelpere (reconcile-pass) ---------------- */

const SENTENCE_REGEX = /[^.!?]+[.!?]?/g;

const OPEN_START = /^(hva|hvordan|hvilke|hvilken|hvem|hvorfor|fortell|beskriv|utdyp|si mer|fortell mer|gi et eksempel)\b/i;
const OPEN_HELP = /^kan du (fortelle|utdype|beskrive|dele|si mer|gi et eksempel)\b/i;
const CLOSED_START = /^(er|har|kan|vil|skal|gjør|går|kommer du|er det|er du|ble det|ble du|skal du|må du|burde du)\b/i;

const REFLEX_COMPLEX: RegExp[] = [
  /på den ene siden.*på den andre siden/i,
  /både .* og .*/i,
  /men samtidig/i,
  /samtidig som/i,
  /(det (virker|høres)\s+(ut\s+som|som|at)\s+)/i,
  /jeg får inntrykk av at/i,
  /selv om .* (så|,)/i,
  /du prøver .* samtidig/i,
  /(det betyr|så handler det også om|så mye som)/i,
  /(målet er at|det du egentlig vil)/i
];
const REFLEX_SIMPLE: RegExp[] = [
  /^så du\b/i,
  /^du (sier|nevner|tenker|føler|mener|opplever|ønsker|vil|prøver å|virker|kjenner)\b/i,
  /^(det du sier|det høres ut som|det virker som)\b/i,
  /^jeg hører\b/i,
  /^jeg forstår at\b/i,
  /^høres ut som\b/i,
  /^hvis jeg forstår (deg )?rett\b/i
];
const AFFIRMATIONS: RegExp[] = [
  /\b(bra|flott|sterkt|imponerende|fint|godt jobbet|bra jobbet|du har allerede|du viser|du har fått til|det krever mot|sterk innsats|godt poeng|takk for at du deler|målrettet og modig)\b/i
];

const SUMMARY_LINGUISTIC: RegExp[] = [
  /(oppsummering:|for å oppsummere|la meg oppsummere|hvis jeg skal oppsummere|kort oppsummert|hovedpunktene er|så langt jeg forstår|om jeg oppsummerer)/i,
  /(så det jeg hører (deg )?si er)/i,
  /\bplan a\b|\bplan b\b/i
];
const SUMMARY_TRANSITION: RegExp[] = [
  /(før vi går videre|over til (et|et nytt) tema|skifte (av )?tema|som en overgang|avslutningsvis|til slutt|før vi runder av|når vi runder av|på tampen)/i
];

const ENDING_MARKERS = /(\bavslutt(er|e)?\b|\bvi runder av\b|\btakk for (praten|samtalen)\b|\bvi snakkes\b|\bha det\b|\bjeg må (gå|avslutte)\b)/i;

const splitSentences = (raw: string) => (raw.match(SENTENCE_REGEX) || []).map(s => s.trim()).filter(Boolean);
const isQuestionSentence = (s: string) => (s || "").trim().endsWith("?");
function classifyQuestionSentence(sentence: string): "open" | "closed" {
  const t = (sentence || "").trim().toLowerCase();
  if (OPEN_START.test(t) || OPEN_HELP.test(t)) return "open";
  if (CLOSED_START.test(t) && /(si mer|fortell mer|utdyp|beskriv gjerne)/i.test(t)) return "open";
  return "closed";
}

function reconcileLabelsForTurn(
  text: string,
  original: { open_question?: boolean; closed_question?: boolean; reflection_simple?: boolean; reflection_complex?: boolean; affirmation?: boolean; summary?: boolean },
  isNearEnd: boolean
) {
  const labels = { ...original };
  const sentences = splitSentences(text);
  const qs = sentences.filter(isQuestionSentence);
  const nonQs = sentences.filter(s => !isQuestionSentence(s));
  const nonQJoined = nonQs.join(" ").trim();
  const hasSummaryMarker = SUMMARY_LINGUISTIC.some(re => re.test(nonQJoined)) || SUMMARY_TRANSITION.some(re => re.test(nonQJoined)) || ENDING_MARKERS.test(nonQJoined);

  // Spørsmål (støtt flere i samme tur)
  let foundOpen = false;
  let foundClosed = false;
  for (const s of qs) {
    const kind = classifyQuestionSentence(s);
    if (kind === "open") foundOpen = true;
    else foundClosed = true;
  }
  if (foundOpen) labels.open_question = true;
  if (foundClosed) labels.closed_question = true;

  // Bekreftelser
  if (AFFIRMATIONS.some(re => re.test(nonQJoined))) {
    labels.affirmation = true;
  }

  // Oppsummering vinner over refleksjon
  const summaryByRule =
    hasSummaryMarker ||
    (isNearEnd && (REFLEX_SIMPLE.some(r => r.test(nonQJoined)) || REFLEX_COMPLEX.some(r => r.test(nonQJoined)) || nonQs.length >= 2));

  if (labels.summary || summaryByRule) {
    labels.summary = true;
    labels.reflection_simple = false;
    labels.reflection_complex = false;
    return { labels, summary_text: nonQJoined };
  }

  // Refleksjon (kun hvis ikke oppsummering)
  if (REFLEX_COMPLEX.some(re => re.test(nonQJoined))) {
    labels.reflection_complex = true;
    labels.reflection_simple = false;
  } else if (REFLEX_SIMPLE.some(re => re.test(nonQJoined)) || /^du\s+\S+/i.test(nonQJoined)) {
    // “du …” uten direktiver → enkel refleksjon
    labels.reflection_simple = true;
    labels.reflection_complex = false;
  }

  return { labels, summary_text: "" };
}

/* ---------------- Feedback (GPT + heuristisk fallback) ---------------- */

type Feedback = { strengths: string[]; improvements: string[] };

function heuristicFeedback(counts: any, ratios: any): Feedback {
  const strengths: string[] = [];
  const improvements: string[] = [];
  const q = counts.open_questions + counts.closed_questions;
  const r = counts.reflections_simple + counts.reflections_complex;

  if (counts.summaries > 0) strengths.push("Du oppsummerer ved skifte/slutt – det skaper struktur og felles forståelse.");
  if (q && counts.open_questions / q >= 0.5) strengths.push(`Høy andel åpne spørsmål (${Math.round((counts.open_questions / q) * 100)}%) gir klienten mer plass.`);
  if (q && r) strengths.push(`Du bruker refleksjoner jevnt (R/Q=${(r / q).toFixed(2)}).`);
  if (counts.reflections_complex > 0) strengths.push("Du har med komplekse refleksjoner som løfter mening/følelse.");
  if (!strengths.length) strengths.push("God grunnbruk av OARS – bra start.");

  if (!q || counts.open_questions / q < 0.7) {
    improvements.push("Øk andelen åpne spørsmål — hvorfor: fremmer utforsking og endringssnakk — hvordan: bytt «Fikk du det til?» til «Hvordan merket du at det hjalp?» — mål: åpne ≥ 70%.");
  }
  if (!q || r / q < 0.8) {
    improvements.push("Øk forholdet refleksjoner per spørsmål — hvorfor: viser lytting og styrer med klientens språk — hvordan: legg en kort speiling etter spørsmål — mål: R/Q ≥ 0,8.");
  }
  if (counts.reflections_complex === 0) {
    improvements.push("Legg inn komplekse refleksjoner — hvorfor: løfter mening/følelser — hvordan: «Du vil ha ro, og det handler også om å koble av hodet, ikke bare å droppe alkohol» — mål: komplekse ≥ 30%.");
  }
  if (counts.summaries < 2) {
    improvements.push("Oppsummer ved temaskifte og slutt — hvorfor: samler trådene — hvordan: «For å oppsummere: … Hva vil du starte med i dag?» — mål: ≥ 2 oppsummeringer.");
  }
  if (!improvements.length) improvements.push("Hold åpne (≥70%), R/Q ≥ 0,8, og minst to oppsummeringer ved skifte/slutt.");
  return { strengths, improvements };
}

function parseJsonLoose(s: string): any | null {
  if (!s) return null;
  let txt = s.trim();

  const fence = txt.match(/```(json)?([\s\S]*?)```/i);
  if (fence && fence[2]) txt = fence[2].trim();

  const start = txt.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < txt.length; i++) {
    const ch = txt[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = txt.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function gptFeedback(
  base: { speaker: Rolle; text: string }[],
  counts: any,
  ratios: any,
  topic?: string
): Promise<Feedback | null> {
  const sys = {
    role: "system",
    content: `
Du evaluerer en norsk MI-øvelse (OARS). Du får transkriptet (turns) og enkel statistikk (counts/ratios).
Lag KONKRET tilbakemelding og returner KUN ett JSON-objekt (ingen kodegjerder, ingen forklaringer).

Struktur:
{
  "strengths": ["..."],
  "improvements": ["..."]
}

Krav:
- strengths: 3–5 presise observasjoner om det som fungerer (forankret i mønstre/typiske formuleringer).
- improvements: 3–5 prioriterte og HANDLINGSRETTEDE punkter. Hver: (a) hva, (b) hvorfor i MI, (c) én konkret «neste-tur»-omskriving som matcher stil/tema, (d) et mikromål (velg mellom: åpne ≥70%, R/Q ≥0,8, komplekse ≥30%, oppsummeringer ≥2).
`.trim()
  };

  const recent = base.slice(-16);
  const usr = {
    role: "user",
    content: JSON.stringify({
      topic: topic || "",
      counts,
      ratios,
      sample_turns: recent
    })
  };

  let lastErr: any = null;
  for (const modell of FEEDBACK_MODELLER) {
    try {
      const content = await kallOpenAI(modell, [sys, usr], false);
      const parsed = parseJsonLoose(content);
      if (parsed && Array.isArray(parsed.strengths) && Array.isArray(parsed.improvements)) {
        return { strengths: parsed.strengths, improvements: parsed.improvements };
      }
    } catch (e: any) {
      lastErr = e;
      const raw = String(e?.raw || e?.message || "");
      if (erModellFeil(raw)) continue;
      if (skalFalleTilbakeUtenJsonFormat(raw)) continue;
    }
  }
  if (process.env.NODE_ENV !== "production") {
    console.warn("GPT feedback fallback:", lastErr?.message || lastErr);
  }
  return null;
}

/* ---------------- Handler ---------------- */

export async function POST(req: NextRequest) {
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error("Mangler OPENAI_API_KEY");

    const url = new URL(req.url);
    const modeFromQuery = (url.searchParams.get("mode") || "").toLowerCase();
    const modeFromEnv = (process.env.MI_PROMPT_MODE || "strict").toLowerCase();
    const prompt_mode = modeFromQuery === "lite" || modeFromQuery === "strict" ? modeFromQuery : modeFromEnv;

    const prompt = prompt_mode === "lite" ? MI_KLASSIFISERING_PROMPT_NB_LITE : MI_KLASSIFISERING_PROMPT_NB_STRICT;
    const prompt_sha256 = sha256(prompt);

    const body = (await req.json().catch(() => ({}))) as Body;
    const base = tilTranskript(body.turns || []);
    if (base.length === 0) {
      return new Response(JSON.stringify({ error: "Tomt transkript" }), { status: 400 });
    }

    // 1) Kjør klassifisering
    const rå = await kallLLM(base, prompt);

    // 2) Etterbehandling (fra prompt-modul)
    const medIndex: RåYtring[] = base.map((t, i) => ({ index: i, speaker: t.speaker, text: t.text }));
    const klass = etterbehandleKlassifisering(medIndex, rå);

    // 2b) Reconcile-pass (deterministisk overstyring for setningsnivå)
    // Finn hvilke veileder-turer som er "nær slutten"
    const consIdx: number[] = medIndex.filter(t => t.speaker === "jobbkonsulent").map(t => t.index);
    const lastCons = consIdx.length ? consIdx[consIdx.length - 1] : -1;
    const secondLastCons = consIdx.length > 1 ? consIdx[consIdx.length - 2] : -1;

    const byIndex: Record<number, string> = {};
    for (const t of medIndex) if (t.speaker === "jobbkonsulent") byIndex[t.index] = t.text;

    const fixedPerTurn = (klass.per_turn || []).map((r: any) => {
      if (medIndex[r.index]?.speaker !== "jobbkonsulent") return r; // bare veileder vurderes
      const txt = byIndex[r.index] || "";
      const isNearEnd = r.index === lastCons || r.index === secondLastCons;

      const { labels, summary_text } = reconcileLabelsForTurn(
        txt,
        r.labels || {},
        isNearEnd
      );

      return {
        ...r,
        labels,
        summary_text
      };
    });

    const klassFixed = { ...klass, per_turn: fixedPerTurn };

    // 3) Tellinger (fra fixed)
    const tellinger = tellingerFraKlassifisering(klassFixed);

    // 4) counts/ratios for scoring/rapport
    const counts = {
      open_questions: tellinger.aapne,
      closed_questions: tellinger.lukkede,
      reflections_simple: tellinger.refleksjonEnkel,
      reflections_complex: tellinger.refleksjonKompleks,
      summaries: tellinger.oppsummeringer,
      affirmations: tellinger.bekreftelser
    };
    const ratios = {
      open_question_share: tellinger.spørsmålTotalt ? tellinger.aapne / tellinger.spørsmålTotalt : 0,
      reflection_to_question: tellinger.spørsmålTotalt ? tellinger.refleksjonerTotalt / tellinger.spørsmålTotalt : 0,
      complex_reflection_share: tellinger.refleksjonerTotalt ? tellinger.refleksjonKompleks / tellinger.refleksjonerTotalt : 0
    };

    // 5) Eksempler til rapporten (presist per setning)
    const examples = {
      open_questions: [] as string[],
      closed_questions: [] as string[],
      reflections_simple: [] as string[],
      reflections_complex: [] as string[],
      affirmations: [] as string[],
      summaries: [] as string[]
    };

    for (const r of klassFixed.per_turn || []) {
      const txt = byIndex[r.index] || "";
      if (!txt) continue;

      const sentences = splitSentences(txt);
      const qs = sentences.filter(isQuestionSentence);
      const nonQs = sentences.filter(s => !isQuestionSentence(s));

      if (r.labels?.summary) {
        const summaryText: string =
          (r as any).summary_text && typeof (r as any).summary_text === "string"
            ? String((r as any).summary_text).trim()
            : nonQs.join(" ").trim();
        if (summaryText) examples.summaries.push(summaryText);
      }

      if (qs.length) {
        for (const s of qs) {
          const kind = classifyQuestionSentence(s);
          if (kind === "open") examples.open_questions.push(s);
          else examples.closed_questions.push(s);
        }
      }

      const candidate = nonQs.join(" ").trim();
      if (candidate) {
        if (r.labels?.reflection_complex) examples.reflections_complex.push(candidate);
        else if (r.labels?.reflection_simple) examples.reflections_simple.push(candidate);
        if (r.labels?.affirmation) examples.affirmations.push(candidate);
      }
    }

    // 6) score
    const analysisLike = {
      counts,
      ratios,
      length: { student_turns: base.filter(t => t.speaker === "jobbkonsulent").length },
      topics: { topic_shifts: 0 }
    } as any;
    const total_score = scoreFromAnalysis(analysisLike);

    // 7) Tilbakemeldinger (GPT → fallback)
    let feedback: Feedback | null = null;
    try {
      feedback = await gptFeedback(base, counts, ratios, body.topic);
    } catch {}
    if (!feedback) feedback = heuristicFeedback(counts, ratios);

    // 8) Svarobjekt
    const resultat = {
      prompt_mode,
      prompt_sha256,
      tellinger,
      counts,
      ratios,
      examples,
      klassifisering: klassFixed.per_turn,
      tema: body.topic || "",
      total_score,
      feedback
    };

    return new Response(JSON.stringify(resultat), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Prompt-Mode": prompt_mode,
        "X-Prompt-SHA256": prompt_sha256
      }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || "Ukjent feil" }), { status: 500 });
  }
}