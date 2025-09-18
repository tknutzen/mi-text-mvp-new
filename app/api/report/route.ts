// app/api/report/route.ts
import { NextRequest } from "next/server"

export const runtime = "nodejs"

type Tellinger = {
  aapne: number
  lukkede: number
  bekreftelser: number
  refleksjonEnkel: number
  refleksjonKompleks: number
  refleksjonerTotalt: number
  oppsummeringer: number
  spørsmålTotalt: number
}

type Labeler = {
  open_question: boolean
  closed_question: boolean
  affirmation: boolean
  reflection_simple: boolean
  reflection_complex: boolean
  summary: boolean
}

type KlassRad = {
  index: number
  speaker: "jobbkonsulent" | "jobbsøker"
  labels: Labeler
}

type AnalyseIn = {
  tellinger: Tellinger
  klassifisering: KlassRad[]
  tema?: string
  total_score: number
}

type Body = { analysis?: AnalyseIn; topic?: string }

function pct(n: number) {
  return `${Math.round((n || 0) * 100)}%`
}

function safe(n: number) {
  return Number.isFinite(n) ? n : 0
}

function lagHtml(a: AnalyseIn, tema: string) {
  const t = a.tellinger
  const spTot = Math.max(1, t.spørsmålTotalt || 0)
  const reflTot = Math.max(1, t.refleksjonerTotalt || 0)

  const andelAapne = safe(t.aapne / spTot)
  const rq = safe(t.refleksjonerTotalt / spTot)
  const cxShare = safe(t.refleksjonKompleks / reflTot)

  const css = `
  :root{--ink:#0b1020;--mut:#5b6375;--line:#e6e8ef;--bg:#f7f9fc;--brand:#1652f0}
  *{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
  h1{font-size:22px;margin:0 0 8px}h2{font-size:16px;margin:18px 0 8px}
  .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 12px}
  .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
  .kpi{padding:12px;border:1px solid var(--line);border-radius:10px}
  .kpi b{font-size:18px;display:block;margin-bottom:4px}
  table{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;overflow:hidden;border:1px solid var(--line)}
  th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left}
  .pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;margin-right:6px;font-size:12px}
  .foot{color:var(--mut);font-size:12px;margin-top:10px}
  .score{font-weight:700;color:var(--brand)}
  `

  const head = `
  <div class="card">
    <h1>MI-rapport</h1>
    <div class="foot">Tema: ${tema || ""}</div>
    <div class="grid" style="margin-top:12px">
      <div class="kpi"><b class="score">${a.total_score}/100</b><div>Totalscore</div></div>
      <div class="kpi"><b>${t.aapne}/${spTot} (${pct(andelAapne)})</b><div>Åpne spørsmål</div></div>
      <div class="kpi"><b>${t.refleksjonerTotalt}/${spTot} (${pct(rq)})</b><div>Refleksjoner per spørsmål</div></div>
    </div>
  </div>`

  const telling = `
  <div class="card">
    <h2>Tellemål</h2>
    <table>
      <thead><tr><th>Kategori</th><th>Antall</th><th>Tillegg</th></tr></thead>
      <tbody>
        <tr><td>Åpne spørsmål</td><td>${t.aapne}</td><td>Andel: ${pct(andelAapne)}</td></tr>
        <tr><td>Lukkede spørsmål</td><td>${t.lukkede}</td><td>&nbsp;</td></tr>
        <tr><td>Refleksjoner enkle</td><td>${t.refleksjonEnkel}</td><td>&nbsp;</td></tr>
        <tr><td>Refleksjoner komplekse</td><td>${t.refleksjonKompleks}</td><td>Andel av refl.: ${pct(cxShare)}</td></tr>
        <tr><td>Oppsummeringer</td><td>${t.oppsummeringer}</td><td>&nbsp;</td></tr>
        <tr><td>Bekreftelser</td><td>${t.bekreftelser}</td><td>&nbsp;</td></tr>
      </tbody>
    </table>
    <div class="foot">Spørsmål totalt: ${t.spørsmålTotalt} • Refleksjoner totalt: ${t.refleksjonerTotalt}</div>
  </div>`

  const dist = (() => {
    const s = a.klassifisering.filter(r => r.speaker === "jobbkonsulent")
    const sum = s.filter(r => r.labels.summary).length
    const aff = s.filter(r => r.labels.affirmation).length
    const oq = s.filter(r => r.labels.open_question).length
    const cq = s.filter(r => r.labels.closed_question).length
    const rs = s.filter(r => r.labels.reflection_simple).length
    const rc = s.filter(r => r.labels.reflection_complex).length
    return { sum, aff, oq, cq, rs, rc, total: s.length }
  })()

  const labels = `
  <div class="card">
    <h2>Fordeling etiketter (veileder-ytringer)</h2>
    <div class="pill">Oppsummering: ${dist.sum}</div>
    <div class="pill">Bekreftelse: ${dist.aff}</div>
    <div class="pill">Åpne spm.: ${dist.oq}</div>
    <div class="pill">Lukkede spm.: ${dist.cq}</div>
    <div class="pill">Refleksjon enkel: ${dist.rs}</div>
    <div class="pill">Refleksjon kompleks: ${dist.rc}</div>
    <div class="foot">Totalt merkede veileder-ytringer: ${dist.total}</div>
  </div>`

  return `<!doctype html>
  <html lang="no">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>MI-rapport</title>
      <style>${css}</style>
    </head>
    <body>
      ${head}
      ${telling}
      ${labels}
    </body>
  </html>`
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Body
    const a = body.analysis
    if (!a) return new Response("Mangler analysis i body", { status: 400 })
    const html = lagHtml(a, body.topic || a.tema || "")
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
  } catch (e: any) {
    return new Response("Kunne ikke generere rapport (serverfeil).", { status: 500 })
  }
}