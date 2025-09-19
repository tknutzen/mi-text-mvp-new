// lib/mi_prompt.ts

/* ---------------------------------------------------------
 * Typer og grunnstrukturer
 * --------------------------------------------------------- */
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

/* ---------------------------------------------------------
 * Prompt (norsk) – kun Jobbkonsulent / Jobbsøker
 * --------------------------------------------------------- */
export const MI_KLASSIFISERING_PROMPT_NB = `
Du er en fagfellevurdert ekspert i Motiverende Intervju (MI). Du skal analysere en samtale mellom en jobbkonsulent og en jobbsøker og merke hver ytring fra jobbkonsulenten etter OARS-kategoriene. Formålet er presis og konsistent merking, uten dobbelttelling og med riktig avgrensning per ytring. Returner kun JSON i formatet spesifisert nederst.

Kategorier
1) åpne spørsmål
2) lukkede spørsmål
3) bekreftelser
4) refleksjoner – enkle
5) refleksjoner – komplekse
6) oppsummeringer

Definisjoner
Åpent spørsmål: inviterer til utforsking med hva, hvordan, hvilke, fortell mer, hva tenker du om …, og kan ikke besvares med ja/nei, ett ord, ett tall eller en kort faktabit. Spørsmålstegn er verken nødvendig eller tilstrekkelig. Eksempler: "Hva la du merke til da det fungerte?", "Hvordan vil du gripe det an i uka som kommer?", "Hvilke alternativer ser du nå?"
Lukket spørsmål: kan typisk besvares med ja/nei, et tall, en dato eller en kort avklaring. Inkluderer også modale bekreftelsesspørsmål som "stemmer det at …?". Eksempler: "Kom du deg ut i går?", "Var det tirsdag du hadde samtalen?", "Skal du starte i dag?"
Bekreftelse: eksplisitt og konkret anerkjennelse av innsats, styrker, verdier eller fremgang hos jobbsøkeren. Den peker på observerbar atferd eller verdibasert kvalitet og gjentar ikke innhold som speiling. Eksempler: "Du valgte å prøve selv om det kostet.", "Det er målrettet og modig.", "Du prioriterte søvn selv om det var vanskelig."
Refleksjon – enkel: gjengir eller parafraserer jobbsøkerens innhold uten å legge til ny mening, følelse eller tosidighet. Eksempel: Jobbsøker: "Jeg blir stressa på kvelden." Jobbkonsulent: "Kveldene er stressende."
Refleksjon – kompleks: legger til mening/følelse/tosidighet eller beveger seg ett ledd utover jobbsøkerens ord. Eksempler: "Du kjenner både behov for ro og dragning mot det kjente mønsteret.", "Det høres sårbart ut når det blir stille.", "En del av deg vil forandre, samtidig som en annen del vil holde fast."
Oppsummering: en komprimert, strukturert rekapitulering av tidligere innhold fra samtalen som binder sammen flere elementer (tema, triggere, verdier, tiltak, neste steg). Forekommer typisk i overganger og mot slutten av et tema/økten. Kan signalisere med uttrykk som "for å oppsummere", "så langt har jeg hørt", "hvis jeg forstår deg", men markørord er ikke påkrevd. En oppsummering kan bestå av flere setninger i samme ytring; hele ytringen regnes da som én oppsummering. Høflig hilsen ("takk for samarbeidet") eller motivasjon ("jeg heier på deg") er ikke i seg selv oppsummering, men kan sameksistere i ytringen.

Prioriterings- og avgrensningsregler
A) Én ytring kan ha flere kategorier samtidig med disse begrensningene:
  A1) Oppsummering telles maks én gang per ytring, uansett antall setninger. Ikke del opp en oppsummering i flere når den hører sammen.
  A2) Oppsummering + spørsmål kan sameksistere i samme ytring. Merk oppsummering én gang og spørsmål én gang.
  A3) Spørsmål + refleksjon kan sameksistere i samme ytring. Merk begge hvis begge faktisk forekommer.
  A4) Bekreftelse vs refleksjon: dersom ytringens hovedfunksjon er anerkjennelse av innsats/verdier, merk bekreftelse og ikke refleksjon, selv om ordlyden har et speilende preg. Dersom hovedfunksjonen er speiling/utvidelse av innhold, merk refleksjon (enkel/kompleks) og ikke bekreftelse.
  A5) Enkel vs kompleks refleksjon er gjensidig utelukkende i samme ytring. Velg den mest presise.
B) Deling/segmentering:
  B1) Del aldri en oppsummering i flere innen samme ytring. Hele rekapitulasjonen i ytringen inngår i én oppsummering.
  B2) Ikke merk korte overgangsfraser alene ("ok", "mm", "takk") som bekreftelse eller refleksjon uten egen funksjon.
  B3) Ikke tell avslutningshilsen som oppsummering.
C) Spørsmål:
  C1) Dersom en ytring inneholder både et åpent og et lukket spørsmål, merk begge som true.
  C2) En setning som starter åpent, men lukkes med "er det riktig?" skal telles som lukket i tillegg.
D) Tellelogikk:
  D1) SpørsmålTotalt = åpne + lukkede.
  D2) RefleksjonerTotalt = enkle + komplekse.
  D3) Oppsummeringer = antall ytringer med summary=true.
E) Disambiguering for oppsummering:
  E1) Oppsummering foreligger når minst to av følgende er sanne i samme ytring: binder sammen flere elementer fra tidligere i samtalen; skaper struktur ("så langt", "du nevnte … og …, og du vil …"); leder til overgang eller lukker et tema; fremhever endringssnakk eller beslutning.
  E2) Markørord styrker sannsynligheten, men er ikke nødvendig.
  E3) Ytring med faglig rekapitulering etterfulgt av høflig avslutning skal merkes som én oppsummering for hele rekapitulasjonen.

Korrekte eksempler
1) "Hva vil være et lite første steg du kan teste i kveld?" → open_question=true
2) "Var det tirsdag du ringte NAV?" → closed_question=true
3) "Du holdt avtalen selv om det var tungt." → affirmation=true
4) Jobbsøker: "Jeg utsetter." Jobbkonsulent: "Det blir lett å skyve foran deg." → reflection_simple=true
5) Jobbsøker: "Jeg utsetter." Jobbkonsulent: "En del av deg vil i gang, og samtidig blir det tryggere å vente." → reflection_complex=true
6) "For å oppsummere: du vil ha ro uten å drikke. Du har identifisert triggere og valgt tiltak som matcher. Du starter i dag." → summary=true (én forekomst for hele ytringen). "Jeg heier på deg." kan i tillegg merkes som affirmation=true i samme ytring.

Outputformat
Returner JSON med:
{
  "per_turn": [
    {
      "index": number,
      "speaker": "jobbkonsulent" | "jobbsøker",
      "labels": {
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

Instruksjoner
– Merk kun ytringer fra jobbkonsulent.
– Ikke del opp oppsummering innen samme ytring.
– Ikke dobbelttell bekreftelse som refleksjon hvis hovedfunksjonen er anerkjennelse.
– Vær konsekvent. Returner kun JSON, ingen fritekst.
`

