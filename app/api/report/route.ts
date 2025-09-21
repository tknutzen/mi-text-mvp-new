import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/* ===================== Typer ===================== */
type Counts = {
  open_questions: number
  closed_questions: number
  reflections_simple: number
  reflections_complex: number
  summaries: number
  affirmations: number
}
type Ratios = {
  open_question_share: number
  reflection_to_question: number
  complex_reflection_share: number
}
type ExampleItem = string | { index: number; text: string }
type Examples = {
  open_questions: ExampleItem[]
  closed_questions: ExampleItem[]
  reflections_simple: ExampleItem[]
  reflections_complex: ExampleItem[]
  affirmations: ExampleItem[]
  summaries: ExampleItem[]
}
type AnalyzeLike = {
  tema?: string
  topic?: string
  total_score?: number
  counts: Counts
  ratios?: Ratios
  examples?: Examples
  tellinger?: any
  klassifisering?: any[]
  length?: { student_turns?: number }
  topics?: {
    primary_topic?: string
    other_topics?: string[]
    topic_shifts?: number
    by_turn?: { turnIndex: number; topic: string }[]
  }
  __turns_for_view?: { index: number; speaker: string; text: string }[]
}

/* ===================== Utils ===================== */
function esc(s: unknown) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
const clamp = (n: number, min = 0, max = 100) => Math.max(min, Math.min(max, n))
const norm = (s: string) => (s || "").toLowerCase().trim()

function totalOARSEvents(c: Counts) {
  return (
    (c?.open_questions || 0) +
    (c?.closed_questions || 0) +
    (c?.reflections_simple || 0) +
    (c?.reflections_complex || 0) +
    (c?.summaries || 0) +
    (c?.affirmations || 0)
  )
}
function hasSufficientData(analysis: AnalyzeLike) {
  const t = analysis.length?.student_turns
  const total = totalOARSEvents(analysis.counts)
  return t !== undefined ? total >= 5 && t >= 5 : total >= 5
}
function getOrigin(req: NextRequest) {
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host =
    req.headers.get("x-forwarded-host") ??
    req.headers.get("host") ??
    "localhost:3000";
  return `${proto}://${host}`;
}

/* ===================== Finn i body (robust) ===================== */
type InTurn = { speaker?: string; rolle?: string; role?: string; text?: string; tekst?: string; content?: string }

function normSpeaker(x: string | undefined): "jobbkonsulent" | "jobbsøker" {
  const v = (x || "").toLowerCase()
  if (v.includes("konsulent") || v === "assistant") return "jobbkonsulent"
  if (v.includes("søker") || v.includes("soker") || v === "user") return "jobbsøker"
  return "jobbsøker"
}
function mapToAnalyzeTurns(raw: InTurn[]): { speaker: "jobbkonsulent" | "jobbsøker"; text: string }[] {
  return (raw || [])
    .map(t => {
      const speakerLike = t.speaker ?? t.rolle ?? t.role
      const textLike = t.text ?? t.tekst ?? t.content
      return { speaker: normSpeaker(typeof speakerLike === "string" ? speakerLike : ""), text: String(textLike ?? "").trim() }
    })
    .filter(t => t.text.length > 0)
}

