// app/api/report/route.ts
import { NextRequest } from "next/server"
import { scoreFromAnalysis, type Analysis } from "@/lib/report"

export const runtime = "nodejs"

const clamp100 = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
const esc = (s: string) =>
  (s ?? "").toString().replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))

function scoreBand(score: number) {
  if (score >= 85) return { label: "Svært høy MI-kvalitet", color: "#14532d", bg: "#dcfce7" }
  if (score >= 70) return { label: "Høy MI-kvalitet", color: "#166534", bg: "#ecfdf5" }
  if (score >= 55) return { label: "God MI, utviklingspotensial", color: "#1d4ed8", bg: "#eff6ff" }
  if (score >= 40) return { label: "Ustabil MI – juster teknikk", color: "#a16207", bg: "#fef3c7" }
  return { label: "Lav MI-kvalitet – fokuser grunnferdigheter", color: "#991b1b", bg: "#fee2e2" }
}

function scoreScaleHTML(score: number, bandText: string) {
  const s = clamp100(score)
  const segs = Array.from({ length: 10 }, (_, i) => {
    const left = i * 10
    const w = 10
    const color =
      i < 4 ? "#fee2e2" :
      i < 5 ? "#fef3c7" :
      i < 7 ? "#eff6ff" :
      i < 8 ? "#ecfdf5" :
              "#dcfce7"
    return `<div class="seg" style="left:${left}%;width:${w}%;background:${color}"></div>`
  }).join("")
  const minor = Array.from({ length: 100 }, (_, i) => `<div class="tick m" style="left:${i + 1}%"></div>`).join("")
  const major = Array.from({ length: 11 }, (_, i) => `<div class="tick M" style="left:${i * 10}%"></div>`).join("")

  return `
  <div class="scale">
    <div class="bar">
      ${segs}
      ${minor}
      ${major}
      <div class="score-marker" style="left:${s}%;">
        <div class="score-chip">
          <div class="score-chip-text">${s}/100</div>
          <div class="score-chip-arrow"></div>
        </div>
        <div class="score-pin"></div>
      </div>
    </div>
    <div class="bandtext">${esc(bandText)}</div>
  </div>`
}

function legendHTML() {
  return `
  <div class="legend">
    <div class="leg"><span class="sw" style="background:#fee2e2"></span>Lav</div>
    <div class="leg"><span class="sw" style="background:#fef3c7"></span>Under mål</div>
    <div class="leg"><span class="sw" style="background:#eff6ff"></span>OK</div>
    <div class="leg"><span class="sw" style="background:#ecfdf5"></span>God</div>
    <div class="leg"><span class="sw" style="background:#dcfce7"></span>Svært god</div>
  </div>`
}

type RowSpec = {
  key: keyof NonNullable<Analysis["counts"]>
  label: string
  share?: string | null
  shareLabel?: string
  exampleKey?: keyof NonNullable<any>
}

function buildOARSRows(a: Analysis): RowSpec[] {
  const c = a.counts || {}
  const r = a.ratios || {}
  return [
    { key: "open_questions",     label: "Åpne spørsmål",         share: r.open_question_share != null ? `${Math.round((r.open_question_share || 0) * 100)} %` : null, exampleKey: "open_questions" },
    { key: "closed_questions",   label: "Lukkede spørsmål",       share: null, exampleKey: "closed_questions" },
    { key: "reflections_simple", label: "Enkle refleksjoner",     share: null, exampleKey: "reflections_simple" },
    { key: "reflections_complex",label: "Komplekse refleksjoner", share: r.complex_reflection_share != null ? `${Math.round((r.complex_reflection_share || 0) * 100)} %` : null, exampleKey: "reflections_complex" },
    // Vi viser samlet refleksjonsrate (refleksjoner pr. spørsmål) som egen linje (uten eksempler)
    // NB: Ikke i counts, så vi lager en pseudo-rad under tabellen for tydelighet.
    { key: "affirmations",       label: "Bekreftelser",           share: null, exampleKey: "affirmations" },
    { key: "summaries",          label: "Oppsummeringer",         share: null, exampleKey: "summaries" },
  ]
}

