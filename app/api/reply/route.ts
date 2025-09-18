// app/api/reply/route.ts
import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

type ChatMsg = { role: 'user' | 'assistant' | 'system'; content: string };
type Difficulty = 'lett' | 'moderat' | 'vanskelig';

function minimalPostProcess(reply: string) {
  let out = (reply || '').trim();
  if (!out) return 'Beklager, noe gikk galt – prøv å sende meldingen på nytt.';
  if (!/[.!?]$/.test(out)) out += '.';
  return out;
}

/* ===================== Normalisering ===================== */

function normDiff(d?: string): Difficulty {
  const v = String(d || '').toLowerCase().trim();
  if (v.startsWith('lett')) return 'lett';
  if (v.startsWith('vansk')) return 'vanskelig';
  return 'moderat';
}

type TopicId = 'jobbambivalens' | 'manglende_oppmøte' | 'redusere_rusbruk' | 'aggressiv_atferd';

function normTopic(t?: string): { id: TopicId; label: string } {
  const raw = String(t || '').toLowerCase().trim();
  if (raw.includes('oppmøte')) return { id: 'manglende_oppmøte', label: 'Manglende oppmøte' };
  if (raw.includes('rus')) return { id: 'redusere_rusbruk', label: 'Redusere rusbruk' };
  if (raw.includes('aggress')) return { id: 'aggressiv_atferd', label: 'Aggressiv atferd' };
  return { id: 'jobbambivalens', label: 'Jobbambivalens' };
}

/* ===================== Heuristikk: spørsmåls-type ===================== */

function classifyQ(text: string): 'open' | 'closed' | 'statement' {
  const t = (text || '').trim().toLowerCase();
  if (!t) return 'statement';
  const isQ = t.endsWith('?') || /^(hva|hvordan|hvilke|hvilken|hvem|hvorfor|når|kan|vil|skal|er|har|tror|tenker|synes|fortell|beskriv|utdyp)/.test(t);
  if (!isQ) return 'statement';
  if (/^(hva|hvordan|hvilke|hvilken|hvem|hvorfor|fortell|beskriv|utdyp|si mer)/.test(t)) return 'open';
  return 'closed';
}

/* ===================== Systemprompt ===================== */

function difficultyProfile(d: Difficulty): string {
  switch (d) {
    case 'lett':
      return `
Vanskelighetsgrad: lett
- Friksjon: Lav. Samarbeidsvillig og åpen.
- Egen-forslag: Kan nevne korte, konkrete ideer (0–1 per svar), tentativt («kanskje kunne…»).
- Lengde: Åpne → 2–4 setninger. Lukkede → 1–2 setninger.`.trim();
    case 'vanskelig':
      return `
Vanskelighetsgrad: vanskelig
- Friksjon: Høyere. Reservert/knapp; svarer, men holder igjen.
- Egen-forslag: Unngå å foreslå egne tiltak med mindre veileder ber eksplisitt.
- **Lukkede spørsmål: svar med ett ord eller én svært kort setning.**
- **Åpne spørsmål: 1–2 korte setninger.**
- Ingen motspørsmål uten klar grunn.`.trim();
    default:
      return `
Vanskelighetsgrad: moderat
- Friksjon: Middels. Du svarer, men trenger litt dytt for å utdype.
- Egen-forslag: Av og til, helst når veileder inviterer.
- Lengde: Åpne → 1–3 setninger. Lukkede → 1 kort setning.`.trim();
  }
}

function topicGuidance(id: TopicId): string {
  switch (id) {
    case 'jobbambivalens':
      return `Tema-ramme: Ønske om jobb vs. bekymring (helse/kapasitet/økonomi/rolle). Hold deg til jobbrelevante grunner/valg.`;
    case 'manglende_oppmøte':
      return `Tema-ramme: struktur/søvn/transport/angst/skam, vilje til endring. Fokus på avtaler/tiltak/skole/arbeid.`;
    case 'redusere_rusbruk':
      return `Tema-ramme: når/hvor/hvorfor, triggere, kontrollforsøk, funksjon i jobb. Ikke medisinske råd.`;
    case 'aggressiv_atferd':
      return `Tema-ramme: utløsere, etterpåklokskap, mestringsønske, konsekvenser. Unngå grafiske detaljer.`;
    default:
      return '';
  }
}

function systemPrompt(
  topicLabel: string,
  topicId: TopicId,
  difficulty: Difficulty,
  assistantTurns: number,
  qtypeHint: 'open' | 'closed' | 'statement'
) {
  const early =
    assistantTurns < 2
      ? `I de første 1–2 svarene: vær litt nølende/utforskende i tonen og hold deg kort–middels. Ikke still spørsmål tilbake, med mindre du må avklare noe helt kort.`
      : `Svar direkte på det jobbkonsulenten nettopp skrev. Ikke ta ledelsen og ikke still spørsmål tilbake unødig.`;

  const qhint =
    qtypeHint === 'open'
      ? `Siste innspill ligner et ÅPENT spørsmål → svar i tråd med vanskelighetsguiden.`
      : qtypeHint === 'closed'
      ? `Siste innspill ligner et LUKKET spørsmål → **hvis vanskelighetsgrad er 'vanskelig', svar med ett ord eller én svært kort setning**; ellers kort.`
      : `Siste innspill er ikke tydelig spørsmål → svar kort–middels og relevant, uten å ta ledelsen.`;

  return `
DU ER JOBBSØKEREN i en norsk MI-øvelse.
Tema: ${topicLabel}.

Rolle og stil:
- Du er jobbsøker (klient), ikke veileder. Svar direkte på siste innspill fra jobbkonsulenten.
- Ikke ta ledelsen i samtalen. Ikke still spørsmål tilbake uten klar grunn.
- Bruk naturlig norsk (bokmål), hverdagslig og respektfullt.
- Unngå metaspråk og punktlister (med mindre du blir bedt om det).

${topicGuidance(topicId)}

${difficultyProfile(difficulty)}

Toning i starten:
- ${early}

Svarform-hint:
- ${qhint}

Faglig:
- Hold deg til temaet. Ikke start nye tema.
- Når veileder bruker OARS, svar relevant og konkret – uten å ta over.
- Egen-forslag følger vanskelighetsprofilen (mest på lett, minst på vanskelig).`.trim();
}