function isCounts(o: any): o is Counts {
  return !!o && typeof o === "object" &&
    ["open_questions","closed_questions","reflections_simple","reflections_complex","summaries","affirmations"]
      .every(k => typeof o[k] === "number")
}
function isKlassRow(r: any) {
  return r && typeof r === "object" && typeof r.index === "number" && r.labels && typeof r.labels === "object"
}
function findFirst<T = any>(obj: any, predicate: (x: any)=>boolean, maxDepth = 6): T | null {
  try {
    const seen = new Set<any>()
    const stack: any[] = [obj]
    let depth = 0
    while (stack.length && depth <= maxDepth) {
      const cur = stack.pop()
      if (!cur || typeof cur !== "object" || seen.has(cur)) continue
      seen.add(cur)
      if (predicate(cur)) return cur as T
      for (const k in cur) {
        const v = cur[k]
        if (v && typeof v === "object") stack.push(v)
      }
      depth++
    }
  } catch {}
  return null
}
function findCountsAnywhere(body: any): Counts | null {
  if (!body) return null
  if (isCounts(body.counts)) return body.counts
  const nested = findFirst(body, isCounts)
  return nested
}
function findTurnsAnywhere(body: any): InTurn[] | null {
  const pick = (arr: any): InTurn[] | null => Array.isArray(arr) ? arr : null
  if (!body) return null
  if (Array.isArray(body.turns)) return body.turns
  const alt = ["transcript","dialog","conversation","messages","utterances","data","payload","analysis"]
  for (const key of alt) {
    const val = body[key]
    if (Array.isArray(val)) return val
    if (val && typeof val === "object") {
      if (Array.isArray(val.turns)) return val.turns
      for (const k in val) {
        if (Array.isArray(val[k]) && val[k].length && (val[k][0]?.text || val[k][0]?.content)) return pick(val[k])
      }
    }
  }
  const nested = findFirst<any[]>(body, (x)=> Array.isArray(x) && x.length && (isKlassRow(x[0]) || x[0]?.text || x[0]?.content), 6)
  return nested || null
}

/* ===================== Fallback: derive counts/examples ===================== */
function countsFromKlassifisering(klass: any[]): Counts {
  const c: Counts = { open_questions:0, closed_questions:0, reflections_simple:0, reflections_complex:0, summaries:0, affirmations:0 }
  for (const r of (klass||[])) {
    const L = r?.labels || {}
    if (L.open_question) c.open_questions++
    if (L.closed_question) c.closed_questions++
    if (L.affirmation) c.affirmations++
    if (L.summary) c.summaries++
    if (!L.summary) {
      if (L.reflection_simple) c.reflections_simple++
      if (L.reflection_complex) c.reflections_complex++
    }
  }
  return c
}

/* Eksempler (tekst, ikke-klikkbare) fra klassifisering + turns */
function examplesFromKlassAndTurns(
  klass: any[],
  turns: { index?: number; speaker: "jobbkonsulent" | "jobbsøker"; text: string }[]
): Examples {
  const byIndex: Record<number, string> = {}
  const consultantSeqTexts: string[] = []

  turns.forEach((t, i) => {
    if (t.speaker !== "jobbkonsulent") return
    const key = typeof t.index === "number" ? t.index : i
    const txt = t.text || ""
    byIndex[key] = txt
    consultantSeqTexts.push(txt)
  })

  const seqByIndex: Record<number, number> = {}
  let seq = 0
  for (const r of klass || []) {
    const idx = r?.index
    if (typeof idx === "number" && seqByIndex[idx] === undefined) {
      seqByIndex[idx] = seq++
    }
  }

  function textFor(idx: number): string {
    const direct = byIndex[idx]
    if (direct) return direct
    const s = seqByIndex[idx]
    if (typeof s === "number" && consultantSeqTexts[s]) return consultantSeqTexts[s]
    return ""
  }

  const ex: Examples = {
    open_questions: [], closed_questions: [],
    reflections_simple: [], reflections_complex: [],
    affirmations: [], summaries: []
  }

  for (const r of klass || []) {
    const idx = r?.index
    if (typeof idx !== "number") continue
    const L = r?.labels || {}
    const txt = textFor(idx)
    if (!txt) continue

    const item = { index: idx, text: txt }
    if (L.open_question) ex.open_questions.push(item)
    if (L.closed_question) ex.closed_questions.push(item)
    if (L.reflection_simple && !L.summary) ex.reflections_simple.push(item)
    if (L.reflection_complex && !L.summary) ex.reflections_complex.push(item)
    if (L.affirmation) ex.affirmations.push(item)
    if (L.summary) ex.summaries.push(item)
  }

  return ex
}