/* ---------------------------------------------------------
 * Inndata til modellen
 * --------------------------------------------------------- */
export function byggAnalyseInndata(transkript: { speaker: Rolle; text: string }[]) {
  const turns = transkript.map((t, i) => ({ index: i, speaker: t.speaker, text: t.text }))
  // Vi sender *kun* transkriptet – prompten over forklarer oppgaven og formatet
  return JSON.stringify({ transcript: turns })
}

/* ---------------------------------------------------------
 * Etterprosessering: robust, én oppsummering per ytring
 * + disambiguering bekreftelse vs refleksjon
 * --------------------------------------------------------- */

function _norm(s: string) { return (s || "").toLowerCase().trim() }
function _hasAffirmationCue(txt: string) {
  const t = _norm(txt)
  // Typiske anerkjennelses-/styrke-ord og mønstre
  return /(bra|flott|sterkt|imponerende|fint|godt jobbet|målrettet|modig|klokt|nyttig|du valgte|du prioriterte|du holdt|du prøvde|takk for innsatsen)/i.test(t)
}
function _hasReflectionCue(txt: string) {
  const t = _norm(txt)
  // Vanlige speilings-/metaspråkmarkører
  return /(du sier|du opplever|høres.*ut|virker som|på den ene siden|samtidig som|det betyr at|det høres .* ut)/i.test(t)
}
function _hasSummaryCue(txt: string) {
  const t = _norm(txt)
  return /(for å oppsummere|for å summere|oppsummert|kort sagt|så langt har jeg hørt|hvis jeg forstår deg|med andre ord)/i.test(t)
}
function _looksLikeMultiElementRecap(txt: string) {
  // Grovt mål: flere komma/semikolon/punktum + «og»/listepreg + beslutning/neste steg
  const t = txt.trim()
  const items = t.split(/[.;·•–—]/).filter(s => s.trim().length > 0).length
  const hasAnd = /\bog\b/i.test(t)
  const hasDoOrPlan = /(du vil|du skal|neste steg|starter i dag|planen er|tiltak)/i.test(t)
  // Minst to setningsbiter + litt struktur
  return (items >= 2 && (hasAnd || hasDoOrPlan))
}
function _isLikelySummary(txt: string) {
  return _hasSummaryCue(txt) || _looksLikeMultiElementRecap(txt)
}
function _isTrailingQuestion(txt: string) {
  // Tillat at ytring ender i et spørsmål etter oppsummeringen, uten å skape ny oppsummering
  return /[?？]\s*$/.test(txt.trim())
}
function _startsOpen(txt: string) {
  return (/^\s*(hva|hvordan|hvilke|fortell|kan du fortelle|hva tenker du)/i).test(txt.trim())
}

