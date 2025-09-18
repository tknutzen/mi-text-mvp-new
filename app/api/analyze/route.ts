// app/api/analyze/route.ts
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { tallyOARS, basicRatios, lengthStats, collectOARSExamples } from '../../../lib/oars';
import { Turn, Analysis, Topic } from '../../../lib/types';
import { scoreFromAnalysis, generateFeedback } from '../../../lib/report';

/** ------------------------ Hjelpere ------------------------ */
const norm = (s: string) =>
  (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9æøå\.\,\!\?\-\s]/g, '')
    .trim();

function isGpt5(model: string) {
  return /^gpt-5/i.test(model);
}

function extractResponsesText(resp: any): string {
  if (!resp) return '';
  if (typeof resp.output_text === 'string' && resp.output_text.trim()) return resp.output_text;
  if (Array.isArray(resp.output)) {
    const parts: string[] = [];
    for (const item of resp.output) {
      if (Array.isArray(item?.content)) {
        for (const c of item.content) {
          const val =
            c?.text?.value ??
            c?.text ??
            c?.content ??
            (typeof c?.string === 'string' ? c.string : '');
          if (typeof val === 'string' && val.trim()) parts.push(val);
        }
      }
    }
    const joined = parts.join('\n').trim();
    if (joined) return joined;
  }
  return '';
}

/** ------------------------ TEMA-ALIASSER (STRAMMET INN) ------------------------ */
const TOPIC_ALIASES: Record<Topic, string[]> = {
  'Jobbambivalens': [
    'jobbambivalens',
    'usikker på jobb',
    'tilbake i jobb',
    'arbeidsevne',
    'uføre', 'uføresøknad',
    'ytelser', 'nav-ytelser'
  ],
  'Manglende oppmøte': [
    'manglende oppmøte', 'møtefravær', 'møter ikke',
    'ute av avtaler', 'dropper møter',
    'for sent oppmøte', 'varsel om fravær'
  ],
  'Redusere rusbruk': [
    'redusere rusbruk', 'rus', 'rusbruk',
    'alkohol', 'drikking', 'cannabis', 'hasj', 'stoff',
    'kutt ned på rus', 'slutte å ruse seg'
  ],
  'Aggressiv atferd': [
    'aggressiv atferd', 'aggressivitet',
    'utbrudd', 'konflikt på jobb', 'krangel på jobb',
    'sinne i arbeidssituasjon', 'advarsler for oppførsel'
  ]
};

const ALL_TOPICS: Topic[] = [
  'Jobbambivalens',
  'Manglende oppmøte',
  'Redusere rusbruk',
  'Aggressiv atferd'
];

function detectTopicInText(text: string): Topic | null {
  const t = norm(text);
  for (const topic of ALL_TOPICS) {
    const aliases = TOPIC_ALIASES[topic] || [];
    for (const a of aliases) {
      const needle = norm(a);
      if (!needle) continue;
      const rx = new RegExp(`(^|\\b)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\b|$)`);
      if (rx.test(t)) return topic;
    }
  }
  return null;
}

function conservativeTopicAnalysis(turns: Turn[], primary: Topic) {
  const by_turn_raw: { turnIndex: number; topic: Topic }[] = [];
  const counts: Record<Topic, number> = {
    'Jobbambivalens': 0,
    'Manglende oppmøte': 0,
    'Redusere rusbruk': 0,
    'Aggressiv atferd': 0
  };

  turns.forEach((t, i) => {
    const hit = detectTopicInText(t.text || '');
    if (hit) {
      counts[hit]++;
      if (hit !== primary) by_turn_raw.push({ turnIndex: i, topic: hit });
    }
  });

  const other_topics: string[] = [];
  for (const topic of ALL_TOPICS) {
    if (topic === primary) continue;
    if ((counts[topic] || 0) >= 2) other_topics.push(topic);
  }

  const by_turn = by_turn_raw.filter(row => other_topics.includes(row.topic));
  let topic_shifts = 0;
  let last: string | null = null;
  for (const row of by_turn) {
    const cur = row.topic;
    if (last && cur !== last) topic_shifts++;
    last = cur;
  }

  return {
    topics: {
      primary_topic: primary,
      other_topics,
      topic_shifts,
      by_turn
    }
  };
}

/** ------------------------ LLM-systemprompt ------------------------ */
const analystSystem = `Du er en norsk MI-analytiker. Analyser samtalen mellom jobbkonsulent og jobbsøker.

TELL KUN OARS FOR VEILEDER/TURER.

Definisjoner:
- ÅPNE SPØRSMÅL: hva/hvordan/hvilke/hvem/hvorfor/fortell/beskriv/utdyp/«si mer», eller eksplisitt invitasjon til å snakke mer.
- LUKKEDE SPØRSMÅL: ja/nei, fakta, eller er/har/kan/vil/skal osv. uten invitasjon.
- REFLEKSJONER: enkle (speiling) og komplekse (mening/følelse, dobbelsidig, "du virker/høres ...").
- BEKREFTELSER: ressursorienterte utsagn ("godt tenkt", "modig", "du har allerede ...").
- OPPSUMMERINGER: eksplisitte markører ("Oppsummering:", "for å oppsummere", "hvis jeg forstår deg riktig … stemmer det?") også ved temaskifter og avslutning.

Returner KUN gyldig JSON i schema.`;

