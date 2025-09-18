// app/api/report/route.ts
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { Analysis } from '../../../lib/types';
import { generateFeedback, scoreFromAnalysis } from '../../../lib/report';

/** ---------- Utils ---------- */
function esc(s: unknown) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
const norm = (s: string) => (s || '').toLowerCase().trim();
const clamp = (n: number, min = 0, max = 100) => Math.max(min, Math.min(max, n));

/** ---------- Tema-gruppering (som før, men robust) ---------- */
const BANNED = new Set([
  'annet','other','diverse','ukjent','-','avslutning','slutt',
  'closing','oppsummering','intro','oppstart','start','smalltalk',
  'hilsen','hilsing','prat','samtale'
]);

const RELATED: Record<string, string[]> = {
  'jobbambivalens': [
    'jobb','arbeid','lønn','stilling','deltid','heltid','praksis',
    'opptrapping','trygd','ytelser','nav','aap','dagpenger','pensjon',
    'tilrettelegging','arbeidsevne','kapasitet','helse','utbrenthet','stress'
  ],
  'manglende oppmøte': [
    'oppmøte','møter','for sent','fravær','avtaler','telefon','varsling',
    'rutiner','årsaker','hindringer','transport','søvn','motivasjon'
  ],
  'redusere rusbruk': [
    'rus','alkohol','cannabis','hasj','piller','substanser','kontroll',
    'abstinens','bakrus','triggere','mengde','hyppighet'
  ],
  'aggressiv atferd': [
    'konflikt','krangel','sinte reaksjoner','utbrudd','grenser','trigger',
    'regler','kollega','kunde','tillit','advarsel','oppsigelse'
  ]
};

function groupForReport(
  selectedMain: string,
  otherTopics: string[] = [],
  byTurn: { turnIndex: number; topic: string }[] = []
) {
  const main = norm(selectedMain);
  const related = new Set((RELATED[main] || []).map(norm));

  const othersSet = new Set<string>();
  for (const t of otherTopics) {
    const tn = norm(t);
    if (!tn || BANNED.has(tn)) continue;
    if (tn === main || related.has(tn)) continue;
    othersSet.add(tn);
  }

  let shifts = 0;
  let prev = '';
  for (const row of byTurn || []) {
    const tn = norm(row.topic);
    if (!tn || BANNED.has(tn)) continue;
    const grouped = tn === main || related.has(tn) ? main : tn;
    if (prev && grouped !== prev) shifts++;
    prev = grouped;
  }

  return {
    mainLabel: selectedMain || '—',
    others: Array.from(othersSet),
    shifts
  };
}

/** ---------- Score-tekst + skala ---------- */
function scoreBandText(score: number) {
  if (score >= 80) return 'Meget god OARS-bruk.';
  if (score >= 60) return 'God OARS-bruk – noen forbedringspunkter.';
  if (score >= 40) return 'På vei – styrk refleksjoner/bekreftelser/korte oppsummeringer.';
  return 'Trenger mer systematikk i OARS.';
}

const SEGMENTS = [
  { left: 0,  width: 50, color: 'red'   },
  { left: 50, width: 30, color: 'yellow'},
  { left: 80, width: 20, color: 'green' },
];

const MAJOR_LABELS: Record<number, string> = {
  0:   'Ingen OARS',
  20:  'Lite OARS',
  40:  'Moderat OARS',
  60:  'God OARS',
  80:  'Meget god OARS',
  100: 'Fullkommen OARS',
};

