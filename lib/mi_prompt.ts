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

/* ---------- Systemprompt (forbedret — bruker «tur» konsekvent) ---------- */
export const MI_KLASSIFISERING_PROMPT_NB = `
Du er en fagfellevurdert ekspert i Motiverende Intervju (MI). Du analyserer en samtale mellom en jobbkonsulent og en jobbsøker og skal merke hver tur fra jobbkonsulenten etter OARS-kategoriene. Målet er presis, konsistent merking uten dobbelttelling. Returner KUN gyldig JSON i formatet som spesifiseres nederst (uten forklaringer).

Kategorier
1) åpne spørsmål
2) lukkede spørsmål
3) bekreftelser
4) refleksjoner – enkle
5) refleksjoner – komplekse
6) oppsummeringer

Definisjoner
Åpent spørsmål: inviterer til utforsking (hva, hvordan, hvilke, «fortell mer …» osv.), og kan ikke besvares med ja/nei, ett ord, ett tall eller en kort faktabit. Spørsmålstegn er verken nødvendig eller tilstrekkelig.
Lukket spørsmål: kan typisk besvares med ja/nei, ett ord, tall/dato eller kort avklaring. Inkluderer bekreftelses-/kontrollspørsmål (f.eks. «stemmer det at …?»).
Bekreftelse: eksplisitt og konkret anerkjennelse av innsats, styrker, verdier eller fremgang hos jobbsøkeren. Hovedfunksjonen er å anerkjenne (ikke å speile).
Refleksjon – enkel: speiler/parafraserer jobbsøkerens innhold uten å legge til ny mening, følelse eller tosidighet.
Refleksjon – kompleks: tilføyer mening/følelse/tosidighet eller går ett ledd utover jobbsøkerens ord (f.eks. dobbelsidig refleksjon, emosjon/verdier/fortolkning).
Oppsummering: en strukturert, komprimert rekapitulering av tidligere innhold i samtalen som binder sammen flere elementer (tema, triggere, verdier, tiltak, neste steg). Typisk ved overganger og slutten av tema/økt. Markørord (f.eks. «for å oppsummere») kan forekomme, men er ikke nødvendige. En oppsummering kan bestå av flere setninger i samme tur; HELE turen telles da som ÉN oppsummering.

Prioriterings- og avgrensningsregler (svært viktige)
A) Én tur kan ha flere kategorier samtidig, men:
  A1) Oppsummering telles maks én gang per tur (selv om den består av flere setninger). DEL ALDRI oppsummering i flere innen samme tur.
  A2) Hvis en tur er oppsummering, teller den som oppsummering og IKKE som refleksjon (enkel/kompleks). Oppsummering + spørsmål kan sameksistere (begge settes true).
  A3) Enkel vs. kompleks refleksjon er gjensidig utelukkende i samme tur. Velg den mest presise (kompleks hvis kriteriene er oppfylt).
  A4) Bekreftelse vs. refleksjon: dersom hovedfunksjonen er å ANERKJENNE (mestring, innsats, verdier), merk bekreftelse=true og refleksjon=false (både enkel og kompleks). Dersom hovedfunksjonen er speiling/utvidelse av innhold, merk refleksjon (enkel eller kompleks) og bekreftelse=false.
B) Segmentering:
  B1) Ikke tell korte fyll- eller høflighetsfraser alene («ok», «mm», «takk») som bekreftelse/refleksjon.
  B2) Høflig avslutning («takk for godt samarbeid», «jeg heier på deg») i samme tur som en rekapitulering gjør turen til ÉN oppsummering (affirmation kan også settes true dersom det faktisk er en anerkjennelse).
C) Spørsmål:
  C1) En tur kan inneholde både åpent og lukket spørsmål; sett begge til true i så fall.
  C2) En setning som starter åpent men lukkes med en bekreftelse/kontroll («er det riktig?») gir både open_question=true og closed_question=true.
D) Telling:
  D1) SpørsmålTotalt = åpne + lukkede.
  D2) RefleksjonerTotalt = enkle + komplekse.
  D3) Oppsummeringer = antall turer med summary=true.
E) Oppsummering bestemmes slik:
  E1) Oppsummering foreligger når minst to av disse er sanne i samme tur: (i) binder sammen flere tidligere elementer; (ii) bruker struktur- eller overgangsknyttere («så langt», «du nevnte … og …, og du vil …»); (iii) markerer skifte/avslutning; (iv) fremhever endringssnakk/valg/neste steg.
  E2) Markørord øker sannsynlighet, men er ikke nødvendig.
  E3) En hel tur som rekapitulerer flere punkter telles som ÉN oppsummering, selv hvis oppsummeringen består av flere setninger. Ikke del den i flere.

Eksempler (konsise)
– «Hva vil være et lite første steg i kveld?» → open_question=true
– «Var det tirsdag du ringte NAV?» → closed_question=true
– «Du holdt avtalen selv om det var tungt.» → affirmation=true
– Jobbsøker: «Jeg utsetter.» Jobbkonsulent: «Det blir lett å skyve foran deg.» → reflection_simple=true
– Jobbsøker: «Jeg utsetter.» Jobbkonsulent: «En del av deg vil i gang, samtidig som det kjennes tryggere å vente.» → reflection_complex=true
– «For å oppsummere: du vil ha ro uten å drikke. Du har identifisert triggere og valgt tiltak som matcher. Du starter i dag. Jeg heier på deg.» → summary=true (én oppsummering for hele turen), affirmation=true kan også være true i samme tur.

Outputformat (KUN JSON)
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
– Merk KUN turer fra jobbkonsulent.
– Ikke del oppsummering i flere innen samme tur.
– Oppsummering «vinner» over refleksjoner (refleksjoner=false hvis summary=true). Spørsmål kan sameksistere.
– Bekreftelse og refleksjon er gjensidig utelukkende; velg den som best beskriver hovedfunksjonen.
– Vær konsistent. Returner KUN gyldig JSON-objekt, ingen fritekst.
`