const feedbackSystem = `Du er veileder i MI. Skriv KUN JSON med to felt: "strengths": string[], "improvements": string[].
Krav:
- 2–3 punkter på hver side (balanserte).
- Hvert punkt: 2–4 setninger, konkrete og varierte, ikke floskler, ingen parenteser med prosent/tall.
- Referér til OARS-atferd (ikke bare generelt).
- Norsk bokmål.`;

/** ------------------------ GET ------------------------ */
export async function GET() {
  return NextResponse.json(
    { status: 'ok', route: 'analyze', version: 'v3-examples-llmfb' },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

/** ------------------------ POST ------------------------ */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { turns, topic, difficulty } = body as { turns: Turn[]; topic: Topic; difficulty?: string };

  // Heuristikk
  const counts = tallyOARS(turns);
  const ratios = basicRatios(counts);
  const rawLength = lengthStats(turns);
  const examples = collectOARSExamples(turns);

  const allowedFlags = ((rawLength.flags || []) as string[])
    .filter((f): f is 'too_short' | 'too_long' => f === 'too_short' || f === 'too_long');

  const length: Analysis['length'] = {
    student_turns: rawLength.student_turns,
    total_words_student: rawLength.total_words_student,
    total_words_client: rawLength.total_words_client,
    total_words_all: rawLength.total_words_all,
    flags: allowedFlags,
  };

  const primary: Topic = (ALL_TOPICS as string[]).includes(topic as string) ? (topic as Topic) : 'Jobbambivalens';
  const { topics } = conservativeTopicAnalysis(turns, primary);

  const base: Analysis = {
    counts,
    ratios,
    topics,
    length,
    client_language: { change_talk_examples: [], sustain_talk_examples: [] },
    global_scores: { partnership: 3, empathy: 3, cultivating_change_talk: 3, softening_sustain_talk: 3 },
    total_score: 0,
    difficulty: (difficulty as any) || undefined,
    examples
  };

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-5-mini';

  // Ingen API-key → heuristikk + vår feedback
  if (!apiKey) {
    base.total_score = scoreFromAnalysis(base);
    base.feedback = generateFeedback(base);
    return NextResponse.json(base, { headers: { 'Cache-Control': 'no-store' } });
  }

  // Med API-key → prøv å få friere feedback fra LLM (balansert), ellers fallback
  try {
    const client = new OpenAI({ apiKey });

    // Først: verifisering/utfylling (valgfritt – vi beholder våre counts/ratios hvis modellen ikke svarer)
    // (Vi hopper over denne runden nå for ytelse – dine heuristikker er gode nok.)

    // Deretter: be om balansert, variert feedback
    let llmFeedback: { strengths: string[]; improvements: string[] } | null = null;

    const payload = JSON.stringify({
      context: {
        counts,
        ratios,
        length,
        topics,
        difficulty: base.difficulty || 'moderat',
      }
    });

    if (isGpt5(model) && (client as any).responses?.create) {
      const r = await client.responses.create({
        model,
        input: [
          { role: 'system', content: feedbackSystem },
          { role: 'user', content: payload }
        ],
        max_output_tokens: 600,
        reasoning: { effort: 'low' }
      });
      const raw = extractResponsesText(r).trim();
      if (raw) { try { llmFeedback = JSON.parse(raw); } catch { llmFeedback = null; } }
    } else {
      const r = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: feedbackSystem },
          { role: 'user', content: payload }
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 450
      });
      const raw = r.choices?.[0]?.message?.content || '{}';
      try { llmFeedback = JSON.parse(raw); } catch { llmFeedback = null; }
    }

    // Poeng
    base.total_score = scoreFromAnalysis(base);

    // Feedback: LLM hvis mulig, balanser og trim; ellers generator
    if (llmFeedback && Array.isArray(llmFeedback.strengths) && Array.isArray(llmFeedback.improvements)) {
      // enkel rebalansering: 2–3 per side
      const S = llmFeedback.strengths.filter(Boolean).slice(0, 3);
      const I = llmFeedback.improvements.filter(Boolean).slice(0, 3);
      const want = 4;
      const sNeed = Math.max(2, Math.min(3, want - Math.min(2, I.length)));
      const iNeed = want - sNeed;
      base.feedback = {
        strengths: S.slice(0, sNeed),
        improvements: I.slice(0, iNeed),
        next_exercises: [
          'Øv på dobbelsidig refleksjon i en konkret situasjon fra siste økt.',
          'Avslutt et tema med en 1–2 setnings oppsummering som fremhever endringssnakk og neste steg.'
        ]
      };
    } else {
      base.feedback = generateFeedback(base);
    }

    return NextResponse.json(base, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('LLM analyze error:', err);
    base.total_score = scoreFromAnalysis(base);
    base.feedback = generateFeedback(base);
    return NextResponse.json(base, { headers: { 'Cache-Control': 'no-store' } });
  }
}