/* ===================== Tema-gruppering ===================== */
const BANNED = new Set([
  "annet","other","diverse","ukjent","-","avslutning","slutt",
  "closing","oppsummering","intro","oppstart","start","smalltalk",
  "hilsen","hilsing","prat","samtale"
])
const RELATED: Record<string, string[]> = {
  "jobbambivalens": ["jobb","arbeid","lønn","stilling","deltid","heltid","praksis","opptrapping","trygd","ytelser","nav","aap","dagpenger","pensjon","tilrettelegging","arbeidsevne","kapasitet","helse","utbrenthet","stress"],
  "manglende oppmøte": ["oppmøte","møter","for sent","fravær","avtaler","telefon","varsling","rutiner","årsaker","hindringer","transport","søvn","motivasjon"],
  "redusere rusbruk": ["rus","alkohol","cannabis","hasj","piller","substanser","kontroll","abstinens","bakrus","triggere","mengde","hyppighet"],
  "aggressiv atferd": ["konflikt","krangel","sinte reaksjoner","utbrudd","grenser","trigger","regler","kollega","kunde","tillit","advarsel","oppsigelse"]
}
function groupForReport(
  selectedMain: string,
  otherTopics: string[] = [],
  byTurn: { turnIndex: number; topic: string }[] = []
) {
  const main = norm(selectedMain)
  const related = new Set((RELATED[main] || []).map(norm))
  const othersSet = new Set<string>()
  for (const t of otherTopics) {
    const tn = norm(t)
    if (!tn || BANNED.has(tn)) continue
    if (tn === main || related.has(tn)) continue
    othersSet.add(tn)
  }
  let shifts = 0
  let prev = ""
  for (const row of byTurn || []) {
    const tn = norm(row.topic)
    if (!tn || BANNED.has(tn)) continue
    const grouped = tn === main || related.has(tn) ? main : tn
    if (prev && grouped !== prev) shifts++
    prev = grouped
  }
  return {
    mainLabel: selectedMain || "—",
    others: Array.from(othersSet),
    shifts
  }
}
function scoreBandText(score: number) {
  if (score >= 80) return "Meget god OARS-bruk."
  if (score >= 60) return "God OARS-bruk – noen forbedringspunkter."
  if (score >= 40) return "På vei – styrk refleksjoner/bekreftelser/korte oppsummeringer."
  return "Trenger mer systematikk i OARS."
}

/* ===================== Skala/visual ===================== */
function scoreScaleHTML(score: number, bandText: string) {
  const sDisplay = clamp(Math.round(score))
  const pos = Math.round(score)

  const majors = [0, 20, 40, 60, 80, 100]
  const minors = [10, 30, 50, 70, 90]
  const majorLabels: Record<number, string> = {
    0:"Ingen OARS",20:"Lite OARS",40:"Moderat OARS",60:"God OARS",80:"Meget god OARS",100:"Fullkommen OARS"
  }

  const majorTicks = majors
    .map(
      (p) => `
    <div class="tick major" style="left:${p}%;" aria-hidden="true"></div>
    <div class="tick-label" style="left:${p}%;">${esc(majorLabels[p] || String(p))}</div>
  `
    )
    .join("");

  const minorTicks = minors
    .map(
      (p) => `
    <div class="tick minor" style="left:${p}%;" aria-hidden="true"></div>
  `
    )
    .join("");

  return `
  <div class="scale">
    <div class="scale-inner">
      <div class="bar-wrap">
        <div class="bar">
          <div class="seg red"></div>
          <div class="seg yellow"></div>
          <div class="seg green"></div>
          ${minorTicks}
          ${majorTicks}
        </div>

        <div class="score-marker" style="left:${pos}%;" aria-label="Score ${sDisplay}/100">
          <div class="score-tris">
            <span class="tri tri-up"></span>
            <div class="score-chip"><div class="score-chip-text">${sDisplay}/100</div></div>
            <span class="tri tri-down"></span>
          </div>
        </div>
      </div>

      <div class="bandtext">${esc(bandText)}</div>
    </div>
  </div>`
}

