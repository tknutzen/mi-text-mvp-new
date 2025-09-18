// app/api/report/route.ts
import { NextRequest } from "next/server"
import { scoreFromAnalysis, generateFeedback, type Analysis } from "@/lib/report"

export const runtime = "nodejs"

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))

function bandForScore(s: number) {
  if (s >= 85) return { farge: "#14532d", bakgrunn: "#dcfce7", tekst: "Svært høy MI-kvalitet" }
  if (s >= 70) return { farge: "#166534", bakgrunn: "#ecfdf5", tekst: "Høy MI-kvalitet" }
  if (s >= 55) return { farge: "#1d4ed8", bakgrunn: "#eff6ff", tekst: "God MI, utviklingspotensial" }
  if (s >= 40) return { farge: "#a16207", bakgrunn: "#fef3c7", tekst: "Ustabil MI – juster teknikk" }
  return { farge: "#991b1b", bakgrunn: "#fee2e2", tekst: "Lav MI-kvalitet – fokuser grunnferdigheter" }
}

function scoreScaleHTML(score: number, bandText: string) {
  const s = clamp(score)
  const segs = Array.from({ length: 10 }, (_, i) => {
    const left = i * 10
    const w = 10
    const color = i < 4 ? "#fee2e2" : i < 5 ? "#fef3c7" : i < 7 ? "#eff6ff" : i < 8 ? "#ecfdf5" : "#dcfce7"
    return `<div class="seg" style="left:${left}%;width:${w}%;background:${color}"></div>`
  }).join("")
  const minorTicks = Array.from({ length: 100 }, (_, i) => `<div class="tick m" style="left:${i + 1}%"></div>`).join("")
  const majorTicks = Array.from({ length: 11 }, (_, i) => `<div class="tick M" style="left:${i * 10}%"></div>`).join("")
  return `
  <div class="scale">
    <div class="bar">
      ${segs}
      ${minorTicks}
      ${majorTicks}
      <div class="score-marker" style="left:${s}%;" aria-label="Score ${s}/100">
        <div class="score-chip">
          <div class="score-chip-text">${s}/100</div>
          <div class="score-chip-arrow"></div>
        </div>
        <div class="score-pin"></div>
      </div>
    </div>
    <div class="bandtext">${esc(bandText)}</div>
  </div>
  `
}

function oarsTableHTML(a: Analysis) {
  const c = a.counts || {}
  const r = a.ratios || {}
  const rows = [
    ["Åpne spørsmål", c.open_questions ?? 0, r.open_question_share != null ? Math.round((r.open_question_share || 0) * 100) + " %" : "–"],
    ["Lukkede spørsmål", c.closed_questions ?? 0, "–"],
    ["Enkle refleksjoner", c.reflections_simple ?? 0, "–"],
    ["Komplekse refleksjoner", c.reflections_complex ?? 0, r.complex_reflection_share != null ? Math.round((r.complex_reflection_share || 0) * 100) + " %" : "–"],
    ["Refleksjoner pr. spørsmål", (c.reflections_simple ?? 0) + (c.reflections_complex ?? 0), r.reflection_to_question != null ? (r.reflection_to_question || 0).toFixed(2) : "–"],
    ["Bekreftelser", c.affirmations ?? 0, "–"],
    ["Oppsummeringer", c.summaries ?? 0, "–"]
  ]
  const trs = rows.map(([label, val, share]) => `
    <tr>
      <td class="lbl">${esc(String(label))}</td>
      <td class="val">${esc(String(val))}</td>
      <td class="share">${esc(String(share))}</td>
    </tr>
  `).join("")
  return `
    <table class="oars">
      <thead>
        <tr><th>Tiltak</th><th>Antall</th><th>Andel/Forhold</th></tr>
      </thead>
      <tbody>${trs}</tbody>
    </table>
  `
}

