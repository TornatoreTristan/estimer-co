/**
 * Normalisation et dédoublonnage DVF — spec §3.1, Annexe A.1 à A.3.
 *
 * **Module purement fonctionnel** : aucun accès base, aucun appel réseau,
 * aucune horloge implicite. C'est la condition pour tester l'intégralité des
 * règles d'ingestion sans monter d'infrastructure, et pour pouvoir réviser un
 * seuil sans redéployer.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LE PIÈGE CENTRAL DE DVF
 * ─────────────────────────────────────────────────────────────────────────
 * Dans le CSV, **une ligne = un lot / local / parcelle**, pas une vente. Une
 * même mutation s'étale sur plusieurs lignes et `valeur_fonciere` y est
 * **répétée à l'identique**. Sommer naïvement les lignes gonfle les prix d'un
 * facteur 2 à 4, sans que rien ne le signale.
 *
 * Exemple réel, fichier 2025 de la Creuse (23), mutation `2025-249966` :
 *   ligne 1 : Maison, 66 m², valeur_fonciere = 119 500, culture « sols »
 *   ligne 2 : (pas de type_local), valeur_fonciere = 119 500, culture « landes »
 * → une seule vente à 119 500 €, pas deux.
 *
 * Sur ce même fichier, 400 mutations portent 2 lignes bâties et 64 en portent
 * 3 : les rejeter en bloc (règle initiale du §6.2) écarterait ~23 % des
 * mutations bâties, et bien davantage en zone urbaine où un appartement se
 * vend presque toujours avec une cave ou un parking. D'où la règle corrigée
 * de l'Annexe A.1, appliquée ici.
 */

import type { DvfRawRow } from '#dvf/csv_columns'

/* ══════════════════════════════════════════════════════════════════════════
 * Types
 * ════════════════════════════════════════════════════════════════════════ */

/** Motifs de rejet, comptabilisés dans `dvf_imports.rejected_counts`. */
export type RejectionReason =
  | 'nature_non_vente'
  | 'aucun_local_bati'
  | 'multi_type'
  | 'type_local_non_retenu'
  | 'surface_hors_bornes'
  | 'surface_absente'
  | 'valeur_absente'
  | 'valeur_symbolique'
  | 'prix_hors_bornes'
  | 'geolocalisation_absente'
  | 'date_invalide'
  | 'code_insee_absent'

/** Type de bien retenu pour la valorisation. */
export type PropertyType = 'appartement' | 'maison'

/** Mutation normalisée, prête à être insérée. */
export interface NormalizedMutation {
  dedupKey: string
  idMutation: string
  dateMutation: string
  natureMutation: string
  valeurFonciere: number
  typeLocal: PropertyType
  surfaceBati: number
  nbPieces: number | null
  surfaceTerrain: number
  nbLocaux: number
  nbDependances: number
  codeInsee: string
  codeDepartement: string
  adresseVoie: string | null
  codePostal: string | null
  longitude: number
  latitude: number
  prixM2: number
  isOutlier: boolean
  exclusionReason: string | null
  geolocSource: 'dvf' | 'ban' | 'parcelle' | 'commune_centroid'
  geolocFine: boolean
  sourceAnnee: number
}

/** Mutation écartée, avec son motif. */
export interface RejectedMutation {
  idMutation: string
  reason: RejectionReason
}

export interface NormalizeResult {
  kept: NormalizedMutation[]
  rejected: RejectedMutation[]
  /** Compteur par motif, tel que stocké dans `rejected_counts` (jsonb). */
  rejectedCounts: Record<string, number>
  /** Nombre de lignes CSV lues. */
  rowsRead: number
  /** Nombre de mutations distinctes (après regroupement par `id_mutation`). */
  mutationsSeen: number
}

/* ══════════════════════════════════════════════════════════════════════════
 * Bornes de plausibilité — spec §3.3 et Annexe A.2
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Départements où la borne haute du prix au m² est portée à 45 000 €
 * (Annexe A.2). Sans cela, l'essentiel du marché parisien, niçois, corse,
 * annécien et des Hauts-de-Seine serait marqué aberrant à tort.
 */
export const HIGH_PRICE_DEPARTMENTS = new Set(['75', '06', '74', '2A', '2B', '92'])

