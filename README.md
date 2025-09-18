# MI Text MVP — minimal webapp (chat + OARS + report + Moodle-embed)

En superenkel mal som lar studenter øve MI via tastatur, teller OARS,
lager en enkel rapport, og kan embeddes i Moodle (som URL eller iframe).

## Hva du får
- Chat-side (student ↔ "Klient")
- Velg **tema** og **vanskelighetsgrad**
- Automatisk OARS-heuristikk (åpne/lukkede spørsmål, refleksjoner, bekreftelser, oppsummeringer)
- Enkelt analyse-endepunkt (kan bruke OpenAI for tema/rapportforbedring)
- HTML-rapport (kan lastes ned som `.html` eller printes til PDF)
- Klar for Moodle-embed (bruk appens URL)

---

## 0) Forutsetninger
- Node.js 18+ installert (sjekk: `node -v`)
- En teksteditor (VS Code er fint)
- (Valgfritt) OpenAI API-nøkkel for bedre tema/rapport: https://platform.openai.com/

## 1) Last ned og start
1. Pakk ut denne mappen `mi-text-mvp` et passende sted.
2. I terminal: gå inn i mappen
   ```bash
   cd mi-text-mvp
   npm install
   ```
3. Lag `.env.local` ved å kopiere eksempelfilen:
   ```bash
   cp .env.example .env.local
   ```
   - Hvis du har OpenAI-nøkkel: fyll inn `OPENAI_API_KEY=...`
   - Hvis ikke, la den være tom — appen kjører likevel (da brukes bare heuristikk).
4. Start utviklingsserver:
   ```bash
   npm run dev
   ```
5. Åpne http://localhost:3000 i nettleseren.

## 2) Bruk appen
1. Velg **Tema** og **Vanskelighetsgrad**, trykk **Start økt**.
2. Skriv din første melding i chatten. (Du er veilederen. Den "Klient" svarer.)
3. Når du er ferdig: trykk **Avslutt økt & lag rapport**.
4. Rapporten vises under; last ned som HTML (eller print til PDF i nettleseren).

## 3) Embed i Moodle (enkel variant)
- I kurset: *Add an activity or resource* → **URL** (eller **Page** → HTML med `<iframe>`).
- URL: bruk adressen til appen når den er publisert (f.eks. Vercel/Azure).
- Alternativ: Lim inn `<iframe src="https://din-app-url" width="100%" height="900"></iframe>` i Moodle Page.

## 4) Publisere (valgfritt)
- **Vercel**: logg inn, "Add New Project", pek på dette repoet, Deploy.
- **Azure App Service**: `npm run build` → publiser `/.next` via guide i Azure.

## 5) Hvordan OARS teller (heuristikk)
- Åpne spørsmål: setning med `?` som starter med `hva`, `hvordan`, `hvilke`, `hvilken`, `hvem`, `fortell`, `beskriv`, `på hvilke måter`, `kan du si mer`.
- Lukkede spørsmål: `?` men ikke matcher åpen-spørsmål-startene.
- Refleksjon (enkel): fraser som `høres ut som`, `virker som`, `om jeg forstår deg rett`, `så det du sier er`, `du sier/tenker/kjenner/opplever at`.
- Refleksjon (kompleks): som over + tilfører/fremkaller mening (markører som `fordi`, `det kan ha sammenheng med`, `som kan bety at`).
- Bekreftelser: `imponerende`, `sterkt gjort`, `bra at du`, `det krever mot`, `du har jobbet hardt`, `fint at du`.
- Oppsummeringer: `for å oppsummere`, `la meg oppsummere`, `så langt har jeg hørt`, `hvis jeg har forstått`, `vi har snakket om`.

> Heuristikken kan gi feil innimellom. Derfor har vi et analyse-endepunkt som
> (valgfritt) ber en LLM verifisere/korrigere og identifisere **temaer** og
> **endringssnakk/sustain talk**.

## 6) Prompter (kopiér/lim inn)