function examplesHTML(a: any) {
  const ex = a?.examples
  if (!ex || typeof ex !== "object") return ""
  const keys: Array<[string, string]> = [
    ["open_questions", "Åpne spørsmål"],
    ["closed_questions", "Lukkede spørsmål"],
    ["reflections_simple", "Enkle refleksjoner"],
    ["reflections_complex", "Komplekse refleksjoner"],
    ["affirmations", "Bekreftelser"],
    ["summaries", "Oppsummeringer"]
  ]
  const sections = keys.map(([k, tittel]) => {
    const list = Array.isArray(ex[k]) ? ex[k] as string[] : []
    if (!list.length) return ""
    const lis = list.map((s) => `<li>${esc(String(s))}</li>`).join("")
    return `
      <details class="ex">
        <summary>${esc(tittel)} <span class="pill">${list.length}</span></summary>
        <ul>${lis}</ul>
      </details>
    `
  }).join("")
  if (!sections.trim()) return ""
  return `
    <div class="card">
      <div class="section-title">Eksempler per kategori</div>
      <p class="muted">Nedenfor vises representative utsnitt maskinen har identifisert. Bruk dette som læringsstøtte, ikke som fasit.</p>
      ${sections}
    </div>
  `
}

function feedbackHTML(a: Analysis) {
  const fb = generateFeedback(a)
  const strengths = (fb.strengths || []).map(s => `<li>${esc(s)}</li>`).join("")
  const improvements = (fb.improvements || []).map(s => `<li>${esc(s)}</li>`).join("")
  const next = (fb.next_exercises || []).map(s => `<li>${esc(s)}</li>`).join("")
  return `
    <div class="card">
      <div class="section-title">Tilbakemelding</div>
      <div class="fb">
        <div class="fbcol">
          <div class="fbh">Styrker</div>
          <ul class="list">${strengths || `<li>Ingen spesifikke styrker identifisert.</li>`}</ul>
        </div>
        <div class="fbcol">
          <div class="fbh warn">Forbedringer</div>
          <ul class="list">${improvements || `<li>Ingen spesifikke forbedringspunkter identifisert.</li>`}</ul>
        </div>
      </div>
      <div class="ex-next">
        <div class="fbh">Neste øvelser</div>
        <ul class="list">${next || `<li>Øv på korte oppsummeringer ved skifte av tema.</li>`}</ul>
      </div>
    </div>
  `
}