export const PRICE_M2_MIN = 300
export const PRICE_M2_MAX_DEFAULT = 25_000
export const PRICE_M2_MAX_HIGH = 45_000

/** Bornes de surface bâtie par type (Annexe A.2). */
export const SURFACE_BOUNDS: Record<PropertyType, { min: number; max: number }> = {
  appartement: { min: 9, max: 1_000 },
  maison: { min: 20, max: 1_500 },
}

/** En deçà : cession symbolique ou vente intrafamiliale (Annexe A.2). */
export const VALEUR_FONCIERE_MIN = 5_000

/** Borne haute de la spec §3.3, conservée comme garde-fou. */
export const VALEUR_FONCIERE_MAX = 15_000_000

/** Borne géographique France + DOM, pour détecter une inversion lon/lat. */
const LON_MIN = -63
const LON_MAX = 56
const LAT_MIN = -22
const LAT_MAX = 52

/* ══════════════════════════════════════════════════════════════════════════
 * Analyseurs élémentaires
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Nombre décimal DVF. Le CSV utilise le point ; on tolère la virgule par
 * prudence. Une chaîne vide retourne `null` (absence), jamais 0 : confondre
 * « surface inconnue » et « surface nulle » fabriquerait des divisions par
 * zéro et des prix absurdes.
 */
