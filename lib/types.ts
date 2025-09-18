// lib/types.ts
export type Speaker = 'jobbkonsulent' | 'jobbsøker';

export type Turn = {
  speaker: Speaker;
  text: string;
  ts?: number; // unix ms (frontend kan sende Date.now())
};

export type Topic =
  | 'Jobbambivalens'
  | 'Manglende oppmøte'
  | 'Redusere rusbruk'
  | 'Aggressiv atferd';

export type Difficulty = 'lett' | 'moderat' | 'vanskelig';

export type OarsCounts = {
  open_questions: number;
  closed_questions: number;
  reflections_simple: number;
  reflections_complex: number;
  affirmations: number;
  summaries: number;
};

export type OarsRatios = {
  open_question_share: number;      // åpne / (åpne+lukkede)
  reflection_to_question: number;   // (alle refleksjoner) / (alle spørsmål)
  complex_reflection_share: number; // komplekse / (alle refleksjoner)
};

export type LengthStats = {
  student_turns: number;        // antall veileder-turer
  total_words_student: number;
  total_words_client: number;
  total_words_all: number;
  flags: ('too_short' | 'too_long')[];
};

export type TopicSummary = {
  primary_topic: Topic | string;
  other_topics: string[];
  topic_shifts: number;
  by_turn: { turnIndex: number; topic: string }[];
};

export type ClientLanguage = {
  change_talk_examples: string[];
  sustain_talk_examples: string[];
};

export type GlobalScores = {
  partnership: number;
  empathy: number;
  cultivating_change_talk: number;
  softening_sustain_talk: number;
};

export type Feedback = {
  strengths: string[];
  improvements: string[];
  next_exercises: string[];
};

export type OarsExamples = {
  open_questions: string[];
  closed_questions: string[];
  reflections_simple: string[];
  reflections_complex: string[];
  affirmations: string[];
  summaries: string[];
};

export type Analysis = {
  counts: OarsCounts;
  ratios: OarsRatios;
  topics: TopicSummary;
  length: LengthStats;
  client_language: ClientLanguage;
  global_scores: GlobalScores;
  feedback?: Feedback;
  total_score: number;
  /** Nytt: vanskelighetsgrad for nivå-tilpasset feedback */
  difficulty?: Difficulty;
  /** Nytt: eksempler pr. OARS-kategori, brukt i rapporten */
  examples?: OarsExamples;
};