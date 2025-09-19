// lib/mi_prompt.ts
export type Rolle = "jobbkonsulent" | "jobbsøker"

export type RåYtring = {
  index: number
  speaker: Rolle
  text: string
}

export type KlassifiseringEtiketter = {
  open_question: boolean
  closed_question: boolean
  affirmation: boolean
  reflection_simple: boolean
  reflection_complex: boolean
  summary: boolean
}

export type KlassifiseringRad = {
  index: number
  speaker: Rolle
  labels: KlassifiseringEtiketter
}

export type KlassifiseringSvar = {
  per_turn: KlassifiseringRad[]
}

/* ---------- PROMPT-STRICT (som før, men med «tur» + tydelig anti-splitting) ---------- */
export const MI_KLASSIFISERING_PROMPT_NB_STRICT = `
Du analyserer en samtale mellom en jobbkonsulent og en jobbsøker. Merk hver TUR fra jobbkonsulenten i OARS-kategorier. Returner KUN gyldig JSON (se format).

Kategorier: åpne spørsmål, lukkede spørsmål, bekreftelser, refleksjoner – enkle, refleksjoner – komplekse, oppsummeringer.

Kjerneprinsipper (viktige):
- Én TUR kan inneholde flere kategorier, men:
  • Oppsummering TELLES MAKS ÉN GANG per tur, selv om den består av flere setninger. DEL ALDRI opp en oppsummering innen samme tur.
  • Oppsummering “vinner” over refleksjoner i samme tur (refleksjon=false hvis summary=true). Spørsmål kan sameksistere.
  • Enkel vs. kompleks refleksjon er gjensidig utelukkende.
  • Bekreftelse vs. refleksjon: hvis hovedfunksjonen er å anerkjenne, velg bekreftelse (refleksjon=false).

Definisjoner (kort):
- Åpent: inviterer til utforsking (hva/hvordan/hvilke/«fortell mer…»), ikke ja/nei.
- Lukket: ja/nei, kort faktum, tall/dato, bekreftelsesspørsmål («stemmer det…?»).
- Bekreftelse: tydelig anerkjennelse av innsats/verdier/fremgang.
- Refleksjon enkel: parafrase uten ny mening/følelse/tosidighet.
- Refleksjon kompleks: legger til mening/følelse/tosidighet (f.eks. «på den ene siden … samtidig …»).
- Oppsummering: komprimert rekapitulasjon som binder flere elementer (tema, triggere, tiltak, neste steg). Markerord («for å oppsummere») kan forekomme, men er ikke påkrevd. En hel tur med rekapitulering = ÉN oppsummering.

Eksempel (oppsummering i én tur):
«For å oppsummere: du vil ha ro uten å drikke. Du har identifisert triggere … Du starter i dag. Jeg heier på deg.» → summary=true (én gang for hele turen), affirmation kan også være true hvis det er reell anerkjennelse.

Outputformat (KUN JSON):
{
  "per_turn":[
    {
      "index": number,
      "speaker": "jobbkonsulent" | "jobbsøker",
      "labels":{
        "open_question": boolean,
        "closed_question": boolean,
        "affirmation": boolean,
        "reflection_simple": boolean,
        "reflection_complex": boolean,
        "summary": boolean
      }
    }
  ]
}
— Merk KUN turer fra jobbkonsulent. Ingen fritekst i svaret.
`

/* ---------- PROMPT-LITE (mer spillerom, færre regler) ---------- */
export const MI_KLASSIFISERING_PROMPT_NB_LITE = `
Du analyserer en samtale mellom jobbkonsulent og jobbsøker. Merk hver TUR fra jobbkonsulenten i OARS-kategorier. Vær praktisk og konsistent, men bruk faglig skjønn. Returner KUN gyldig JSON.

Kategorier:
- open_question: åpne spørsmål (hva/hvordan/hvilke/«fortell …», ikke ja/nei).
- closed_question: ja/nei/kort faktum (inkl. «stemmer det …?»).
- affirmation: eksplisitt anerkjennelse av innsats/verdier/fremgang.
- reflection_simple: parafrase uten ny mening/følelse/tosidighet.
- reflection_complex: mening/følelse/tosidighet/«ett hakk videre».
- summary: rekapitulasjon som binder sammen flere elementer i samtalen. Hele turen telles som én oppsummering dersom det er en tydelig rekapitulasjon (selv over flere setninger).

Praktiske retningslinjer:
- Oppsummering: tell maks én per tur.
- Oppsummering kan sameksistere med spørsmål.
- Enkel/kompleks refleksjon: velg én (den mest presise).
- Bekreftelse vs. refleksjon: velg hovedfunksjonen (ikke begge uten grunn).

Outputformat (KUN JSON med per_turn[index,speaker,labels]).
Ingen forklaringer.
`