export function parseDecimal(value: string | undefined | null): number | null {
  if (value === undefined || value === null) {
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }
  const parsed = Number.parseFloat(trimmed.replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

export function parseInteger(value: string | undefined | null): number | null {
  const parsed = parseDecimal(value)
  if (parsed === null) {
    return null
  }
  return Math.round(parsed)
}

/**
 * Normalise `type_local` en minuscules (§3.1).
 * DVF n'utilise que 4 valeurs ; seules « Maison » et « Appartement » sont
 * retenues pour la valorisation. « Dépendance » et « Local industriel… » ne
 * sont pas des biens estimables ici.
 */
export function normalizeTypeLocal(value: string | undefined | null): PropertyType | null {
  if (!value) {
    return null
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === 'maison') {
    return 'maison'
  }
  if (normalized === 'appartement') {
    return 'appartement'
  }
  return null
}

/**
 * Une dépendance (`code_type_local = 3` : cave, garage, parking).
 *
 * Annexe A.1 : elles sont **exclues de la somme des surfaces** mais ne
 * provoquent **pas** le rejet de la mutation.
 */
export function isDependance(row: DvfRawRow): boolean {
  return row.code_type_local?.trim() === '3'
}

/**
 * Nature d'un local **bâti** au sens de l'Annexe A.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LIGNE « BÂTIE » ≠ LIGNE « VALORISABLE » — LA DISTINCTION EST STRUCTURANTE
 * ══════════════════════════════════════════════════════════════════════════
 * DVF connaît quatre `code_type_local` :
 *   1 maison · 2 appartement · 3 dépendance · 4 local industriel/commercial.
 *
 * L'Annexe A.1 range explicitement « bâti + local commercial » dans les cas
 * qui déclenchent `multi_type` : la valeur foncière porte sur l'ensemble et
 * n'est **pas** répartissable. Ne reconnaître que 1 et 2 comme « bâti »
 * laissait passer ces mutations avec la seule surface du logement :
 *
 *   maison 90 m² + local commercial 120 m², valeur foncière 300 000 €
 *   → ingérée comme « maison 90 m² », soit 3 333 €/m² au lieu de ~1 400.
 *
 * 3 333 €/m² passe sous le seuil d'aberration de 25 000 €/m² : la mutation
 * était conservée, non marquée, et entrait dans la médiane. En centre-bourg —
 * commerce en rez-de-chaussée, logement au-dessus — le cas est fréquent.
 *
 * Donc : **1, 2 et 4 sont des lignes bâties** (elles comptent dans `nb_types`
 * et peuvent déclencher `multi_type`) ; seules **1 et 2 sont valorisables**.
 * Le 3 (dépendance) n'est ni l'un ni l'autre : il ne grossit aucune surface et
 * ne provoque jamais de rejet.
 */
export type BuiltTypeKey = 'maison' | 'appartement' | 'commercial'

/** Codes DVF des lignes bâties (A.1). Le 3 — dépendance — en est exclu. */
export const BUILT_TYPE_CODES: Record<string, BuiltTypeKey> = {
  '1': 'maison',
  '2': 'appartement',
  '4': 'commercial',
}

/**
 * Nature bâtie d'une ligne, ou `null` (dépendance, terrain, ligne de culture).
 *
 * `code_type_local` fait foi quand il est renseigné : c'est le champ
 * normalisé de DVF. Le libellé `type_local` ne sert que de repli, pour les
 * exports où le code manque.
 */
export function builtTypeKey(row: DvfRawRow): BuiltTypeKey | null {
  const code = row.code_type_local?.trim() ?? ''
  if (code.length > 0) {
    return BUILT_TYPE_CODES[code] ?? null
  }

  const label = (row.type_local ?? '').trim().toLowerCase()
  if (label === 'maison') {
    return 'maison'
  }
  if (label === 'appartement') {
    return 'appartement'
  }
  if (label.startsWith('local industriel')) {
    return 'commercial'
  }
  return null
}

/**
 * Une ligne portant un local **bâti** au sens de l'A.1 — logement OU local
 * commercial. C'est cette fonction qui alimente `nb_types`, donc le rejet
 * `multi_type`.
 */
export function isBuiltRow(row: DvfRawRow): boolean {
  return builtTypeKey(row) !== null
}

/** Une ligne bâtie **valorisable** : maison ou appartement, jamais un local 4. */
export function isValuableRow(row: DvfRawRow): boolean {
  const key = builtTypeKey(row)
  return key === 'maison' || key === 'appartement'
}

/**
 * Adresse de voie **sans le numéro** — spec §5.1 et §8.3 (vie privée).
 *
 * DVF sépare déjà le numéro (`adresse_numero`) du nom de voie
 * (`adresse_nom_voie`), il suffit donc de ne jamais lire le premier. Cette
 * fonction se contente de mettre en forme le nom de voie, et retire par
 * précaution un numéro qui se serait glissé en tête — on a vu des sources
 * dériver sur ce point, et le coût d'une vérification est nul.
 */
export function normalizeAdresseVoie(nomVoie: string | undefined | null): string | null {
  if (!nomVoie) {
    return null
  }

  let value = nomVoie.trim()
  if (value.length === 0) {
    return null
  }

  // Retrait défensif d'un éventuel numéro en tête (« 12 BIS RUE … »).
  value = value.replace(/^\d+\s*(bis|ter|quater|[a-z])?\s+/i, '')

  /*
   * Mise en forme lisible : DVF fournit le nom de voie en capitales.
   *
   * Reproduit `initcap()` de PostgreSQL, utilisé par la transformation SQL :
   * un mot est une suite de caractères alphanumériques, séparée par tout le
   * reste. « SAINT-JEAN » donne donc « Saint-Jean » et non « Saint-jean ».
   * Cette équivalence est vérifiée par le test de parité SQL/JS.
   */
  value = value
    .toLowerCase()
    .replace(/[\p{L}\p{N}]+/gu, (word) => word.charAt(0).toUpperCase() + word.slice(1))

  return value.length > 0 ? value : null
}

/** Valide une date `YYYY-MM-DD` et renvoie l'année, ou `null`. */
export function parseMutationDate(
  value: string | undefined | null
): { date: string; year: number } | null {
  if (!value) {
    return null
  }
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) {
    return null
  }
  const year = Number.parseInt(match[1], 10)
  const month = Number.parseInt(match[2], 10)
  const day = Number.parseInt(match[3], 10)

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }
  // Garde-fou large : DVF ne remonte pas avant 2010.
  if (year < 2010 || year > 2100) {
    return null
  }
  /*
   * Date réellement existante au calendrier. Un simple `day <= 31` acceptait
   * `2024-02-31` et `2025-04-31`, là où la transformation SQL les rejette
   * (`'2024-02-31'::date` lève, `dvf_date` retourne alors NULL) : les deux
   * implémentations divergeaient sans que le test de parité l'attrape, faute
   * d'un cas de ce genre dans son jeu de lignes.
   */
  const asUtc = new Date(Date.UTC(year, month - 1, day))
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day
  ) {
    return null
  }

  return { date: `${match[1]}-${match[2]}-${match[3]}`, year }
}