/* ===================== OpenAI ruting ===================== */

function isGpt5(model: string) {
  return /^gpt-5/i.test(model);
}

function extractResponsesText(resp: any): string {
  if (!resp) return '';
  if (typeof resp.output_text === 'string' && resp.output_text.trim()) return resp.output_text;

  if (Array.isArray(resp.output)) {
    const parts: string[] = [];
    for (const item of resp.output) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const val =
            c?.text?.value ??
            c?.text ??
            c?.content ??
            (typeof c?.string === 'string' ? c.string : '');
          if (typeof val === 'string' && val.trim()) parts.push(val);
        }
      }
    }
    const joined = parts.join('\n').trim();
    if (joined) return joined;
  }

  return '';
}

/* ===================== Handler ===================== */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    let { topic, difficulty, transcript } = body as {
      topic?: string;
      difficulty?: string;
      transcript?: ChatMsg[];
    };

    const { id: topicId, label: topicLabel } = normTopic(topic);
    const diff = normDiff(difficulty);
    const conv: ChatMsg[] = Array.isArray(transcript) ? transcript : [];

    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
    if (!apiKey) {
      return NextResponse.json(
        { reply: 'Beklager, mangler API-nøkkel på serveren. Sjekk .env.local (OPENAI_API_KEY).' },
        { status: 500 }
      );
    }

    const assistantTurns = conv.filter(m => m.role === 'assistant').length;

    const tail: ChatMsg[] = conv.slice(-12);
    const lastUser = [...tail].reverse().find(m => m.role === 'user')?.content || '';
    const qtypeHint = classifyQ(lastUser);

    const bootstrapUser: ChatMsg[] =
      tail.length === 0 ? [{ role: 'user', content: 'Hei. (Første melding i samtalen.)' }] : [];

    const client = new OpenAI({ apiKey });

    const messages: ChatMsg[] = [
      { role: 'system', content: systemPrompt(topicLabel, topicId, diff, assistantTurns, qtypeHint) },
      ...bootstrapUser,
      ...tail
    ];

    if (process.env.NODE_ENV !== 'production') {
      console.log('REPLY (model):', model);
      console.log('REPLY messages >>>', JSON.stringify(messages, null, 2));
    }

    let raw = '';

    if (isGpt5(model) && (client as any).responses?.create) {
      const response = await client.responses.create({
        model,
        input: messages,
        reasoning: { effort: 'low' },
        max_output_tokens: 300
      });

      if (process.env.NODE_ENV !== 'production') {
        console.log('RESPONSES RAW OBJECT >>>', JSON.stringify(response, null, 2));
      }

      raw = extractResponsesText(response);

      if ((!raw || !raw.trim()) && (response as any)?.status === 'incomplete') {
        const response2 = await client.responses.create({
          model,
          input: messages,
          reasoning: { effort: 'low' },
          max_output_tokens: 450
        });
        if (process.env.NODE_ENV !== 'production') {
          console.log('RESPONSES RAW OBJECT (retry) >>>', JSON.stringify(response2, null, 2));
        }
        raw = extractResponsesText(response2);
      }
    } else {
      const resp = await client.chat.completions.create({
        model,
        messages: messages as any,
        max_completion_tokens: 220
      });
      if (process.env.NODE_ENV !== 'production') {
        console.log('CHAT COMPLETIONS RAW OBJECT >>>', JSON.stringify(resp, null, 2));
      }
      raw = resp.choices?.[0]?.message?.content ?? '';
    }

    if (!raw.trim()) {
      const fallbackModel = 'gpt-4o-mini';
      try {
        const resp2 = await client.chat.completions.create({
          model: fallbackModel,
          messages: messages as any,
          max_completion_tokens: 220
        });
        raw = resp2.choices?.[0]?.message?.content ?? '';
        if (process.env.NODE_ENV !== 'production') {
          console.log('LLM RAW REPLY (fallback ' + fallbackModel + ') >>>', raw);
        }
      } catch (e) {
        console.error('Fallback to gpt-4o-mini failed:', e);
      }
    } else if (process.env.NODE_ENV !== 'production') {
      console.log('LLM RAW REPLY >>>', raw);
    }

    const reply = minimalPostProcess(raw);
    return NextResponse.json({ reply });
  } catch (e: any) {
    const detail =
      process.env.NODE_ENV !== 'production'
        ? ` [${e?.status ?? ''}] ${e?.message ?? ''} ${JSON.stringify(e?.response?.data || {}, null, 2)}`
        : '';
    console.error('LLM reply error:', {
      name: e?.name,
      message: e?.message,
      status: e?.status,
      data: e?.response?.data
    });
    return NextResponse.json(
      { reply: 'Beklager, noe gikk galt – prøv å sende meldingen på nytt.' + detail },
      { status: 500 }
    );
  }
}