function scoreScaleHTML(score: number, bandText: string) {
  const s = clamp(score);
  const majors = [0, 20, 40, 60, 80, 100];
  const minors = [10, 30, 50, 70, 90];

  const segs = SEGMENTS.map(b => `
    <div class="seg ${b.color}" style="left:${b.left}%; width:${b.width}%;" aria-hidden="true"></div>
  `).join('');

  const majorTicks = majors.map(p => `
    <div class="tick major" style="left:${p}%;" aria-hidden="true"></div>
    <div class="tick-label" style="left:${p}%;">${esc(MAJOR_LABELS[p])}</div>
  `).join('');

  const minorTicks = minors.map(p => `
    <div class="tick minor" style="left:${p}%;" aria-hidden="true"></div>
  `).join('');

  return `
  <div class="scale">
    <div class="bar">
      ${segs}
      ${minorTicks}
      ${majorTicks}

      <!-- Score marker med chip over og liten strek/pil ned -->
      <div class="score-marker" style="left:${s}%;" aria-label="Score ${s}/100">
        <div class="score-chip">
          <div class="score-chip-text">${esc(String(s))}/100</div>
          <div class="score-chip-arrow"></div>
        </div>
        <div class="score-pin"></div>
      </div>
    </div>
    <div class="bandtext">${esc(bandText)}</div>
  </div>
  `;
}

/** ---------- Datagrunnlag ---------- */
function hasSufficientData(analysis: Analysis): boolean {
  const c = analysis.counts ?? ({} as any);
  const total =
    (c.open_questions ?? 0) +
    (c.closed_questions ?? 0) +
    (c.reflections_simple ?? 0) +
    (c.reflections_complex ?? 0) +
    (c.affirmations ?? 0) +
    (c.summaries ?? 0);
  return total >= 5;
}