/** Borne haute du prix au m² applicable au département (Annexe A.2). */
export function priceCeilingFor(codeDepartement: string): number {
  return HIGH_PRICE_DEPARTMENTS.has(codeDepartement.toUpperCase())
    ? PRICE_M2_MAX_HIGH
    : PRICE_M2_MAX_DEFAULT
}

/* ══════════════════════════════════════════════════════════════════════════
 * Regroupement par mutation — Annexe A.1
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Regroupe les lignes brutes par `id_mutation`, en préservant l'ordre
 * d'apparition (déterminisme des tests).
 */
export function groupByMutation(rows: DvfRawRow[]): Map<string, DvfRawRow[]> {
  const groups = new Map<string, DvfRawRow[]>()

  for (const row of rows) {
    const id = row.id_mutation?.trim()
    if (!id) {
      continue
    }
    const existing = groups.get(id)
    if (existing) {
      existing.push(row)
    } else {
      groups.set(id, [row])
    }
  }

  return groups
}

/**
 * Déduplique les lignes bâties strictement identiques.
 *
 * Observé sur données réelles (Creuse 2025, mutation `2025-249971`) : la même
 * maison apparaît deux fois sur la même parcelle, avec surface et nombre de
 * pièces identiques. Sommer ces lignes doublerait la surface et diviserait le
 * prix au m² par deux.
 *
 * La clé retenue est `(id_parcelle, code_type_local, surface, pièces)` : deux
 * appartements réellement distincts d'un même immeuble diffèrent au moins par
 * leur surface ou leur numéro de lot, tandis qu'un doublon technique est
 * identique sur toutes ces dimensions.
 */
export function dedupeBuiltRows(rows: DvfRawRow[]): DvfRawRow[] {
  const seen = new Set<string>()
  const result: DvfRawRow[] = []

  for (const row of rows) {
    const key = [
      row.id_parcelle?.trim() ?? '',
      row.code_type_local?.trim() ?? '',
      row.surface_reelle_bati?.trim() ?? '',
      row.nombre_pieces_principales?.trim() ?? '',
      // Le numéro de lot distingue deux lots identiques d'un même immeuble.
      row.lot1_numero?.trim() ?? '',
    ].join('|')

    if (!seen.has(key)) {
      seen.add(key)
      result.push(row)
    }
  }

  return result
}

/* ══════════════════════════════════════════════════════════════════════════
 * Normalisation d'une mutation
 * ════════════════════════════════════════════════════════════════════════ */

export interface NormalizeOptions {
  /** Millésime du fichier source. */
  sourceAnnee: number
  /** Département attendu (sert de repli si la colonne est vide). */
  codeDepartement?: string
}

/** Résultat de la normalisation d'un groupe de lignes. */
export type MutationOutcome =
  { status: 'kept'; mutation: NormalizedMutation } | { status: 'rejected'; reason: RejectionReason }

/**
 * Transforme un groupe de lignes partageant le même `id_mutation` en au plus
 * une mutation normalisée.
 *
 * Applique dans l'ordre : filtre de nature (§3.1), règle multi-lots (A.1),
 * bornes de plausibilité (A.2, en marquage), présence de géolocalisation.
 */
