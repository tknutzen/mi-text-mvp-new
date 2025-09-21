'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import './globals.css';
import { Turn } from '../lib/types';

/* ===== SCORM bridge (postMessage) – trygt å ha her i klientkomponenten ===== */
function sendScormMessage(payload: Record<string, any>) {
  if (typeof window !== 'undefined' && window.parent) {
    try {
      window.parent.postMessage({ type: 'scorm', ...payload }, '*');
    } catch (e) {
      // Ignorer stille dersom vi ikke er inne i SCORM-wrapper
      console.warn('SCORM postMessage feilet (ikke kritisk):', e);
    }
  }
}

function sendScore(score: number) {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  sendScormMessage({ event: 'score', score: s });
}

function sendProgress(progress: number) {
  const p = Math.max(0, Math.min(100, Math.round(progress)));
  sendScormMessage({ event: 'progress', progress: p });
}

function sendCompleted() {
  sendScormMessage({ event: 'completed' });
}

function sendExit() {
  sendScormMessage({ event: 'exit' });
}

/* ===== Hjelpere ===== */
function makeId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    try {
      return (crypto as any).randomUUID() as string;
    } catch {}
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function Page() {
  const [sessionId, setSessionId] = useState<string>('');
  const [topic, setTopic] = useState('Jobbambivalens'); // ✅ default
  const [difficulty, setDifficulty] = useState<'lett' | 'moderat' | 'vanskelig'>('moderat');

  const [started, setStarted] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false); // sender meldinger
  const [analyzing, setAnalyzing] = useState(false); // lager rapport
  const [showHint, setShowHint] = useState(false); // popup-hint etter start

  const [analysis, setAnalysis] = useState<any>(null);
  const [reportHtml, setReportHtml] = useState<string>('');
  const chatRef = useRef<HTMLDivElement>(null);
  const [logoOk, setLogoOk] = useState(true);

  // Juster hvis du vil måle progresjon mot et annet mål
  const TARGET_TURNS = 10;

  useEffect(() => {
    resetSession(false);
  }, []);

  function resetSession(clearTopicAndLevel: boolean) {
    setSessionId(makeId());
    if (clearTopicAndLevel) {
      setTopic('Jobbambivalens');
      setDifficulty('moderat');
    }
    setStarted(false);
    setTurns([]);
    setInput('');
    setBusy(false);
    setAnalyzing(false);
    setAnalysis(null);
    setReportHtml('');
    setShowHint(false);

    // SCORM: nullstill progresjon ved ny samtale
    sendProgress(0);
  }

  // Transkript til LLM (assistant=jobbsøker, user=jobbkonsulent)
  const transcriptForLLM = useMemo(() => {
    return turns.map((t) => ({
      role: t.speaker === 'jobbkonsulent' ? 'user' : 'assistant',
      content: t.text,
    }));
  }, [turns]);

  function startConversation() {
    setStarted(true);
    setShowHint(true);
  }

  async function sendMessage() {
    if (!input.trim() || busy || !started || analyzing) return;

    const me: Turn = {
      speaker: 'jobbkonsulent',
      text: input.trim(),
      ts: Date.now(),
    };

    setTurns((prev) => {
      const next = [...prev, me];

      // SCORM: oppdater progresjon ved ny tur
      const progress = Math.min(100, Math.round((next.length / TARGET_TURNS) * 100));
      sendProgress(progress);

      return next;
    });
    setInput('');
    setBusy(true);

    try {
      const resp = await fetch('/api/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          difficulty,
          transcript: transcriptForLLM.concat([{ role: 'user', content: me.text }]),
        }),
      });

      const data = await resp.json().catch(() => ({}));
      const replyText = data?.reply || '…';
      const reply: Turn = {
        speaker: 'jobbsøker',
        text: replyText,
        ts: Date.now(),
      };
      setTurns((prev) => {
        const next = [...prev, reply];

        // SCORM: oppdater progresjon også når jobbsøker svarer
        const progress = Math.min(100, Math.round((next.length / TARGET_TURNS) * 100));
        sendProgress(progress);

        return next;
      });
    } finally {
      setBusy(false);
      // scroll ned
      setTimeout(() => {
        if (chatRef.current) {
          chatRef.current.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
        }
      }, 50);
    }
  }

  async function endSessionAndAnalyze() {
    if (busy || analyzing || turns.length === 0) return;
    setAnalyzing(true);
    setAnalysis(null);
    setReportHtml('');

    try {
      // 1) Analyse
      const resp = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ turns, topic }),
      });

      if (!resp.ok) {
        const msg = await resp.text().catch(() => '');
        throw new Error(`Analyze error ${resp.status}: ${msg || 'Ukjent feil'}`);
      }

      const a = await resp.json();
      setAnalysis(a);

      // 2) Rapport – send samme topic-felt
      const r = await fetch('/api/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/html',
        },
        cache: 'no-store',
        body: JSON.stringify({ analysis: a, topic }),
      });

      if (!r.ok) {
        const msg = await r.text().catch(() => 'Ukjent feil');
        console.error('Report error:', msg);
        alert(`Feil i rapport-endepunktet (/api/report): ${msg}`);
        return;
      }

      const html = await r.text();
      setReportHtml(html);

      /* ===== SCORM: score + completed =====
         Forutsetter at /api/analyze returnerer total_score (0–100) som a.total_score.
         Justér hvis ditt felt heter noe annet. */
      if (typeof a?.total_score === 'number') {
        sendScore(a.total_score);
      }
      // Marker som fullført når rapporten er generert
      sendCompleted();
    } catch (e: any) {
      console.error('Unexpected error:', e);
      alert(`Uventet feil: ${e?.message ?? e}`);
    } finally {
      setAnalyzing(false);
    }
  } // ⬅️ pass på klamme

  function downloadHtml() {
    const blob = new Blob([reportHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mi-rapport-${sessionId || 'session'}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ====== RENDER ====== */
  return (
    <div className="container">
      {/* HEADER – logo over tittel */}
      <div className="header">
        {logoOk ? (
          <img
            src="/fretex.png"
            alt="Fretex"
            className="logo"
            onError={() => setLogoOk(false)}
          />
        ) : (
          <div className="badge">Fretex</div>
        )}
        <h1 className="title">MI – tekstsimulator</h1>
        <p className="small">
          Du er en jobbkonsulent som skal gjennomføre en samtale med en jobbsøker. Du må først velge
          tema og vanskelighetsgrad. Deretter starter du samtalen ved å skrive inn tekst i
          meldingsfeltet. Når du avslutter samtalen får du en rapport som du kan bruke til å
          forbedre deg. Husk å bruke OARS-teknikkene. Lykke til!
        </p>
      </div>

      {/* KORT 1: Innstillinger + Start-knapp */}
      <div className="card">
        <div className="row" style={{ alignItems: 'end' }}>
          {/* Tema */}
          <div style={{ flex: 1, minWidth: 220 }}>
            <label>Tema</label>
            <select
              className="select-control"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              disabled={started}
            >
              <option>Jobbambivalens</option>
              <option>Manglende oppmøte</option>
              <option>Redusere rusbruk</option>
              <option>Aggressiv atferd</option>
            </select>
          </div>

          {/* Vanskelighetsgrad */}
          <div style={{ flex: 1, minWidth: 220 }}>
            <label>Vanskelighetsgrad</label>
            <select
              className="select-control"
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value as any)}
              disabled={started}
            >
              <option value="lett">Lett</option>
              <option value="moderat">Moderat</option>
              <option value="vanskelig">Vanskelig</option>
            </select>
          </div>

          {/* Start/ny */}
          <div style={{ display: 'flex', alignItems: 'end' }}>
            {!started ? (
              <button
                className="btn-control"
                onClick={startConversation}
                disabled={busy || analyzing}
              >
                Start samtale
              </button>
            ) : (
              <button
                className="secondary btn-control"
                onClick={() => resetSession(false)}
                disabled={busy || analyzing}
              >
                Ny samtale
              </button>
            )}
          </div>
        </div>
      </div>

      {/* KORT 2: Chat */}
      <div className="card chat-card" style={{ marginTop: 12 }}>
        <div
          ref={chatRef}
          className="chat"
          style={{
            height: 360,
            overflowY: 'auto',
            padding: 8,
            border: '1px solid var(--line)',
            borderRadius: 8,
            background: '#fff',
          }}
        >
          {started && turns.length > 0 &&
            turns.map((t, i) => (
              <div
                key={i}
                className={`bubble ${t.speaker === 'jobbkonsulent' ? 'student' : 'client'}`}
              >
                <strong>{t.speaker === 'jobbkonsulent' ? 'Jobbkonsulent' : 'Jobbsøker'}:</strong>{' '}
                {t.text}
              </div>
            ))}
        </div>

        {/* Input + send */}
        <div className="row input-wrapper" style={{ marginTop: 8 }}>
          {showHint && started && turns.length === 0 && input.length === 0 && (
            <div className="popup-hint">Start samtalen ved å skrive inn en melding her.</div>
          )}

          <input
            placeholder={started ? 'Skriv din melding til jobbsøkeren …' : 'Trykk Start samtale først'}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (showHint && e.target.value.length > 0) setShowHint(false);
            }}
            onKeyDown={(e) => {
              if (showHint && e.key.length === 1) setShowHint(false);
              if (e.key === 'Enter') sendMessage();
            }}
            disabled={busy || analyzing || !started}
            style={{ flex: 1 }}
          />
          <button onClick={sendMessage} disabled={busy || analyzing || !input.trim() || !started}>
            Send
          </button>
        </div>

        {/* Avslutt + status */}
        <div className="row" style={{ marginTop: 20, justifyContent: 'center', gap: 12 }}>
          <button onClick={endSessionAndAnalyze} disabled={busy || analyzing || turns.length === 0}>
            Avslutt samtale og lag rapport
          </button>
          {analyzing && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="loader" aria-label="Laster" />
              <div className="small">Genererer rapport …</div>
            </div>
          )}
        </div>
      </div>

      {/* KORT 3: Full rapport */}
      {analysis && (
        <div className="card" style={{ marginTop: 12 }}>
          <h2>Rapport</h2>
          <p>
            <span className="badge">Totalscore: {analysis.total_score}/100</span>
          </p>
          {reportHtml && (
            <>
              <iframe
                title="MI-rapport"
                style={{ width: '100%', height: 900, border: '1px solid var(--line)', borderRadius: 8 }}
                srcDoc={reportHtml}
              />
              <div className="download">
                <button onClick={downloadHtml}>Last ned HTML-rapport</button>
                <p className="small">Tips: Åpne HTML-filen og skriv ut som PDF.</p>
              </div>
            </>
          )}
        </div>
      )}

      {/* (Valgfritt) Egen avslutt-knapp som også sender exit til SCORM-wrapper */}
      {/* <div style={{ marginTop: 16, textAlign: 'center' }}>
        <button className="secondary" onClick={() => sendExit()}>Avslutt (SCORM)</button>
      </div> */}
    </div>
  );
}