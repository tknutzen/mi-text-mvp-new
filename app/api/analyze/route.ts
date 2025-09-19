// app/api/analyze/route.ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { scoreFromAnalysis, generateFeedback } from "@/lib/report";
import type { Analysis, Topic, Turn } from "@/lib/types";

// Hvis du har lib/oars.ts tilgjengelig (anbefalt):
import {
  tallyOARS,
  basicRatios,
  lengthStats,
  collectOARSExamples,
} from "@/lib/oars";

/* ------------------------ Hjelpere ------------------------ */

function normSpeaker(s?: string): "jobbkonsulent" | "jobbsøker" {
  const v = String(s || "").toLowerCase();
  if (v.includes("konsulent")) return "jobbkonsulent";
  if (v.includes("søker") || v.includes("soker")) return "jobbsøker";
  // Fallback: alt som ikke er konsulent blir jobbsøker
  return v === "user" ? "jobbkonsulent" : "jobbsøker";
}

function toTurns(raw: any[]): Turn[] {
  return (raw || [])
    .map((t) => ({
      speaker: normSpeaker(t.speaker ?? t.rolle),
      text: String(t.text ?? t.tekst ?? "").trim(),
      ts: t.ts ?? Date.now(),
    }))
    .filter((t) => t.text.length > 0);
}

const TOPICS: Topic[] = [
  "Jobbambivalens",
  "Manglende oppmøte",
  "Redusere rusbruk",
  "Aggressiv atferd",
];

function safeTopic(label?: string): Topic {
  const v = String(label || "").trim();
  return (TOPICS as string[]).includes(v) ? (v as Topic) : "Jobbambivalens";
}

/* Veldig konservativ «temaanalyse»: holder primærtema, samler evt. enkle skift */
function conservativeTopicAnalysis(
  turns: Turn[],
  primary: Topic
): Analysis["topics"] {
  return {
    primary_topic: primary,
    other_topics: [],
    topic_shifts: 0,
    by_turn: [],
  };
}

/* ------------------------ GET ------------------------ */
export async function GET() {
  return NextResponse.json(
    { ok: true, route: "analyze", version: "v4-report-restored" },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/* ------------------------ POST ------------------------ */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const turns = toTurns(body.turns || []);
    const topic = safeTopic(body.topic);

    if (!turns.length) {
      return NextResponse.json(
        { error: "Tomt transkript" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Heuristikk: OARS-telling, forholdstall, lengde, eksempler
    const counts = tallyOARS(turns);
    const ratios = basicRatios(counts);
    const length = lengthStats(turns);
    const examples = collectOARSExamples(turns); // <- fyller open/closed/reflections/affirmations/summaries

    // Tema (konservativ forutsigbarhet)
    const topics = conservativeTopicAnalysis(turns, topic);

    const base: Analysis = {
      counts,
      ratios,
      length,
      topics,
      client_language: { change_talk_examples: [], sustain_talk_examples: [] },
      global_scores: {
        partnership: 3,
        empathy: 3,
        cultivating_change_talk: 3,
        softening_sustain_talk: 3,
      },
      total_score: 0,
      difficulty: body.difficulty || undefined,
      examples, // <- VIKTIG for "Vis eksempler"-lenkene i rapporten
    };

    // Poeng + feedback fra nye beregninger
    base.total_score = scoreFromAnalysis(base);
    base.feedback = generateFeedback(base);

    return NextResponse.json(base, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    console.error("Analyze error:", e);
    return NextResponse.json(
      { error: e?.message || "Ukjent feil i analyze" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}