export function normalizeMutationGroup(
  idMutation: string,
  rows: DvfRawRow[],
  options: NormalizeOptions
): MutationOutcome {
  const first = rows[0]

  /* ── Filtre de nature (§3.1) ─────────────────────────────────────────── */
  // Seules les ventes sont exploitables. Les échanges, adjudications et
  // expropriations ne reflètent pas un prix de marché.
  const nature = first.nature_mutation?.trim()
  if (nature !== 'Vente') {
    return { status: 'rejected', reason: 'nature_non_vente' }
  }

  /* ── Règle multi-lots (Annexe A.1) ───────────────────────────────────── */
  const builtRows = dedupeBuiltRows(rows.filter(isBuiltRow))

  if (builtRows.length === 0) {
    // Mutation sans local bâti : terrain nu, dépendance seule…
    // Traitée par la table `mutations_terrain`, pas ici.
    return { status: 'rejected', reason: 'aucun_local_bati' }
  }

  const types = new Set(builtRows.map((row) => builtTypeKey(row)!))
  if (types.size > 1) {
    // Maison + appartement, ou bâti + local commercial (A.1) :
    // `valeur_fonciere` porte sur l'ensemble et n'est pas répartissable entre
    // les lots. Le €/m² du logement seul serait gonflé sans que rien ne le
    // signale.
    return { status: 'rejected', reason: 'multi_type' }
  }

  // Type unique, mais pas forcément valorisable : un local commercial vendu
  // seul relève d'un autre marché, que DVF renseigne trop mal (§3.2).
  const typeLocal = builtTypeKey(builtRows[0]) === 'commercial' ? null : builtTypeKey(builtRows[0])
  if (typeLocal !== 'maison' && typeLocal !== 'appartement') {
    return { status: 'rejected', reason: 'type_local_non_retenu' }
  }

  /*
   * Somme des surfaces des lots de MÊME type (Annexe A.1).
   *
   * Les dépendances (cave, garage, parking) portent `type_local =
   * 'Dépendance'` : elles ne franchissent donc jamais `isBuiltRow` et ne
   * peuvent ni grossir la surface habitable, ni déclencher un rejet
   * `multi_type`. C'est exactement le comportement voulu — une vente
   * d'appartement avec cave et parking est CONSERVÉE. Elles sont comptées à
   * part pour être tracées.
   *
   * Les sommes sont faites en décimal puis arrondies UNE FOIS à la fin, comme
   * le fait la transformation SQL (`round(sum(...))`) : arrondir chaque ligne
   * avant de sommer produirait un écart d'un ou deux m² sur les mutations
   * multi-lots.
   */
  let surfaceBati = 0
  let nbPieces = 0

  for (const row of builtRows) {
    const surface = parseDecimal(row.surface_reelle_bati)
    if (surface !== null) {
      surfaceBati += surface
    }
    const pieces = parseDecimal(row.nombre_pieces_principales)
    if (pieces !== null) {
      nbPieces += pieces
    }
  }

  const surfaceBatiRounded = Math.round(surfaceBati)
  const nbPiecesRounded = Math.round(nbPieces)

  if (surfaceBatiRounded <= 0) {
    return { status: 'rejected', reason: 'surface_absente' }
  }

  const nbLocaux = builtRows.length
  const nbDependances = rows.filter(isDependance).length

  /* ── Valeur foncière : comptée UNE SEULE FOIS ────────────────────────── */
  /*
   * Elle est répétée à l'identique sur toutes les lignes du groupe : on en
   * retient une seule valeur, JAMAIS une somme. C'est l'erreur qui gonfle les
   * prix d'un facteur 2 à 4.
   *
   * On prend le maximum des valeurs strictement positives : quand elles sont
   * identiques — le cas normal — c'est équivalent à « la première », et cela
   * reste déterministe si une ligne du groupe porte une valeur aberrante.
   */
  let valeurFonciere: number | null = null
  for (const row of rows) {
    const value = parseDecimal(row.valeur_fonciere)
    if (value !== null && value > 0 && (valeurFonciere === null || value > valeurFonciere)) {
      valeurFonciere = value
    }
  }

  if (valeurFonciere === null) {
    return { status: 'rejected', reason: 'valeur_absente' }
  }

  /* ── Date ────────────────────────────────────────────────────────────── */
  const parsedDate = parseMutationDate(first.date_mutation)
  if (!parsedDate) {
    return { status: 'rejected', reason: 'date_invalide' }
  }

  /* ── Rattachement administratif ──────────────────────────────────────── */
  const codeInsee = first.code_commune?.trim()
  if (!codeInsee || codeInsee.length !== 5) {
    return { status: 'rejected', reason: 'code_insee_absent' }
  }

  const codeDepartement =
    first.code_departement?.trim() || options.codeDepartement?.trim() || codeInsee.slice(0, 2)

  /* ── Géolocalisation (§3.1) ──────────────────────────────────────────── */
  // On prend les coordonnées de la première ligne bâtie qui en porte : le
  // point doit désigner le local, pas une parcelle de landes voisine.
  let longitude: number | null = null
  let latitude: number | null = null

  for (const row of [...builtRows, ...rows]) {
    const lon = parseDecimal(row.longitude)
    const lat = parseDecimal(row.latitude)
    if (lon !== null && lat !== null) {
      longitude = lon
      latitude = lat
      break
    }
  }

  if (
    longitude === null ||
    latitude === null ||
    longitude < LON_MIN ||
    longitude > LON_MAX ||
    latitude < LAT_MIN ||
    latitude > LAT_MAX
  ) {
    // §3.1 : la géolocalisation est requise. Les lignes sans coordonnées
    // (3 à 8 % du fichier) relèvent du géocodage BAN en lot (Annexe A.3),
    // traité hors de cette fonction pure.
    return { status: 'rejected', reason: 'geolocalisation_absente' }
  }

  /* ── Surface terrain ─────────────────────────────────────────────────── */
  // Sommée sur toutes les lignes du groupe : les parcelles distinctes d'une
  // même vente s'additionnent réellement (contrairement à la valeur foncière).
  let surfaceTerrain = 0
  const seenParcelles = new Set<string>()
  for (const row of rows) {
    const parcelle = row.id_parcelle?.trim() ?? ''
    if (parcelle && seenParcelles.has(parcelle)) {
      continue
    }
    if (parcelle) {
      seenParcelles.add(parcelle)
    }
    const terrain = parseInteger(row.surface_terrain)
    if (terrain !== null && terrain > 0) {
      surfaceTerrain += terrain
    }
  }

  /* ── Marquage des aberrants (Annexe A.2) ─────────────────────────────── */
  // On MARQUE, on ne supprime pas : traçabilité et réversibilité si un seuil
  // évolue.
  const prixM2 = valeurFonciere / surfaceBatiRounded
  const bounds = SURFACE_BOUNDS[typeLocal]
  const ceiling = priceCeilingFor(codeDepartement)

  let isOutlier = false
  let exclusionReason: string | null = null

  if (valeurFonciere < VALEUR_FONCIERE_MIN || valeurFonciere > VALEUR_FONCIERE_MAX) {
    isOutlier = true
    exclusionReason = 'valeur_symbolique'
  } else if (surfaceBatiRounded < bounds.min || surfaceBatiRounded > bounds.max) {
    isOutlier = true
    exclusionReason = 'surface_hors_bornes'
  } else if (prixM2 < PRICE_M2_MIN || prixM2 > ceiling) {
    isOutlier = true
    exclusionReason = 'prix_hors_bornes'
  }

  return {
    status: 'kept',
    mutation: {
      // `dedup_key` est calculé par l'appelant (le hachage n'a pas sa place
      // dans un module pur sans dépendance) — voir `dvf_transform.ts`.
      dedupKey: '',
      idMutation,
      dateMutation: parsedDate.date,
      natureMutation: nature,
      valeurFonciere,
      typeLocal,
      surfaceBati: surfaceBatiRounded,
      nbPieces: nbPiecesRounded > 0 ? nbPiecesRounded : null,
      surfaceTerrain,
      nbLocaux,
      nbDependances,
      codeInsee,
      codeDepartement,
      // Nom de voie de la première ligne bâtie (§8.3 : jamais le numéro).
      adresseVoie: normalizeAdresseVoie(builtRows[0].adresse_nom_voie),
      codePostal: first.code_postal?.trim() || null,
      longitude,
      latitude,
      prixM2,
      isOutlier,
      exclusionReason,
      // Les fichiers DVF géolocalisés Etalab donnent la position à la
      // parcelle (Annexe A.3).
      geolocSource: 'dvf',
      geolocFine: true,
      sourceAnnee: options.sourceAnnee,
    },
  }
}

/**
 * Normalise un lot complet de lignes CSV.
 *
 * Point d'entrée testable de bout en bout : on lui passe un tableau de lignes
 * brutes, il rend les mutations à insérer et le décompte des rejets par motif.
 */
export function normalizeRows(rows: DvfRawRow[], options: NormalizeOptions): NormalizeResult {
  const groups = groupByMutation(rows)
  const kept: NormalizedMutation[] = []
  const rejected: RejectedMutation[] = []
  const rejectedCounts: Record<string, number> = {}

  for (const [idMutation, groupRows] of groups) {
    const outcome = normalizeMutationGroup(idMutation, groupRows, options)

    if (outcome.status === 'kept') {
      kept.push(outcome.mutation)
    } else {
      rejected.push({ idMutation, reason: outcome.reason })
      rejectedCounts[outcome.reason] = (rejectedCounts[outcome.reason] ?? 0) + 1
    }
  }

  return {
    kept,
    rejected,
    rejectedCounts,
    rowsRead: rows.length,
    mutationsSeen: groups.size,
  }
}