/* ---------- Inndata til modellen ---------- */
export function byggAnalyseInndata(transkript: { speaker: Rolle; text: string }[]) {
  const turns = transkript.map((t, i) => ({ index: i, speaker: t.speaker, text: t.text }))
  return JSON.stringify({ transcript: turns })
}

/* ---------- Etterbehandling (streng konfliktløsning + «oppsummering én per tur») ---------- */
export function etterbehandleKlassifisering(transkript: RåYtring[], svar: KlassifiseringSvar): KlassifiseringSvar {
  const byIndex = new Map<number, RåYtring>()
  for (const t of transkript) byIndex.set(t.index, t)

  const out: KlassifiseringRad[] = []

  for (const row of (svar.per_turn || [])) {
    const orig = byIndex.get(row.index)
    if (!orig || orig.speaker !== "jobbkonsulent") continue

    const L: KlassifiseringEtiketter = { ...row.labels }

    const txtRaw = (orig.text || "")
    const txt = txtRaw.toLowerCase()

    // Heuristisk «failsafe»: hvis LLM glemmer å merke tydelig oppsummering, aktiver summary
    const summaryMarkers = /(for å oppsummere|la meg oppsummere|så langt har jeg hørt|hvis jeg forstår deg|for å binde sammen)/i
    const looksLikeMultiRecap =
      (txtRaw.split(/[.!?；;]+/).filter(s => s.trim().length > 0).length >= 2) &&
      /(du (?:har|nevnte|vil)|tiltak|neste steg|fremover|oppsummer)/i.test(txtRaw)

    if (!L.summary && (summaryMarkers.test(txtRaw) || looksLikeMultiRecap)) {
      L.summary = true
    }

    // 1) Enkel vs kompleks refleksjon — gjensidig utelukkende
    if (L.reflection_simple && L.reflection_complex) {
      const harTosidighet = /på den ene siden|samtidig som|både.*og/.test(txt)
      const harFølelseMening =
        /(sårt|sårbart|vanskelig|tøft|urolig|rolig|stolt|modig|målrettet|betyr mye|viktig for deg|du kjenner|du står i)/.test(txt)
      if (harTosidighet || harFølelseMening) {
        L.reflection_simple = false
      } else {
        L.reflection_complex = false
      }
    }

    // 2) Bekreftelse vs refleksjon — velg hovedfunksjon (gjensidig utelukkende)
    if (L.affirmation && (L.reflection_simple || L.reflection_complex)) {
      const praiseLike =
        /(bra|flott|sterkt|imponerende|fint|godt jobbet|målrettet|modig|stått i det|du valgte|du prioriterte|du holdt|du gjennomførte|det er sterkt|det er modig)/.test(
          txt
        )
      const mirroringLike =
        /(du sier|du opplever|det høres|høres .* ut|virker som|du kjenner|du står i|på den ene siden|samtidig som)/.test(
          txt
        )

      if (praiseLike && !mirroringLike) {
        L.reflection_simple = false
        L.reflection_complex = false
      } else if (mirroringLike && !praiseLike) {
        L.affirmation = false
      } else {
        // blandet – velg dominerende mønster
        const lenPraise = (txt.match(/(bra|flott|sterkt|imponerende|fint|godt jobbet|målrettet|modig|du valgte|du prioriterte|du holdt|du gjennomførte)/g) || []).length
        const lenMirror = (txt.match(/(du sier|du opplever|høres|virker som|på den ene siden|samtidig som)/g) || []).length
        if (lenPraise > lenMirror) {
          L.reflection_simple = false
          L.reflection_complex = false
        } else {
          L.affirmation = false
        }
      }
    }

    // 3) Oppsummering «vinner» over refleksjoner (men spørsmål kan sameksistere)
    if (L.summary) {
      // Sørg for at oppsummering er én per tur (ikke del i flere)
      L.reflection_simple = false
      L.reflection_complex = false
    }

    // 4) Åpent + lukket samtidig – behold begge (C1), men gjør liten avklaring for «primært åpent»
    if (L.open_question && L.closed_question) {
      const starterÅpent = /^(hva|hvordan|hvilke|fortell|kan du fortelle|hva tenker du)/i.test(txtRaw.trim())
      const harKontrollhale = /[.!?]\s*(er det|stemmer det|ikke sant)\??\s*$/i.test(txtRaw)
      if (starterÅpent && !harKontrollhale) {
        // behold begge som true (regel C1) – ingen endring
      }
    }

    // 5) Ikke gi summary mer enn én gang per tur (kommer per turn allerede – vi sikrer likevel)
    if (L.summary) {
      L.summary = true
    }

    out.push({ index: orig.index, speaker: "jobbkonsulent", labels: L })
  }

  return { per_turn: out }
}

/* ---------- Tellinger (robust) ---------- */
export function tellingerFraKlassifisering(svar: KlassifiseringSvar) {
  let aapne = 0
  let lukkede = 0
  let bekreftelser = 0
  let reflEnkel = 0
  let reflKompleks = 0
  let oppsummeringer = 0

  for (const r of (svar.per_turn || [])) {
    if (r.speaker !== "jobbkonsulent") continue

    // summary teller alltid bare én (og «vinner» over refleksjoner i tallene)
    if (r.labels.summary) {
      oppsummeringer++
    } else {
      if (r.labels.reflection_simple) reflEnkel++
      if (r.labels.reflection_complex) reflKompleks++
    }

    if (r.labels.affirmation) bekreftelser++
    if (r.labels.open_question) aapne++
    if (r.labels.closed_question) lukkede++
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