/* ---------- Inndata ---------- */
export function byggAnalyseInndata(transkript: { speaker: Rolle; text: string }[]) {
  const turns = transkript.map((t, i) => ({ index: i, speaker: t.speaker, text: t.text }))
  return JSON.stringify({ transcript: turns })
}

/* ---------- Etterbehandling (konfliktløsning + oppsummering én per tur) ---------- */
export function etterbehandleKlassifisering(transkript: RåYtring[], svar: KlassifiseringSvar): KlassifiseringSvar {
  const byIndex = new Map<number, RåYtring>()
  for (const t of transkript) byIndex.set(t.index, t)

  const out: KlassifiseringRad[] = []

  for (const row of (svar.per_turn || [])) {
    const orig = byIndex.get(row.index)
    if (!orig || orig.speaker !== "jobbkonsulent") continue

    const L: KlassifiseringEtiketter = { ...row.labels }
    const txt = (orig.text || "").toLowerCase()

    // enkel vs kompleks – gjensidig
    if (L.reflection_simple && L.reflection_complex) {
      const complexHints = /på den ene siden|samtidig som|både.*og|føles|kjennes|sår|tøft|vanskelig|ambivalens|verdier|behov|mening/.test(txt)
      if (complexHints) L.reflection_simple = false
      else L.reflection_complex = false
    }

    // bekreftelse vs refleksjon – velg hovedfunksjon
    if (L.affirmation && (L.reflection_simple || L.reflection_complex)) {
      const affirmHints = /(bra|flott|sterkt|imponerende|fint|godt jobbet|målrettet|modig|du valgte|du prioriterte|du holdt|du gjennomførte|heier på deg)/.test(txt)
      const mirrorHints  = /(du sier|du opplever|høres|virker som|på den ene siden|samtidig som|du kjenner|du står i)/.test(txt)
      if (affirmHints && !mirrorHints) {
        L.reflection_simple = false; L.reflection_complex = false
      } else if (mirrorHints && !affirmHints) {
        L.affirmation = false
      } else {
        // blandet: ta den som forekommer mest
        const aCount = (txt.match(/(bra|flott|sterkt|imponerende|fint|godt jobbet|målrettet|modig|du valgte|du prioriterte|du holdt|du gjennomførte|heier på deg)/g) || []).length
        const rCount = (txt.match(/(du sier|du opplever|høres|virker som|på den ene siden|samtidig som|du kjenner|du står i)/g) || []).length
        if (aCount > rCount) { L.reflection_simple = false; L.reflection_complex = false } else { L.affirmation = false }
      }
    }

    // oppsummering vinner over refleksjoner (men spørsmål kan sameksistere)
    if (L.summary) { L.reflection_simple = false; L.reflection_complex = false }

    out.push({ index: orig.index, speaker: "jobbkonsulent", labels: L })
  }

  return { per_turn: out }
}

/* ---------- Tellinger ---------- */
export function tellingerFraKlassifisering(svar: KlassifiseringSvar) {
  let aapne = 0, lukkede = 0, bekreftelser = 0, reflEnkel = 0, reflKompleks = 0, oppsummeringer = 0
  for (const r of (svar.per_turn || [])) {
    if (r.speaker !== "jobbkonsulent") continue
    if (r.labels.summary) oppsummeringer++
    else {
      if (r.labels.reflection_simple) reflEnkel++
      if (r.labels.reflection_complex) reflKompleks++
    }
    if (r.labels.affirmation) bekreftelser++
    if (r.labels.open_question) aapne++
    if (r.labels.closed_question) lukkede++
  }
  const spørsmålTotalt = aapne + lukkede
  const refleksjonerTotalt = reflEnkel + reflKompleks
  return { aapne, lukkede, bekreftelser, refleksjonEnkel: reflEnkel, refleksjonKompleks: reflKompleks, refleksjonerTotalt, oppsummeringer, spørsmålTotalt }
}