/* ===================== HTML ===================== */
function renderHTML(analysis: AnalyzeLike) {
  const counts = analysis.counts
  const ratios = analysis.ratios || { open_question_share: 0, reflection_to_question: 0, complex_reflection_share: 0 }
  const exIncoming = analysis.examples || { open_questions:[], closed_questions:[], reflections_simple:[], reflections_complex:[], affirmations:[], summaries:[] }
  const turnsForView = analysis.__turns_for_view || []
  const klass = analysis.klassifisering || []

  // Hjelper for "Vis eksempler"-knapp (ren streng, ikke JSX)
  const exBtn = (targetId: string, count?: number) =>
    count && count > 0
      ? `<button class="linkbtn" data-target="${targetId}">Vis eksempler (${count})</button>`
      : ""

  function buildAnchoredExamples(): Examples {
    if (klass?.length && turnsForView?.length) {
      return examplesFromKlassAndTurns(
        klass as any[],
        turnsForView.map(t => ({ index: t.index, speaker: t.speaker as any, text: t.text }))
      )
    }
    if (klass?.length) {
      const pick = (flag: (L:any)=>boolean, incoming: ExampleItem[]) => {
        const out: ExampleItem[] = []
        let i = 0
        for (const r of klass as any[]) {
          const L = r?.labels || {}
          if (flag(L)) {
            const txt = typeof incoming[i] === "string" ? String(incoming[i]) : (incoming[i] as any)?.text || ""
            out.push({ index: r.index, text: txt })
            i++
          }
        }
        return out
      }
      return {
        open_questions: pick((L)=>L.open_question, exIncoming.open_questions||[]),
        closed_questions: pick((L)=>L.closed_question, exIncoming.closed_questions||[]),
        reflections_simple: pick((L)=>L.reflection_simple && !L.summary, exIncoming.reflections_simple||[]),
        reflections_complex: pick((L)=>L.reflection_complex && !L.summary, exIncoming.reflections_complex||[]),
        affirmations: pick((L)=>L.affirmation, exIncoming.affirmations||[]),
        summaries: pick((L)=>L.summary, exIncoming.summaries||[])
      }
    }
    return exIncoming
  }
  const ex = buildAnchoredExamples()

  const sufficient = hasSufficientData(analysis)
  const totalEvents = totalOARSEvents(counts)
  function makeFeedback() {
    const strengths: string[] = []
    const improvements: string[] = []

    if (counts.open_questions > counts.closed_questions)
      strengths.push("Større andel åpne enn lukkede spørsmål.")
    if (counts.affirmations > 0)
      strengths.push("Du brukte bekreftelser for å anerkjenne innsats/verdier.")
    if ((counts.reflections_simple + counts.reflections_complex) >= Math.max(2, Math.floor(totalEvents * 0.25)))
      strengths.push("Du brukte refleksjoner for å speile og utforske.")
    if (counts.summaries > 0)
      strengths.push("Du brukte oppsummeringer for å samle trådene.")

    if (counts.closed_questions > counts.open_questions)
      improvements.push("Bruk flere åpne spørsmål og færre lukkede.")
    if (counts.reflections_complex === 0 && counts.reflections_simple > 0)
      improvements.push("Legg inn noen komplekse refleksjoner som løfter mening/følelse/tosidighet.")
    if (counts.summaries === 0)
      improvements.push("Avslutt enkelte deler med korte oppsummeringer for å samle trådene.")

    if (!improvements.length) improvements.push("Fortsett å variere refleksjoner og kvalitetssikre presise oppsummeringer mot slutten av hvert tema.")
    if (!strengths.length) strengths.push("God bruk av OARS-elementer gjennom samtalen.")
    return { strengths, improvements }
  }

  const incomingFeedback = (analysis as any)?.feedback
  const useFeedback = (sufficient && (!incomingFeedback || !incomingFeedback.strengths?.length || !incomingFeedback.improvements?.length))
    ? makeFeedback()
    : incomingFeedback

  const topicsSafe = analysis.topics ?? {
    primary_topic: analysis.topic || analysis.tema || "",
    other_topics: [] as string[],
    topic_shifts: 0,
    by_turn: [] as { turnIndex: number; topic: string }[]
  }
  const grouped = groupForReport(
    String(topicsSafe.primary_topic || analysis.topic || analysis.tema || ""),
    topicsSafe.other_topics || [],
    topicsSafe.by_turn || []
  )
  const total_score = clamp(Math.round(analysis.total_score ?? 0))
  const bandText = scoreBandText(total_score)

  // Kun tekst – ikke lenker
  const exItem = (it: any) => {
    const txt =
      typeof it === "string"
        ? it
        : typeof it?.text === "string"
        ? it.text
        : String(it ?? "");
    return `<li>${esc(txt)}</li>`;
  };

  return `<!doctype html>
<html lang="no">
<head>
  <meta charset="utf-8" />
  <title>Rapport fra MI-øvelse</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root{
      --text:#111827; --muted:#6b7280; --line:#e5e7eb; --brand:#1f2937; --bg:#ffffff;
      --good:#065f46; --bad:#7f1d1d;
      --red:#ef4444; --yellow:#f59e0b; --green:#10b981;
      --buttonH: 44px;
    }
    body{ margin:0; font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; background:var(--bg); color:var(--text); }
    .wrap{ max-width:900px; margin:32px auto; padding:0 16px; }
    h1{ margin:0 0 8px 0; }
    .muted{ color:var(--muted); }
    .card{ background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px; margin-top:12px; }
    table{ width:100%; border-collapse:collapse; }
    th,td{ padding:8px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    .small{ font-size:14px; color:var(--muted); }
    .section-title{ margin:0 0 6px 0; font-size:18px; }
    .good{ color:var(--good); } .bad{ color:var(--bad); }
    .threecol th:nth-child(1), .threecol td:nth-child(1){ width: 40%; }
    .threecol th:nth-child(2), .threecol td:nth-child(2){ width: 20%; white-space: nowrap; }
    .threecol th:nth-child(3), .threecol td:nth-child(3){ width: 40%; color: var(--muted); }

    .scale { margin-top: 25px; }
    .scale-inner{ max-width: 860px; margin: 0 auto; padding: 0 6px; }
    .bar-wrap{ position: relative; margin: 0 auto; }
    .bar{
      position: relative; height: var(--buttonH);
      border-radius: 12px; overflow: hidden;
      background: transparent; box-shadow: inset 0 0 0 1px #11182712;
    }
    .seg{ position:absolute; top:0; height:100%; }
    .seg.red{ left:0; width:50%; background: var(--red); }
    .seg.yellow{ left:50%; width:30%; background: var(--yellow); }
    .seg.green{ left:80%; width:20%; background: var(--green); }

    .tick{ position:absolute; top:0; width:2px; height:100%; transform: translateX(-1px); background: #11182720; pointer-events: none; }
    .tick.minor { opacity: 0.45; }
    .tick.major { opacity: 0.8; }
    .tick-label{ position:absolute; top: calc(100% + 6px); transform: translateX(-50%); font-size: 11px; font-weight: 700; color: #111827; white-space: nowrap; pointer-events: none; }

    .score-marker{
      position:absolute; top:0; bottom:0;
      transform: translateX(-50%);
      display:flex; align-items:center; justify-content:center;
      pointer-events:none;
    }

    .score-chip{
      background:#111827; color:#fff;
      border-radius:10px;
      padding:6px 10px;
      font-weight:800; font-size:13px; line-height:1.2;
      white-space:nowrap;
      box-shadow: 0 2px 6px rgba(17,24,39,.15);
    }
    .score-chip-text{ position:relative; z-index:2; }

    .score-tris{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; }
    .tri{ width:0; height:0; border-left:8px solid transparent; border-right:8px solid transparent; }
    .tri-up{   border-bottom:10px solid #111827; }
    .tri-down{ border-top:10px solid #111827; }

    .bandtext{ margin-top: 14px; font-size: 14px; color: var(--muted); }

    .linkbtn{ background:none; border:none; color:#2563eb; cursor:pointer; padding:0; font-size:14px; text-decoration:underline; }
    .examples{ display:none; margin-top:8px; }
    .examples ul{ margin:6px 0 0 18px; padding:0; }
    .examples li{ margin-bottom:4px; }
    ul{ margin:8px 0 0 18px; padding:0; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Rapport fra MI-øvelse</h1>

    <div class="card">
      <div class="section-title">Totalscore</div>
      ${scoreScaleHTML(clamp(Math.round(analysis.total_score ?? 0)), scoreBandText(clamp(Math.round(analysis.total_score ?? 0))))}
    </div>

    <div class="card">
      <div class="section-title">OARS – telling</div>
      <table class="threecol">
        <tr><th>Type</th><th>Verdi</th><th>Forklaring/eksempler</th></tr>

        <tr>
          <td>Åpne spørsmål</td>
          <td>${esc(counts.open_questions)}</td>
          <td>
            Spørsmål som inviterer til utforsking.
            ${exBtn("ex-open", ex.open_questions?.length)}
            <div id="ex-open" class="examples">
              <ul>${(ex.open_questions||[]).map(exItem).join("")}</ul>
            </div>
          </td>
        </tr>

        <tr>
          <td>Lukkede spørsmål</td>
          <td>${esc(counts.closed_questions)}</td>
          <td>
            Ja/nei- eller korte faktaspørsmål.
            ${exBtn("ex-closed", ex.closed_questions?.length)}
            <div id="ex-closed" class="examples">
              <ul>${(ex.closed_questions||[]).map(exItem).join("")}</ul>
            </div>
          </td>
        </tr>

        <tr>
          <td>Refleksjoner (enkle)</td>
          <td>${esc(counts.reflections_simple)}</td>
          <td>
            Gjenspeiler innhold i korte ordelag.
            ${exBtn("ex-rs", ex.reflections_simple?.length)}
            <div id="ex-rs" class="examples">
              <ul>${(ex.reflections_simple||[]).map(exItem).join("")}</ul>
            </div>
          </td>
        </tr>

        <tr>
          <td>Refleksjoner (komplekse)</td>
          <td>${esc(counts.reflections_complex)}</td>
          <td>
            Utvider/fortolker – går litt dypere.
            ${exBtn("ex-rc", ex.reflections_complex?.length)}
            <div id="ex-rc" class="examples">
              <ul>${(ex.reflections_complex||[]).map(exItem).join("")}</ul>
            </div>
          </td>
        </tr>

        <tr>
          <td>Bekreftelser</td>
          <td>${esc(counts.affirmations)}</td>
          <td>
            Styrke-/innsatsfokuserte utsagn.
            ${exBtn("ex-aff", ex.affirmations?.length)}
            <div id="ex-aff" class="examples">
              <ul>${(ex.affirmations||[]).map(exItem).join("")}</ul>
            </div>
          </td>
        </tr>

        <tr>
          <td>Oppsummeringer</td>
          <td>${esc(counts.summaries)}</td>
          <td>
            Bør brukes ved skifte/slutt. Refleksjon helt mot slutten tolkes som oppsummering.
            ${exBtn("ex-sum", ex.summaries?.length)}
            <div id="ex-sum" class="examples">
              <ul>${(ex.summaries||[]).map(exItem).join("")}</ul>
            </div>
          </td>
        </tr>
      </table>
    </div>

    <div class="card">
      <div class="section-title">Forholdstall</div>
      <table class="threecol">
        <tr><th>Type</th><th>Verdi</th><th>Forklaring/kommentar</th></tr>
        <tr><td>Andel åpne spørsmål</td><td>${esc(Math.round((ratios.open_question_share ?? 0) * 100))}%</td><td>Hvor stor andel av spørsmålene som er åpne.</td></tr>
        <tr><td>Refleksjoner per spørsmål</td><td>${esc((ratios.reflection_to_question ?? 0).toFixed(2))}</td><td>Hvor ofte du reflekterer relativt til hvor ofte du spør. Sikt mot ca. 0,8 eller høyere.</td></tr>
        <tr><td>Andel komplekse refleksjoner</td><td>${esc(Math.round((ratios.complex_reflection_share ?? 0) * 100))}%</td><td>Hvor stor andel av refleksjonene som er komplekse.</td></tr>
      </table>
    </div>

    <div class="card">
      <div class="section-title">Tilbakemelding</div>
      ${
        sufficient
          ? `
            <div style="display:grid; gap:12px; grid-template-columns: repeat(auto-fit, minmax(280px,1fr));">
              <div>
                <strong>Dette fungerte godt</strong>
                ${
                  (useFeedback?.strengths?.length)
                    ? `<ul>${(useFeedback.strengths as string[]).map(s=>`<li class="good">${esc(s)}</li>`).join("")}</ul>`
                    : `<div class="small muted">Ingen spesifikke styrker identifisert i denne økten.</div>`
                }
              </div>
              <div>
                <strong>Dette kan forbedres</strong>
                ${
                  (useFeedback?.improvements?.length)
                    ? `<ul>${(useFeedback.improvements as string[]).map(s=>`<li class="bad">${esc(s)}</li>`).join("")}</ul>`
                    : `<div class="small muted">Ingen konkrete forbedringspunkter identifisert i denne økten.</div>`
                }
              </div>
            </div>`
          : `<div class="small muted">Datagrunnlaget er for lite til å gi målrettet tilbakemelding. Gjennomfør gjerne en lengre økt eller bruk flere OARS-tilnærminger for å få mer treffsikker rapport.</div>`
      }
    </div>

    <div class="small muted" style="margin-top:12px">
      Rapporten er veiledende og bør tolkes med faglig skjønn.
    </div>
  </div>

  <script>
    // Toggle for OARS-eksempler + dynamisk knappetekst
    document.querySelectorAll('.linkbtn').forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = btn.getAttribute('data-target');
        var el = id ? document.getElementById(id) : null;
        if (!el) return;
        var open = el.style.display === 'block';
        el.style.display = open ? 'none' : 'block';
        if (!open) {
          btn.textContent = 'Skjul eksempler';
        } else {
          var count = (el.querySelectorAll('li').length) || '';
          btn.textContent = 'Vis eksempler' + (count ? ' ('+count+')' : '');
        }
      });
    });
  </script>
</body>
</html>`
}