function examplesPopover(id: string, items: string[]) {
  if (!items?.length) return ""
  const lis = items.map(s => `<li>${esc(s)}</li>`).join("")
  return `
  <div class="ex-pop" id="${id}" role="dialog" aria-hidden="true">
    <div class="ex-pop-inner">
      <div class="ex-pop-head">
        <div>Eksempler</div>
        <button class="ex-close" data-ex-close="${id}" aria-label="Lukk">&times;</button>
      </div>
      <ul class="ex-list">${lis}</ul>
    </div>
  </div>`
}

function oarsTableHTML(a: Analysis) {
  const c = a.counts || {}
  const r = a.ratios || {}
  const rows = buildOARSRows(a)
  const ex = (a as any)?.examples || {} // forventer evt. nøkler: open_questions, closed_questions, reflections_simple, reflections_complex, affirmations, summaries

  const trs = rows.map((row, idx) => {
    const val = (c as any)[row.key] ?? 0
    const shareCell = row.share != null ? `<td class="share">${esc(row.share)}</td>` : `<td class="share">–</td>`
    const key = row.exampleKey as string | undefined
    const list = key ? (Array.isArray(ex[key]) ? (ex[key] as string[]) : []) : []
    const exId = `ex_${row.key}_${idx}`
    const btn = list.length ? `<button class="ex-btn" data-ex="${exId}">Vis eksempler (${list.length})</button>` : `<span class="ex-off">Ingen eksempler</span>`
    const pop = list.length ? examplesPopover(exId, list) : ""
    return `
      <tr>
        <td class="lbl">${esc(row.label)}</td>
        <td class="val">${esc(String(val))}</td>
        ${shareCell}
        <td class="excell">${btn}${pop}</td>
      </tr>`
  }).join("")

  const reflPerQ = (r.reflection_to_question ?? null)
  const reflPerQRow = `
    <tr class="sub">
      <td class="lbl">Refleksjoner pr. spørsmål</td>
      <td class="val">${esc(String((c.reflections_simple ?? 0) + (c.reflections_complex ?? 0)))}</td>
      <td class="share">${reflPerQ != null ? esc((reflPerQ || 0).toFixed(2)) : "–"}</td>
      <td class="excell"><span class="ex-off">—</span></td>
    </tr>`

  return `
  <div class="card">
    <div class="section-title">OARS-tellinger</div>
    <table class="oars">
      <thead>
        <tr><th>Tiltak</th><th>Antall</th><th>Andel/Forhold</th><th style="width:165px"></th></tr>
      </thead>
      <tbody>
        ${trs}
        ${reflPerQRow}
      </tbody>
    </table>
  </div>`
}

