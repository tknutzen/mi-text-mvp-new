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
  feedback?: {
    strengths?: string[]
    improvements?: string[]
    next_exercises?: string[]
  }
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

type FBOpt = {
  difficulty?: Difficulty
  desiredItems?: number
  balanceTolerance?: number
}

function difficultyTone(d: Difficulty | undefined) {
  switch (d) {
    case "lett":
      return {
        ask: "Prøv små, tydelige grep som er lette å gjennomføre allerede i neste økt.",
        stretch: "Når dette sitter, kan du gradvis øke ambisjonsnivået."
      }
    case "vanskelig":
      return {
        ask: "Hold intervensjonene korte og presise, og prioriter å sikre kontakt før du øker kompleksiteten.",
        stretch: "Når alliansen kjennes stabil, inviter til litt mer utforsking – ett skritt om gangen."
      }
    default:
      return {
        ask: "Bruk korte, målrettede grep som bygger flyt i samtalen.",
        stretch: "Når dette sitter, kan du variere mer mellom refleksjoner og oppsummeringer."
      }
  }
}

function buildStrengths(a: Analysis, tone: ReturnType<typeof difficultyTone>): string[] {
  const c = a.counts ?? ({} as any)
  const r = a.ratios ?? ({} as any)
  const out: string[] = []

  if ((r.open_question_share ?? 0) >= 0.7) {
    out.push(
      "Høy andel åpne spørsmål skaper rom for utforsking og jobbsøkerens eget språk. Det gjør det enklere å hente frem endringssnakk og holder fokus på det som er viktig for jobbsøkeren. Fortsett å bruke «hva» og «hvordan» i starten av spørsmålene, og behold den rolige rytmen mellom spørsmål og korte speilinger."
    )
  }
  if ((r.reflection_to_question ?? 0) >= 0.8) {
    out.push(
      "God balanse mellom refleksjoner og spørsmål. Jobbsøkeren får tid til å høre egne ord og bygge videre. Behold denne rytmen ved å legge inn en kort speiling før nye spørsmål – det gir flyt og fordyper samtalen."
    )
  }
  if ((c.affirmations ?? 0) >= 2) {
    out.push(
      "Bekreftelser brukes på en måte som fremmer samarbeid og mestringstro. Når du anerkjenner innsats eller verdier konkret, blir det lettere for jobbsøkeren å se egne ressurser. Fortsett med korte, presise bekreftelser knyttet til observérbar atferd."
    )
  }
  if ((c.summaries ?? 0) >= expectedSummaries(a.length?.student_turns ?? 0, a.topics?.topic_shifts ?? 0)) {
    out.push(
      "Oppsummeringene dine binder sammen nøkkelpunkter og justerer fokus uten å ta over. Når du løfter frem endringssnakk i oppsummeringen, forsterker du motivasjon og retning. Fortsett å bruke 1–2 setnings oppsummeringer ved skifter og mot slutten av tema."
    )
  }
  if ((r.complex_reflection_share ?? 0) >= 0.3) {
    out.push(
      "Komplekse refleksjoner brukes i passende mengde og gir dybde. Jobbsøkeren blir møtt på mening og følelse, ikke bare innhold. Veksle gjerne mellom enkel speiling og dobbelsidig refleksjon når jobbsøkeren står i et «både–og»."
    )
  }
  if (out.length === 0) {
    out.push(
      `Du holder stø kurs i samtalen og gir jobbsøkeren godt med taletid. ${tone.ask} Bruk gjerne en kort speiling etter åpne spørsmål for å vise at du har fanget essensen før du går videre.`
    )
  }
  return out
}