/* ===================== ensureAnalysis (robust, sender turns for visning) ===================== */
async function ensureAnalysis(body: any, req: NextRequest): Promise<AnalyzeLike> {
  // 1) Allerede counts i payload?
  const counts = findCountsAnywhere(body)
  if (counts) {
    const turns = findTurnsAnywhere(body)
    return {
      tema: body.tema || body.topic || body.analysis?.tema || "",
      total_score: body.total_score ?? body.analysis?.total_score,
      counts,
      ratios: body.ratios ?? body.analysis?.ratios,
      examples: body.examples ?? body.analysis?.examples,
      tellinger: body.tellinger ?? body.analysis?.tellinger,
      klassifisering: body.klassifisering ?? body.analysis?.klassifisering,
      length: body.length ?? body.analysis?.length,
      topics: body.topics ?? body.analysis?.topics,
      __turns_for_view: turns ? mapToAnalyzeTurns(turns).map((t,i)=>({ index:i, speaker:t.speaker, text:t.text })) : undefined
    }
  }

  // 2) Klassifisering → counts; med turns → examples + turns for view
  const klass = Array.isArray(body?.klassifisering) ? body.klassifisering :
                Array.isArray(body?.analysis?.klassifisering) ? body.analysis.klassifisering : null
  const rawTurns = findTurnsAnywhere(body)
  if (klass && Array.isArray(klass)) {
    const c = countsFromKlassifisering(klass)
    let examples: Examples | undefined = undefined
    let turnsForView: { index: number; speaker: string; text: string }[] | undefined = undefined
    if (rawTurns && rawTurns.length) {
      const turns = mapToAnalyzeTurns(rawTurns)
      examples = examplesFromKlassAndTurns(klass, turns)
      turnsForView = turns.map((t,i)=>({ index:i, speaker:t.speaker, text:t.text }))
    } else {
      const incoming = (body.examples ?? body.analysis?.examples) as Examples | undefined
      if (incoming) {
        const pick = (flag: (L:any)=>boolean, arr: ExampleItem[] = [])=>{
          const out: ExampleItem[] = []
          let i = 0
          for (const r of klass) {
            const L = r?.labels || {}
            if (flag(L)) {
              const txt = typeof arr[i] === "string" ? String(arr[i]) : (arr[i] as any)?.text || ""
              out.push({ index: r.index, text: txt })
              i++
            }
          }
          return out
        }
        examples = {
          open_questions: pick((L)=>L.open_question, incoming.open_questions),
          closed_questions: pick((L)=>L.closed_question, incoming.closed_questions),
          reflections_simple: pick((L)=>L.reflection_simple && !L.summary, incoming.reflections_simple),
          reflections_complex: pick((L)=>L.reflection_complex && !L.summary, incoming.reflections_complex),
          affirmations: pick((L)=>L.affirmation, incoming.affirmations),
          summaries: pick((L)=>L.summary, incoming.summaries)
        }
      }
    }
    return {
      tema: body.tema || body.topic || body.analysis?.tema || "",
      total_score: body.total_score ?? body.analysis?.total_score,
      counts: c,
      ratios: body.ratios ?? body.analysis?.ratios,
      examples,
      tellinger: body.tellinger ?? body.analysis?.tellinger,
      klassifisering: klass,
      length: body.length ?? body.analysis?.length,
      topics: body.topics ?? body.analysis?.topics,
      __turns_for_view: turnsForView
    }
  }

  // 3) Har vi turns? → kall /api/analyze
  if (rawTurns && rawTurns.length) {
    const origin = getOrigin(req)
    const turns = mapToAnalyzeTurns(rawTurns)
    const res = await fetch(`${origin}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ turns, topic: body.topic || body.tema || "" })
    })
    if (!res.ok) {
      const err = await res.text().catch(() => "")
      throw new Error(`Analyze-feil ${res.status}: ${err}`)
    }
    const j = await res.json()
    return {
      tema: j.tema || j.topic || "",
      total_score: j.total_score,
      counts: j.counts,
      ratios: j.ratios,
      examples: j.examples,
      tellinger: j.tellinger,
      klassifisering: j.klassifisering,
      length: j.length,
      topics: j.topics,
      __turns_for_view: turns.map((t,i)=>({ index:i, speaker:t.speaker, text:t.text }))
    }
  }

  // 4) Mangler data
  throw new Error(
    "Mangler brukbare data. Send enten hele resultatet fra /api/analyze (inkl. counts/ratios/examples),"+
    " eller rå inndata som { topic?, turns:[{ speaker, text }] }."
  )
}

/* ===================== Route ===================== */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const analysis = await ensureAnalysis(body, req)
    const html = renderHTML(analysis)
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Report-Version": "v11-anchors-final"
      }
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || "Ukjent feil" }), { status: 400 })
  }
}