function baseCSS() {
  return `
  :root{
    --bg:#f5f7fb; --card:#ffffff; --line:#e5e7eb; --muted:#6b7280; --title:#111827; --accent:#111827;
  }
  *{box-sizing:border-box}
  html,body{padding:0;margin:0;background:var(--bg);color:#111827;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;line-height:1.45}
  .wrap{max-width:1000px;margin:24px auto;padding:0 16px}
  .header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}
  .ttl{font-size:26px;font-weight:800;color:var(--title);margin:0}
  .badge{display:inline-flex;align-items:center;gap:8px;background:#eef2ff;border:1px solid #e5e7eb;border-radius:999px;padding:6px 10px;font-weight:600;font-size:12px;color:#3730a3}
  .muted{color:var(--muted);font-size:13px;margin:4px 0 0}

  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0;box-shadow:0 1px 2px rgba(0,0,0,.03)}
  .section-title{font-weight:800;margin-bottom:8px}

  .scale{padding:12px 4px}
  .bar{position:relative;height:38px;border-radius:10px;border:1px solid var(--line);background:#fff;overflow:hidden}
  .seg{position:absolute;top:0;bottom:0}
  .tick.m{position:absolute;top:0;bottom:0;width:1px;background:rgba(0,0,0,.06)}
  .tick.M{position:absolute;top:0;bottom:0;width:2px;background:rgba(0,0,0,.18)}
  .bandtext{margin-top:8px;font-size:13px;color:var(--muted)}

  .score-marker{position:absolute;top:0;height:100%;transform:translateX(-50%);text-align:center;pointer-events:none}
  .score-pin{position:absolute;top:0;bottom:0;left:50%;width:2px;background:#111827;opacity:.6;transform:translateX(-1px)}
  .score-chip{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);background:#111827;color:#fff;border-radius:8px;padding:6px 10px;font-weight:800;font-size:12px;white-space:nowrap;box-shadow:0 4px 10px rgba(17,24,39,.15)}
  .score-chip-arrow{position:absolute;left:50%;bottom:-6px;transform:translateX(-50%);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:6px solid #111827}

  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:760px){.grid2{grid-template-columns:1fr}}

  table.oars{width:100%;border-collapse:collapse;margin-top:8px}
  table.oars th{font-size:12px;text-transform:uppercase;letter-spacing:.02em;color:#6b7280;border-bottom:1px solid var(--line);padding:8px;text-align:left}
  table.oars td{padding:10px 8px;border-bottom:1px solid #f3f4f6}
  table.oars td.lbl{font-weight:600}
  table.oars td.val, table.oars td.share{width:110px}

  .ex{border:1px dashed var(--line);border-radius:10px;padding:10px 12px;margin:8px 0;transition:background .2s}
  .ex:hover{background:#fafafa}
  .ex summary{cursor:pointer;font-weight:700}
  .ex .pill{display:inline-block;margin-left:8px;background:#eef2ff;color:#3730a3;border:1px solid #e5e7eb;border-radius:999px;padding:2px 8px;font-size:12px}
  .ex ul{margin:8px 0 0 18px}

  .fb{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:760px){.fb{grid-template-columns:1fr}}
  .fbh{font-weight:800;margin-bottom:6px}
  .fbh.warn{color:#7c2d12}
  .list{margin:6px 0 0 18px}

  .legend{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;margin-top:8px}
  .leg{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;border:1px solid var(--line);background:#fff}
  .sw{width:10px;height:10px;border-radius:2px}
  `
}

function legendHTML() {
  return `
    <div class="legend">
      <div class="leg"><span class="sw" style="background:#fee2e2"></span>Lav</div>
      <div class="leg"><span class="sw" style="background:#fef3c7"></span>Under mål</div>
      <div class="leg"><span class="sw" style="background:#eff6ff"></span>OK</div>
      <div class="leg"><span class="sw" style="background:#ecfdf5"></span>God</div>
      <div class="leg"><span class="sw" style="background:#dcfce7"></span>Svært god</div>
    </div>
  `
}

export async function POST(req: NextRequest) {
  try {
    const { analysis: aInput, topic = "" } = await req.json()
    const a: Analysis = aInput || {}
    const totalscore = typeof (a as any).total_score === "number" ? clamp((a as any).total_score) : scoreFromAnalysis(a)
    const band = bandForScore(totalscore)
    const head = `
      <!doctype html>
      <html lang="no">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title>MI-rapport</title>
        <style>${baseCSS()}</style>
      </head>
      <body>
        <div class="wrap">
          <div class="header">
            <h1 class="ttl">MI-rapport</h1>
            <div>
              ${topic ? `<span class="badge">Tema: ${esc(topic)}</span>` : ""}
            </div>
          </div>
    `
    const scoreCard = `
      <div class="card" style="border-color:${band.farge};">
        <div class="section-title">Totalscore</div>
        ${scoreScaleHTML(totalscore, band.tekst)}
        ${legendHTML()}
      </div>
    `
    const oarsCard = `
      <div class="card">
        <div class="section-title">OARS-tellinger</div>
        ${oarsTableHTML(a)}
      </div>
    `
    const examplesCard = examplesHTML(a)
    const feedbackCard = feedbackHTML(a)
    const tail = `
        </div>
      </body>
      </html>
    `
    const html = head + scoreCard + oarsCard + examplesCard + feedbackCard + tail
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
  } catch (e: any) {
    return new Response("Kunne ikke generere rapport (serverfeil).", { status: 500 })
  }
}