function buildImprovements(a: Analysis, tone: ReturnType<typeof difficultyTone>): string[] {
  const c = a.counts ?? ({} as any)
  const r = a.ratios ?? ({} as any)
  const turns = a.length?.student_turns ?? 0
  const shifts = a.topics?.topic_shifts ?? 0
  const out: string[] = []

  if ((r.complex_reflection_share ?? 0) < 0.3) {
    out.push(
      `Øk andelen komplekse refleksjoner for å løfte mening og følelse. Utvid en enkel speiling til en tolkning eller lag en dobbelsidig refleksjon («på den ene siden … og samtidig …») når ambivalens dukker opp. Start med å gjøre om én av tre enkle speilinger; ${tone.ask}`
    )
  }
  const needSum = (c.summaries ?? 0) < expectedSummaries(turns, shifts)
  if (needSum) {
    out.push(
      "Legg inn flere korte oppsummeringer for å binde sammen nøkkelpunkter og styre fokus når du bytter tema, og mot slutten av økten. Avslutt gjerne oppsummeringen med et åpent kontrollspørsmål som inviterer til korreksjon."
    )
  }
  if ((r.open_question_share ?? 0) < 0.7) {
    out.push(
      "Øk andelen åpne spørsmål ved å omformulere noen ja/nei-spørsmål til «hva» og «hvordan». Still deg selv kontrollspørsmålet «kan dette besvares med mer enn ett ord?» før du spør."
    )
  }
  if ((r.reflection_to_question ?? 0) < 0.8) {
    out.push(
      "Øk antallet refleksjoner per spørsmål for å gi mer rom for fordypning. Prøv en rytme der du speiler kort etter hvert 1.–2. spørsmål før du går videre – det gir bedre flyt og opplevelse av å bli forstått."
    )
  }
  const needAff = (c.affirmations ?? 0) < EXPECTED_PER_TURNS.affirmations(turns)
  if (needAff) {
    out.push(
      "Gi flere konkrete bekreftelser for å styrke mestringstro og samarbeid. Knytt anerkjennelsen til observerbare handlinger."
    )
  }
  if ((c.closed_questions ?? 0) > 6) {
    out.push(
      `Antallet lukkede spørsmål er høyt og kan gi forhørspreg. Test regelen «ett åpent spørsmål → én speiling», og bruk lukkede spørsmål mest til raske avklaringer. ${tone.stretch}`
    )
  }
  if (out.length === 0) {
    out.push(
      "Fortsett å variere mellom åpne spørsmål og speilinger, og legg inn korte oppsummeringer ved skifte. Velg ett mikro-grep som du øver bevisst i neste økt."
    )
  }
  return out
}

function balanceFeedback(str: string[], imp: string[], desired = 4, tol = 0.1) {
  const total = Math.max(2, desired)
  const half = total / 2
  const minS = Math.floor(half * (1 - tol))
  const maxS = Math.ceil(half * (1 + tol))
  let strengths = str.slice()
  let improvements = imp.slice()
  const genericStrength =
    "Rytmen mellom åpne spørsmål, refleksjon og korte oppsummeringer oppleves støttende – hold på dette mønsteret gjennom hele økten."
  const genericImprove =
    "Vær bevisst på rekkefølgen: speil kort → still målrettet, åpent spørsmål → speil igjen. Dette gir driv og struktur."
  while (strengths.length < minS) strengths.push(genericStrength)
  while (improvements.length < minS) improvements.push(genericImprove)
  strengths = strengths.slice(0, Math.max(minS, Math.min(maxS, strengths.length)))
  improvements = improvements.slice(0, Math.max(minS, Math.min(maxS, improvements.length)))
  while (strengths.length + improvements.length < total) {
    if (improvements.length < strengths.length && improvements.length < maxS) {
      improvements.push(genericImprove)
    } else if (strengths.length < maxS) {
      strengths.push(genericStrength)
    } else {
      break
    }
  }
  return { strengths, improvements }
}

export function generateFeedback(a: Analysis, opt: FBOpt = {}) {
  const difficulty: Difficulty | undefined = a.difficulty
  const tone = difficultyTone(difficulty)
  const desiredItems = opt.desiredItems ?? 4
  const tolerance = opt.balanceTolerance ?? 0.1
  const strengths = buildStrengths(a, tone)
  const improvements = buildImprovements(a, tone)
  const { strengths: S, improvements: I } = balanceFeedback(strengths, improvements, desiredItems, tolerance)
  return {
    strengths: S,
    improvements: I,
    next_exercises: [
      "Øv på dobbelsidig refleksjon: skriv om én enkel speiling til en «på den ene siden … og samtidig …»-setning.",
      "Avslutt et tema med en 1–2 setnings oppsummering som fremhever endringssnakk og konkret neste steg."
    ]
  }
}