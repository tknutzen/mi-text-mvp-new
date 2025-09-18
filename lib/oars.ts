// lib/oars.ts
import { Turn } from './types';

/** ---------- Hjelpere ---------- */

const norm = (s: string) =>
  (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9æøåÆØÅ\.\,\!\?\-\s]/g, '')
    .trim();

function splitSentences(raw: string): string[] {
  const m = (raw || '').match(/[^.!?]+[.!?]?/g);
  return (m || []).map(s => s.trim()).filter(Boolean);
}

function isSentenceQuestion(s: string) {
  return (s || '').trim().endsWith('?');
}

function isCounselor(turn: Turn) { return turn.speaker === 'jobbkonsulent'; }

function wordCount(s: string) {
  return (s || '').trim().split(/\s+/).filter(Boolean).length;
}

/** ---------- Spørsmål (åpne/lukkede) ---------- */

const OPEN_START = /^(hva|hvordan|hvilke|hvilken|hvem|hvorfor|fortell|beskriv|utdyp|si mer|fortell mer|gi et eksempel)\b/;
const OPEN_HELP  = /^kan du (fortelle|utdype|beskrive|dele|si mer|gi et eksempel)\b/;

const CLOSED_START = /^(er|har|kan|vil|skal|gjør|går|kommer du|er det|er du|ble det|ble du|skal du|må du|burde du)\b/;

function classifyQuestionSentence(sentence: string): 'open'|'closed' {
  const t = norm(sentence);
  if (OPEN_START.test(t) || OPEN_HELP.test(t)) return 'open';
  // Hvis setningen starter som “lukket”, men inneholder eksplisitt invitasjon til å utdype
  if (CLOSED_START.test(t) && /(si mer|fortell mer|utdyp|beskriv gjerne)/.test(t)) return 'open';
  return 'closed';
}

/** ---------- Refleksjoner / bekreftelser / oppsummeringer ---------- */

const REFLEX_COMPLEX_PATTERNS: RegExp[] = [
  /på den ene siden.*på den andre siden/,
  /både .* og .*/,
  /men samtidig/,
  /samtidig som/,
  /det (virker|høres) som (om|at)/,
  /jeg får inntrykk av at/,
  /selv om .* (så|,)/,
  /du prøver .* samtidig/
];

const REFLEX_SIMPLE_PATTERNS: RegExp[] = [
  /^så du\b/,
  /^du (sier|nevner|tenker|føler|mener|opplever|ønsker|vil|prøver å|virker|kjenner)\b/,
  /^det du sier (er|virker)\b/,
  /^jeg hører\b/,
  /^jeg forstår at\b/,
  /^høres ut som\b/,
  /^hvis jeg forstår (deg )?rett\b/
];

const AFFIRMATIONS_PATTERNS: RegExp[] = [
  /\b(bra|flott|sterkt|imponerende|fint|godt jobbet|bra jobbet|du har allerede|du viser|du har fått til|det krever mot|sterk innsats|godt poeng|takk for at du deler|målrettet og modig)\b/
];

const SUMMARY_LINGUISTIC: RegExp[] = [
  /(oppsummering:|for å oppsummere|la meg oppsummere|hvis jeg skal oppsummere|kort oppsummert|hovedpunktene er|så langt jeg forstår|om jeg oppsummerer)/
];

const SUMMARY_TRANSITION: RegExp[] = [
  /(før vi går videre|over til (et|et nytt) tema|skifte (av )?tema|som en overgang|avslutningsvis|til slutt|før vi runder av|når vi runder av|på tampen)/,
];

const ENDING_MARKERS =
  /(\bavslutt(er|e)?\b|\bvi runder av\b|\b(takk|tusen takk) for (praten|samtalen)\b|\bvi snakkes\b|\bha det\b|\bjeg må (gå|avslutte)\b)/;

/** Skal denne setningen telle som oppsummering gitt kontekst? */
function isSummarySentence(
  sentenceNorm: string,
  isNearEnd: boolean,
  hasTransitionMarkerInSentence: boolean
): boolean {
  const hasLinguistic = SUMMARY_LINGUISTIC.some(re => re.test(sentenceNorm));
  if (hasLinguistic) return true;
  // Viktig spesialregel: En god refleksjon helt mot slutt/overgang → regnes som oppsummering
  if (isNearEnd && (hasTransitionMarkerInSentence || /^du\b|^det du sier\b|^hvis jeg forstår/.test(sentenceNorm))) {
    return true;
  }
  return false;
}

/** ---------- Eksporterte typer (counts) ---------- */
export type OarsCounts = {
  open_questions: number;
  closed_questions: number;
  reflections_simple: number;
  reflections_complex: number;
  affirmations: number;
  summaries: number;
};