export function etterbehandleKlassifisering(transkript: RåYtring[], svar: KlassifiseringSvar): KlassifiseringSvar {
  const byIndex = new Map<number, RåYtring>()
  for (const y of transkript) byIndex.set(y.index, y)

  const rader: KlassifiseringRad[] = []

  for (const rad of (svar?.per_turn || [])) {
    const y = byIndex.get(rad.index)
    if (!y) continue
    if (y.speaker !== "jobbkonsulent") continue

    // Start med det modellen ga
    const l = { ...rad.labels }

    // 1) Enkel vs kompleks refleksjon – gjensidig utelukkende (prioriter kompleks)
    if (l.reflection_simple && l.reflection_complex) {
      l.reflection_simple = false
    }

    // 2) Bekreftelse vs refleksjon – bruk hovedfunksjon i teksten
    //    (a) hvis tydelig anerkjennelse uten klare speilingstegn → bekreftelse
    //    (b) hvis tydelig speiling/utvidelse uten anerkjennelse → refleksjon
    //    (c) hvis begge, prioriter bekreftelse *hvis ytringen primært roser innsats/verdier*,
    //        ellers refleksjon (behold kompleks hvis markert)
    const txt = y.text || ""
    const hasAff = _hasAffirmationCue(txt)
    const hasRefl = _hasReflectionCue(txt)

    if (l.affirmation && (l.reflection_simple || l.reflection_complex)) {
      if (hasAff && !hasRefl) {
        l.reflection_simple = false
        l.reflection_complex = false
        l.affirmation = true
      } else if (hasRefl && !hasAff) {
        l.affirmation = false
      } else {
        // Begge til stede i tekst: vurder retning
        if (hasAff && !l.reflection_complex) {
          // Heller mot bekreftelse, dropp enkel refleksjon
          l.reflection_simple = false
        } else if (hasRefl && !hasAff) {
          l.affirmation = false
        }
      }
    }

    // 3) Oppsummering – maks én per ytring.
    //    Hvis modellen ikke fanget opp, men teksten sannsynligvis er oppsummering → sett summary=true.
    //    Tillat samtidig spørsmål på slutten (åpent/lukket).
    if (l.summary) {
      l.summary = true // maks én per ytring er implisitt i booleansk modell
    } else if (_isLikelySummary(txt)) {
      l.summary = true
    }

    // 4) Åpent vs lukket – bevar begge hvis begge faktisk forekommer.
    //    Hvis modellen har begge, men ytringen starter helt åpent og ikke slutter med «er det …?»,
    //    så kan vi la begge stå (reglen i prompten sier at begge kan sameksistere).
    if (l.open_question && l.closed_question) {
      const primærtÅpent = _startsOpen(txt)
      const harLukkersuffix = /[.!?]\s*(er det|stemmer det|ikke sant)\??\s*$/i.test(txt)
      // Bevar begge – men om den ser klart åpen uten lukkersuffix, dropp lukket
      if (primærtÅpent && !harLukkersuffix) {
        l.closed_question = false
      }
    }

    // 5) Hvis både summary og spørsmål finnes: behold begge (A2).
    //    Hvis oppsummeringen avsluttes med et spørsmål i halen, lar vi det stå.
    if (l.summary && _isTrailingQuestion(txt)) {
      // Ingen endring – kun dokumentert at dette er lov
    }

    rader.push({
      index: y.index,
      speaker: y.speaker,
      labels: {
        open_question: !!l.open_question,
        closed_question: !!l.closed_question,
        affirmation: !!l.affirmation,
        reflection_simple: !!l.reflection_simple,
        reflection_complex: !!l.reflection_complex,
        summary: !!l.summary
      }
    })
  }

  return { per_turn: rader }
}

/* ---------------------------------------------------------
 * Tellinger – én oppsummering per ytring
 * --------------------------------------------------------- */
export function tellingerFraKlassifisering(svar: KlassifiseringSvar) {
  let aapne = 0, lukkede = 0, bekreftelser = 0, reflEnkel = 0, reflKompleks = 0, oppsummeringer = 0

  for (const r of (svar?.per_turn || [])) {
    if (r.speaker !== "jobbkonsulent") continue
    const l = r.labels || ({} as KlassifiseringEtiketter)

    if (l.open_question) aapne++
    if (l.closed_question) lukkede++
    if (l.affirmation) bekreftelser++

    // Enkel og kompleks er gjensidig utelukkende (sikret i etterbehandling),
    // men om begge skulle være true (uventet), prioriter kompleks og tell kun den.
    if (l.reflection_complex) {
      reflKompleks++
    } else if (l.reflection_simple) {
      reflEnkel++
    }

    if (l.summary) oppsummeringer++ // maks 1 per ytring, slik vi ønsker
  }

  const spørsmålTotalt = aapne + lukkede
  const refleksjonerTotalt = reflEnkel + reflKompleks

  return {
    aapne,
    lukkede,
    bekreftelser,
    refleksjonEnkel: reflEnkel,
    refleksjonKompleks: reflKompleks,
    refleksjonerTotalt,
    oppsummeringer,
    spørsmålTotalt
  }
}