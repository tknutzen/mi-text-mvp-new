// lib/report.ts
export type Difficulty = "lett" | "moderat" | "vanskelig"

export type Analysis = {
  difficulty?: Difficulty
  counts?: {
    open_questions?: number
    closed_questions?: number
    reflections_simple?: number
    reflections_complex?: number
    summaries?: number
    affirmations?: number
  }
  ratios?: {
    open_question_share?: number
    reflection_to_question?: number
    complex_reflection_share?: number
  }
  length?: { student_turns?: number }
  topics?: { topic_shifts?: number }
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const clamp100 = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

const EXPECTED_PER_TURNS = {
  affirmations: (turns: number) => Math.max(1, Math.round(turns / 6)),
  complexReflections: (turns: number) => Math.max(1, Math.round(turns / 5))
}

function expectedSummaries(turns: number, topicShifts: number) {
  let exp = 1
  if (topicShifts >= 1) exp += 1
  if (topicShifts >= 3) exp += 1
  if (turns >= 22) exp += 1
  return Math.min(4, exp)
}

export function scoreFromAnalysis(a: Analysis): number {
  const c = a.counts || {}
  const r = a.ratios || {}

  const turns = a.length?.student_turns ?? 0
  const shifts = a.topics?.topic_shifts ?? 0

  const targetOpen = 0.70
  const targetRQ = 0.80
  const targetCxShare = 0.30

  const expSum = expectedSummaries(turns, shifts)
  const expAff = EXPECTED_PER_TURNS.affirmations(turns)
  const expCxAbs = EXPECTED_PER_TURNS.complexReflections(turns)

  const openScore = 25 * clamp01((r.open_question_share ?? 0) / targetOpen)
  const rqScore = 25 * clamp01((r.reflection_to_question ?? 0) / targetRQ)

  const cxShare = r.complex_reflection_share ?? 0
  const cxAbs = c.reflections_complex ?? 0
  const cxScoreShare = 14 * clamp01(cxShare / targetCxShare)
  const cxScoreAbs = 6 * clamp01(cxAbs / expCxAbs)
  const cxScore = cxScoreShare + cxScoreAbs

  const sumScore = 15 * clamp01((c.summaries ?? 0) / expSum)
  const affScore = 10 * clamp01((c.affirmations ?? 0) / expAff)
  const focusScore = 5 * clamp01(1 - Math.min(shifts, 5) / 5)

  const base = openScore + rqScore + cxScore + sumScore + affScore + focusScore

  const closedHeavy = c.closed_questions ?? 0
  const closedPenalty = closedHeavy > 6 ? Math.min(8, (closedHeavy - 6) * 1.2) : 0

  const total = clamp100(base - closedPenalty)
  return total
}