### 6.1 Systemprompt — *Klientens atferd (MI)*
Brukes i `app/api/reply/route.ts` (LLM-svar).

> Du er *Klient* i en MI-øvelse på norsk. Tema: **{tema}**. Vanskelighetsgrad: **{lett/moderat/vanskelig}**.  
> Oppførsel:  
> – Vis ambivalens; bland sustain- og endringssnakk i tråd med nivået.  
> – Svar **kort (2–4 setninger)**. Del mer når veilederen bruker åpne spørsmål/refleksjoner.  
> – Ikke gi råd uoppfordret. Ikke vurder veilederen.  
> – Endre tema bare når det oppstår naturlig.  
> – Avslutt når veilederen oppsummerer og foreslår neste steg.

### 6.2 Systemprompt — *Analytiker (MITI/OARS+tema)*
Brukes i `app/api/analyze/route.ts` (LLM-verifisering). Gi transkripsjon og heuristikk-tall.

> Du er en MI-analytiker. Analyser en norsk tekstbasert MI-øvelse (veileder ↔ klient).  
> Oppgaver: verifiser/koriger OARS-telling (åpne/lukkede spørsmål, enkle/komplekse refleksjoner, bekreftelser, oppsummeringer), identifiser temaer per **veileder-tur**, vurder lengde (ord og turer), finn eksempler på **endringssnakk** og **sustain talk** i klientens svar, og sett globale MITI-lignende skårer (1–5) for *partnership, empathy, cultivating change talk, softening sustain talk*.  
> Returnér **kun** gyldig JSON i skjemaet nedenfor, uten ekstra tekst.

```json
{
  "counts": {
    "open_questions": 0,
    "closed_questions": 0,
    "reflections_simple": 0,
    "reflections_complex": 0,
    "affirmations": 0,
    "summaries": 0
  },
  "ratios": {
    "open_question_share": 0.0,
    "reflection_to_question": 0.0,
    "complex_reflection_share": 0.0
  },
  "topics": {
    "by_turn": [{"turnIndex": 0, "topic": "søvn"}],
    "unique_topics": ["søvn"],
    "topic_shifts": 0
  },
  "length": {
    "student_turns": 0,
    "total_words_student": 0,
    "total_words_client": 0,
    "total_words_all": 0,
    "flags": ["ok"]
  },
  "client_language": {
    "change_talk_examples": [],
    "sustain_talk_examples": []
  },
  "global_scores": {
    "partnership": 3,
    "empathy": 3,
    "cultivating_change_talk": 3,
    "softening_sustain_talk": 3
  },
  "feedback": {
    "strengths": [],
    "improvements": [],
    "next_exercises": []
  }
}
```

### 6.3 Vekting/poeng (kan endres i `lib/report.ts`)
- OARS-kvalitet 60 %: åpne% (20), R:Q (20), kompleks% (10), bekreftelser (5), oppsummeringer (5)
- Struktur 25 %: tema (10), tema-oppsummering (10), lengde (5)
- MI-påvirkning 15 %: change vs sustain (kvalitativ indikasjon)

## 7) Filstruktur
```
mi-text-mvp/
  app/
    api/
      reply/route.ts         # genererer klientsvar (LLM). Har fallback hvis ingen OPENAI_API_KEY
      analyze/route.ts       # verifiserer/beriker analyse (LLM). Fallback til heuristikk-only
    globals.css
    page.tsx                 # UI: chat + kontroller + rapport
  lib/
    oars.ts                  # heuristikk for OARS
    report.ts                # lager HTML-rapport + poengberegning
    types.ts                 # felles typer
  public/
    logo.png
  .env.example
  next.config.mjs
  package.json
  tsconfig.json
```

## 8) Neste steg
- Pilotér med 5–10 studenter og justér terskler i `report.ts`.
- Når stabilt: publisér, embed i Moodle.
- Senere kan du bytte ut tekst med tale (Azure Speech) og avatar.

Lykke til! ✨