/** ---------- Hovedteller ---------- */
export function tallyOARS(turns: Turn[]): OarsCounts {
  const counts: OarsCounts = {
    open_questions: 0,
    closed_questions: 0,
    reflections_simple: 0,
    reflections_complex: 0,
    affirmations: 0,
    summaries: 0,
  };

  const counselorIndexes: number[] = [];
  turns.forEach((t, i) => { if (isCounselor(t)) counselorIndexes.push(i); });
  const lastCounselorIdx = counselorIndexes.length ? counselorIndexes[counselorIndexes.length - 1] : -1;
  const secondLastCounselorIdx = counselorIndexes.length > 1 ? counselorIndexes[counselorIndexes.length - 2] : -1;

  for (let idx = 0; idx < turns.length; idx++) {
    const t = turns[idx];
    if (!isCounselor(t)) continue;

    const sentences = splitSentences(t.text || '');
    const isFinal = idx === lastCounselorIdx;
    const isNearEnd = isFinal || idx === secondLastCounselorIdx;

    for (const sRaw of sentences) {
      const s = sRaw.trim();
      if (!s) continue;

      if (isSentenceQuestion(s)) {
        const kind = classifyQuestionSentence(s);
        if (kind === 'open') counts.open_questions++;
        else counts.closed_questions++;
        continue;
      }

      const sNorm = norm(s);
      const hasTransition = SUMMARY_TRANSITION.some(re => re.test(sNorm)) || ENDING_MARKERS.test(sNorm);
      const asSummary = isSummarySentence(sNorm, isNearEnd, hasTransition);
      if (asSummary) {
        counts.summaries++;
        // ikke dobbelttell som refleksjon
      } else {
        if (REFLEX_COMPLEX_PATTERNS.some(re => re.test(sNorm))) {
          counts.reflections_complex++;
        } else if (REFLEX_SIMPLE_PATTERNS.some(re => re.test(sNorm))) {
          counts.reflections_simple++;
        } else if (/^du\s+\S+/.test(sNorm) && !/^(prøv|prøve|burde|må|skal|kan du)\b/.test(sNorm)) {
          counts.reflections_simple++;
        }
      }

      if (AFFIRMATIONS_PATTERNS.some(re => re.test(sNorm))) {
        counts.affirmations++;
      }
    }
  }

  return counts;
}

/** ---------- Eksempler pr. kategori (for rapporten) ---------- */
export function collectOARSExamples(turns: Turn[]) {
  const examples = {
    open_questions: [] as string[],
    closed_questions: [] as string[],
    reflections_simple: [] as string[],
    reflections_complex: [] as string[],
    affirmations: [] as string[],
    summaries: [] as string[],
  };

  const counselorIndexes: number[] = [];
  turns.forEach((t, i) => { if (isCounselor(t)) counselorIndexes.push(i); });
  const lastCounselorIdx = counselorIndexes.length ? counselorIndexes[counselorIndexes.length - 1] : -1;
  const secondLastCounselorIdx = counselorIndexes.length > 1 ? counselorIndexes[counselorIndexes.length - 2] : -1;

  for (let idx = 0; idx < turns.length; idx++) {
    const t = turns[idx];
    if (!isCounselor(t)) continue;

    const sentences = splitSentences(t.text || '');
    const isFinal = idx === lastCounselorIdx;
    const isNearEnd = isFinal || idx === secondLastCounselorIdx;

    for (const sRaw of sentences) {
      const s = sRaw.trim();
      if (!s) continue;

      if (isSentenceQuestion(s)) {
        const kind = classifyQuestionSentence(s);
        if (kind === 'open') examples.open_questions.push(s);
        else examples.closed_questions.push(s);
        continue;
      }

      const sNorm = norm(s);
      const hasTransition = SUMMARY_TRANSITION.some(re => re.test(sNorm)) || ENDING_MARKERS.test(sNorm);
      const asSummary = isSummarySentence(sNorm, isNearEnd, hasTransition);
      if (asSummary) {
        examples.summaries.push(s);
      } else {
        if (REFLEX_COMPLEX_PATTERNS.some(re => re.test(sNorm))) {
          examples.reflections_complex.push(s);
        } else if (REFLEX_SIMPLE_PATTERNS.some(re => re.test(sNorm))) {
          examples.reflections_simple.push(s);
        } else if (/^du\s+\S+/.test(sNorm) && !/^(prøv|prøve|burde|må|skal|kan du)\b/.test(sNorm)) {
          examples.reflections_simple.push(s);
        }
      }

      if (AFFIRMATIONS_PATTERNS.some(re => re.test(sNorm))) {
        examples.affirmations.push(s);
      }
    }
  }

  return examples;
}

/** ---------- Forholdstall ---------- */
export function basicRatios(counts: OarsCounts) {
  const q = counts.open_questions + counts.closed_questions;
  const r = counts.reflections_simple + counts.reflections_complex;
  return {
    open_question_share: q ? counts.open_questions / q : 0,
    reflection_to_question: q ? r / q : 0,
    complex_reflection_share: r ? counts.reflections_complex / r : 0,
  };
}

/** ---------- Lengde-/balanse-statistikk ---------- */
export function lengthStats(turns: Turn[]) {
  let counselorTurns = 0;
  let wordsCounselor = 0;
  let wordsClient = 0;

  for (const t of turns) {
    if (t.speaker === 'jobbkonsulent') {
      counselorTurns++;
      wordsCounselor += wordCount(t.text || '');
    } else if (t.speaker === 'jobbsøker') {
      wordsClient += wordCount(t.text || '');
    }
  }

  const total = wordsCounselor + wordsClient;

  const flags: ('too_short' | 'too_long')[] = [];
  if (total < 180) flags.push('too_short');
  if (total > 2000) flags.push('too_long');

  return {
    student_turns: counselorTurns,
    total_words_student: wordsCounselor,
    total_words_client: wordsClient,
    total_words_all: total,
    flags,
  };
}