function baseCSS() {
  return `
  :root{--bg:#f6f8fb;--card:#fff;--line:#e5e7eb;--muted:#6b7280;--title:#111827}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:var(--bg);color:#111827;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;line-height:1.45}
  .wrap{max-width:1000px;margin:24px auto;padding:0 16px}
  .header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
  .ttl{margin:0;font-size:26px;font-weight:800;color:var(--title)}
  .badge{display:inline-flex;align-items:center;gap:8px;background:#eef2ff;border:1px solid #e5e7eb;border-radius:999px;padding:6px 10px;font-weight:600;font-size:12px;color:#3730a3}

  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0;box-shadow:0 1px 2px rgba(0,0,0,.03)}
  .section-title{font-weight:800;margin-bottom:8px}

  .scale{padding:12px 4px}
  .bar{position:relative;height:38px;border-radius:10px;border:1px solid var(--line);background:#fff;overflow:hidden}
  .seg{position:absolute;top:0;bottom:0}
  .tick.m{position:absolute;top:0;bottom:0;width:1px;background:rgba(0,0,0,.06)}
  .tick.M{position:absolute;top:0;bottom:0;width:2px;background:rgba(0,0,0,.18)}
  .bandtext{margin-top:8px;font-size:13px;color:var(--muted)}
  .legend{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;margin-top:8px}
  .leg{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;border:1px solid var(--line);background:#fff}
  .sw{width:10px;height:10px;border-radius:2px}

  .score-marker{position:absolute;top:0;height:100%;transform:translateX(-50%);text-align:center;pointer-events:none}
  .score-pin{position:absolute;top:0;bottom:0;left:50%;width:2px;background:#111827;opacity:.6;transform:translateX(-1px)}
  .score-chip{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);background:#111827;color:#fff;border-radius:8px;padding:6px 10px;font-weight:800;font-size:12px;white-space:nowrap;box-shadow:0 4px 10px rgba(17,24,39,.15)}
  .score-chip-arrow{position:absolute;left:50%;bottom:-6px;transform:translateX(-50%);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:6px solid #111827}

  table.oars{width:100%;border-collapse:collapse;margin-top:8px}
  table.oars th{font-size:12px;text-transform:uppercase;letter-spacing:.02em;color:#6b7280;border-bottom:1px solid var(--line);padding:8px;text-align:left}
  table.oars td{padding:10px 8px;border-bottom:1px solid #f3f4f6;vertical-align:top}
  table.oars td.lbl{font-weight:700}
  table.oars tr.sub td{color:#374151;background:#fafafa}

  .ex-btn{appearance:none;border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 8px;font-size:12px;cursor:pointer}
  .ex-btn:hover{background:#f9fafb}
  .ex-off{font-size:12px;color:#9ca3af}

  .ex-pop{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.08);z-index:30}
  .ex-pop[aria-hidden="false"]{display:flex}
  .ex-pop-inner{background:#fff;border:1px solid var(--line);border-radius:12px;max-width:680px;width:calc(100% - 40px);max-height:70vh;overflow:auto;box-shadow:0 10px 24px rgba(0,0,0,.15)}
  .ex-pop-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line);font-weight:800}
  .ex-close{appearance:none;border:none;background:transparent;font-size:20px;cursor:pointer;line-height:1;padding:4px 8px}
  .ex-list{margin:0;padding:12px 18px}
  .ex-list li{margin:8px 0 8px 16px}
  `
}

function scoreCardHTML(score: number) {
  const band = scoreBand(score)
  return `
  <div class="card" style="border-color:${band.color}">
    <div class="section-title">Totalscore</div>
    ${scoreScaleHTML(score, band.label)}
    ${legendHTML()}
  </div>`
}

function headerHTML(topic: string) {
  return `
  <div class="header">
    <h1 class="ttl">MI-rapport</h1>
    <div>${topic ? `<span class="badge">Tema: ${esc(topic)}</span>` : ""}</div>
  </div>`
}

function baseHTMLStart(css: string) {
  return `<!doctype html><html lang="no"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>MI-rapport</title><style>${css}</style></head><body><div class="wrap">`
}

function baseHTMLEnd() {
  return `</div><script>
  document.addEventListener('click', (e) => {
    const t = e.target
    if (!(t instanceof Element)) return
    const openBtn = t.closest('[data-ex]')
    if (openBtn) {
      const id = openBtn.getAttribute('data-ex')
      const pop = id ? document.getElementById(id) : null
      if (pop) pop.setAttribute('aria-hidden','false')
    }
    const closeBtn = t.closest('[data-ex-close]')
    if (closeBtn) {
      const id = closeBtn.getAttribute('data-ex-close')
      const pop = id ? document.getElementById(id) : null
      if (pop) pop.setAttribute('aria-hidden','true')
    }
    const pop = t.classList.contains('ex-pop') ? t : t.closest('.ex-pop')
    if (pop && t === pop) pop.setAttribute('aria-hidden','true')
  })
  </script></body></html>`
}

export async function POST(req: NextRequest) {
  try {
    const { analysis: aInput, topic = "" } = await req.json()
    const a: Analysis = aInput || {}
    const score = typeof (a as any).total_score === "number" ? clamp100((a as any).total_score) : scoreFromAnalysis(a)

    const parts: string[] = []
    parts.push(baseHTMLStart(baseCSS()))
    parts.push(headerHTML(topic))
    parts.push(scoreCardHTML(score))
    parts.push(oarsTableHTML(a))
    parts.push(baseHTMLEnd())

    const html = parts.join("")
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
  } catch (e) {
    return new Response("Kunne ikke generere rapport (serverfeil).", { status: 500 })
  }
}