/** ---------- Route ---------- */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const analysis: Analysis = (body as any).analysis || ({} as any);
    const selectedTopic: string = (body as any).topic || (body as any).selectedTopic || '';

    const counts = analysis.counts || ({} as any);
    const ratios = analysis.ratios || ({} as any);

    const topicsSafe = analysis.topics ?? {
      primary_topic: selectedTopic || '',
      other_topics: [] as string[],
      topic_shifts: 0,
      by_turn: [] as { turnIndex: number; topic: string }[],
    };

    const grouped = groupForReport(
      selectedTopic || String(topicsSafe.primary_topic || ''),
      topicsSafe.other_topics || [],
      topicsSafe.by_turn || []
    );

    const computedScore =
      typeof analysis.total_score === 'number'
        ? analysis.total_score
        : scoreFromAnalysis(analysis as Analysis);

    const total_score = clamp(Math.round(computedScore));
    const sufficient = hasSufficientData(analysis);

    // Feedback (bruk allerede generert hvis tilstede, ellers generer)
    const fb =
      analysis.feedback &&
      (Array.isArray((analysis as any).feedback.strengths) || Array.isArray((analysis as any).feedback.improvements))
        ? (analysis as any).feedback
        : (sufficient ? generateFeedback(analysis as Analysis) : { strengths: [], improvements: [], next_exercises: [] });

    // Eksempler (fra analyze-laget hvis tilgjengelig)
    const ex = (analysis as any).examples || {
      open_questions: [],
      closed_questions: [],
      reflections_simple: [],
      reflections_complex: [],
      affirmations: [],
      summaries: [],
    };

    const bandText = scoreBandText(total_score);

    const html = `<!doctype html>
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
      --barH: 18px; /* passe høy linje */
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
    .good{ color:var(--good); }
    .bad{ color:var(--bad); }
    .threecol th:nth-child(1), .threecol td:nth-child(1){ width: 40%; }
    .threecol th:nth-child(2), .threecol td:nth-child(2){ width: 20%; white-space: nowrap; }
    .threecol th:nth-child(3), .threecol td:nth-child(3){ width: 40%; color: var(--muted); }

    /* ------- Skala ------- */
    .scale { margin-top: 10px; }
    .bar{
      position: relative;
      height: var(--barH);
      border-radius: 8px;
      overflow: hidden;
      background: transparent;
      box-shadow: inset 0 0 0 1px #11182712;
    }
    .seg{ position:absolute; top:0; height:100%; }
    .seg.red{    left:0; background: var(--red); }
    .seg.yellow{ background: var(--yellow); left:50%; }
    .seg.green{  background: var(--green); left:80%; }

    .tick{
      position:absolute; top:0;
      width:2px; height:100%;
      transform: translateX(-1px);
      background: #11182720;
      pointer-events: none;
    }
    .tick.minor { opacity: 0.45; }
    .tick.major { opacity: 0.8; }

    /* Label på 20%-ticks — under linjen */
    .tick-label{
      position:absolute;
      top: calc(100% + 6px);
      transform: translateX(-50%);
      font-size: 11px;
      font-weight: 700;
      color: #111827;
      white-space: nowrap;
      pointer-events: none;
    }

    /* Markør for score – midtstilt vertikalt */
    .score-marker{
      position:absolute; top:0; height:100%;
      transform: translateX(-50%);
      text-align:center; pointer-events:none;
    }
    .score-pin{
      position:absolute; top:0; bottom:0; left:50%;
      width:2px; background:#111827; opacity:.6; transform: translateX(-1px);
    }
    .score-chip{
      position:absolute; bottom: calc(100% + 8px); left:50%;
      transform: translateX(-50%);
      background:#111827; color:#fff; border-radius:8px; padding:6px 10px;
      font-weight:800; font-size:12px; white-space:nowrap;
      box-shadow: 0 4px 10px rgba(17,24,39,.15);
    }
    .score-chip-text{ position:relative; z-index:2; }
    .score-chip-arrow{
      position:absolute; left:50%; bottom:-6px; transform: translateX(-50%);
      width: 0; height: 0; border-left: 6px solid transparent;
      border-right: 6px solid transparent; border-top: 6px solid #111827;
    }

    .bandtext{
      margin-top: 10px; font-size: 14px; color: var(--muted);
    }

    /* OARS-eksempler */
    .linkbtn{
      background:none; border:none; color:#2563eb; cursor:pointer;
      padding:0; font-size:14px; text-decoration:underline;
    }
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
      ${scoreScaleHTML(total_score, bandText)}
    </div>

    <div class="card">
      <div class="section-title">OARS – telling</div>
      <table class="threecol">
        <tr><th>Type</th><th>Verdi</th><th>Forklaring/eksempler</th></tr>
        <tr>
          <td>Åpne spørsmål</td>
          <td>${esc(counts.open_questions ?? 0)}</td>
          <td>
            Spørsmål som inviterer til utforsking.
            ${(ex.open_questions?.length||0) ? `<button class="linkbtn" data-target="ex-open">Vis eksempler (${ex.open_questions.length})</button>` : ''}
            <div id="ex-open" class="examples"><ul>${
              (ex.open_questions||[]).map((s:string)=>`<li>${esc(s)}</li>`).join('')
            }</ul></div>
          </td>
        </tr>
        <tr>
          <td>Lukkede spørsmål</td>
          <td>${esc(counts.closed_questions ?? 0)}</td>
          <td>
            Ja/nei- eller korte faktaspørsmål.
            ${(ex.closed_questions?.length||0) ? `<button class="linkbtn" data-target="ex-closed">Vis eksempler (${ex.closed_questions.length})</button>` : ''}
            <div id="ex-closed" class="examples"><ul>${
              (ex.closed_questions||[]).map((s:string)=>`<li>${esc(s)}</li>`).join('')
            }</ul></div>
          </td>
        </tr>
        <tr>
          <td>Refleksjoner (enkle)</td>
          <td>${esc(counts.reflections_simple ?? 0)}</td>
          <td>
            Gjenspeiler innhold i korte ordelag.
            ${(ex.reflections_simple?.length||0) ? `<button class="linkbtn" data-target="ex-rs">Vis eksempler (${ex.reflections_simple.length})</button>` : ''}
            <div id="ex-rs" class="examples"><ul>${
              (ex.reflections_simple||[]).map((s:string)=>`<li>${esc(s)}</li>`).join('')
            }</ul></div>
          </td>
        </tr>
        <tr>
          <td>Refleksjoner (komplekse)</td>
          <td>${esc(counts.reflections_complex ?? 0)}</td>
          <td>
            Utvider/fortolker – går litt dypere.
            ${(ex.reflections_complex?.length||0) ? `<button class="linkbtn" data-target="ex-rc">Vis eksempler (${ex.reflections_complex.length})</button>` : ''}
            <div id="ex-rc" class="examples"><ul>${
              (ex.reflections_complex||[]).map((s:string)=>`<li>${esc(s)}</li>`).join('')
            }</ul></div>
          </td>
        </tr>
        <tr>
          <td>Bekreftelser</td>
          <td>${esc(counts.affirmations ?? 0)}</td>
          <td>
            Styrke-/innsatsfokuserte utsagn.
            ${(ex.affirmations?.length||0) ? `<button class="linkbtn" data-target="ex-aff">Vis eksempler (${ex.affirmations.length})</button>` : ''}
            <div id="ex-aff" class="examples"><ul>${
              (ex.affirmations||[]).map((s:string)=>`<li>${esc(s)}</li>`).join('')
            }</ul></div>
          </td>
        </tr>
        <tr>
          <td>Oppsummeringer</td>
          <td>${esc(counts.summaries ?? 0)}</td>
          <td>
            Bør brukes ved skifte/slutt. Refleksjon helt mot slutten tolkes som oppsummering.
            ${(ex.summaries?.length||0) ? `<button class="linkbtn" data-target="ex-sum">Vis eksempler (${ex.summaries.length})</button>` : ''}
            <div id="ex-sum" class="examples"><ul>${
              (ex.summaries||[]).map((s:string)=>`<li>${esc(s)}</li>`).join('')
            }</ul></div>
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
      <div class="section-title">Tema</div>
      <table class="threecol">
        <tr><th>Type</th><th>Verdi</th><th>Forklaring/kommentar</th></tr>
        <tr><td>Hovedtema</td><td>${esc(grouped.mainLabel)}</td><td>Basert på valgt tema før samtalen.</td></tr>
        <tr><td>Andre tema berørt</td><td>${(grouped.others || []).length ? grouped.others.map(esc).join(', ') : '—'}</td><td>Nært beslektede begreper foldes inn i hovedtema.</td></tr>
        <tr><td>Temaskifter (anslått)</td><td>${esc(grouped.shifts)}</td><td>Skifter etter at nærliggende begreper er gruppert inn.</td></tr>
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
                  (fb?.strengths || []).length
                    ? `<ul>${(fb!.strengths || []).map((s: string) => `<li class="good">${esc(s)}</li>`).join('')}</ul>`
                    : `<div class="small muted">Ingen spesifikke styrker identifisert i denne økten.</div>`
                }
              </div>
              <div>
                <strong>Dette kan forbedres</strong>
                ${
                  (fb?.improvements || []).length
                    ? `<ul>${(fb!.improvements || []).map((s: string) => `<li class="bad">${esc(s)}</li>`).join('')}</ul>`
                    : `<div class="small muted">Ingen konkrete forbedringspunkter identifisert i denne økten.</div>`
                }
              </div>
            </div>
          `
          : `
            <div class="small muted">
              Datagrunnlaget er for lite til å gi målrettet tilbakemelding.
              Gjennomfør gjerne en lengre økt eller bruk flere OARS-tilnærminger for å få mer treffsikker rapport.
            </div>
          `
      }
    </div>

    <div class="small muted" style="margin-top:12px">
      Rapporten er veiledende og bør tolkes med faglig skjønn.
    </div>
  </div>

  <script>
    // Toggle for OARS-eksempler
    document.querySelectorAll('.linkbtn').forEach(function(btn){
      btn.addEventListener('click', function(){
        const id = btn.getAttribute('data-target');
        const el = id ? document.getElementById(id) : null;
        if (el) {
          el.style.display = (el.style.display === 'block') ? 'none' : 'block';
          btn.textContent = el.style.display === 'block' ? 'Skjul eksempler' : btn.textContent.replace('Skjul eksempler','Vis eksempler');
        }
      });
    });
  </script>
</body>
</html>`;

    return new NextResponse(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Report-Version': 'v6-marker-chip-examples'
      }
    });
  } catch (err) {
    console.error('Report route error:', err);
    return new NextResponse('Kunne ikke generere rapport (serverfeil).', { status: 500 });
  }
}