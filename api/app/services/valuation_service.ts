/**
 * Moteur de valorisation — spec §3.3 à §3.8. **FONCTION PURE.**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE D'ARCHITECTURE NON NÉGOCIABLE (§6.2, Annexe A.12)
 * ══════════════════════════════════════════════════════════════════════════
 * Aucun accès base. Aucun appel réseau. **Aucune horloge implicite** :
 * `new Date()` est interdit ici, la date de référence est injectée
 * (`referenceDate`). Deux appels identiques rendent, toujours, un résultat
 * identique.
 *
 * Ce module ne reçoit qu'un **tableau plat d'objets** — `{ prixM2, surface,
 * distanceMetres, dateMutation, … }`. Aucun type PostGIS, aucun modèle Lucid
 * ne franchit cette frontière (A.12). C'est ce qui permet de réviser une
 * formule, de la faire relire par un tiers et de la backtester (Lot 7) sans
 * monter la moindre infrastructure.
 *
 * Si vous ajoutez un `import` ici, demandez-vous d'abord s'il n'est pas en
 * train de casser cette propriété. C'est, de loin, la propriété de qualité la
 * plus importante du projet.
 */

/* ══════════════════════════════════════════════════════════════════════════
 * Types du domaine
 * ════════════════════════════════════════════════════════════════════════ */

export type PropertyType = 'appartement' | 'maison' | 'terrain' | 'local-commercial'
/** Types réellement valorisables par comparaison au Lot 2. */
export type ComparablePropertyType = 'appartement' | 'maison' | 'terrain'
export type DpeClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'unknown'
export type ConditionKey = 'to-renovate' | 'fair' | 'good' | 'new'
export type OutdoorKey = 'none' | 'balcony' | 'terrace' | 'garden'
export type GeocodePrecision = 'exact' | 'approximate' | 'city-centroid'

/** Niveaux de la cascade §3.2, tels qu'exposés par `method.level` (§5.3). */
export type CascadeLevel =
  'radius' | 'commune' | 'epci' | 'departement' | 'region' | 'national' | 'departement-reference'

export type ConfidenceLabel = 'high' | 'medium' | 'low' | 'insufficient'

/**
 * Un comparable, tel qu'il franchit la frontière SQL → calcul (A.12).
 * Volontairement plat, sérialisable, sans aucune dépendance.
 */
export interface RawComparable {
  /** Prix au m² brut de la mutation, avant ajustement temporel. */
  prixM2: number
  /** Surface bâtie (ou surface de terrain pour une mutation de terrain). */
  surface: number
  /** Distance au bien estimé, en mètres. `null` si non calculée. */
  distanceMetres: number | null
  /** Date de la mutation, `YYYY-MM-DD`. */
  dateMutation: string
  /** Valeur foncière, utilisée par les bornes absolues du §3.3. */
  valeurFonciere?: number | null
  surfaceTerrain?: number | null
  rooms?: number | null
  street?: string | null
  city?: string | null
  propertyType?: 'appartement' | 'maison' | 'terrain'
  /**
   * Facteur d'ajustement temporel déjà résolu par `PriceIndexService`
   * (§3.4). Vaut 1 tant que le Lot 4 n'est pas livré : le calcul reste juste,
   * simplement non corrigé de l'évolution du marché — biais connu et exposé.
   */
  timeIndexFactor?: number
}

/** Comparable retenu, enrichi de ce que le calcul en a fait. */
export interface AdjustedComparable extends RawComparable {
  /** `p_adj(i)` du §3.4. */
  adjustedPriceM2: number
  /** Poids `w_i = w_geo × w_temps × w_surface` du §3.5. */
  weight: number
  ageMonths: number
}

export interface PropertyInput {
  propertyType: PropertyType
  surface: number
  rooms?: number | null
  dpe: DpeClass
  floor?: number | null
  hasElevator?: boolean | null
  /**
   * Le §3.6 distingue « dernier étage AVEC ascenseur » (1,05). L'information
   * n'est pas collectée par le formulaire (§6.1 ne déclare pas le champ) :
   * elle vaut donc `false` en pratique, mais la règle est implémentée et
   * testée, pour que l'ajout du champ au wizard soit sans effet de bord.
   */
  isTopFloor?: boolean | null
  outdoor?: OutdoorKey | null
  condition?: ConditionKey | null
  terrainSize?: number | null
}

/**
 * Table des coefficients, **injectée** depuis `coefficients_reference`
 * (§3.6, règle 1). Une clé absente vaut 1,00 (neutre) : on n'invente jamais
 * une valeur non sourcée, quitte à ne rien ajuster.
 */
export interface CoefficientTable {
  dpe: Partial<Record<'appartement' | 'maison', Partial<Record<DpeClass, number>>>>
  condition: Partial<Record<ConditionKey, number>>
  floor: Partial<Record<FloorKey, number>>
  outdoor: Partial<Record<OutdoorKey, number>>
  surfaceAlpha: Partial<Record<'appartement' | 'maison', number>>
  terrainFallbackRatio: number | null
}

export type FloorKey = 'ground-floor' | 'top-with-elevator' | 'high-no-elevator' | 'low-no-elevator'

export interface ValuationInput {
  property: PropertyInput
  /** Échantillon **brut** : le nettoyage du §3.3 est fait ici. */
  comparables: RawComparable[]
  coefficients: CoefficientTable
  geocodePrecision: GeocodePrecision
  level: CascadeLevel
  radiusM: number | null
  windowMonths: number
  surfaceTolerancePct: number
  /**
   * `true` si la cascade a dû élargir la tolérance de surface (§3.2) —
   * −5 points de confiance (§3.8). Un booléen explicite plutôt qu'une
   * comparaison à 30 : la tolérance nominale d'un terrain est déjà de ±50 %,
   * un seuil en dur pénaliserait tous les terrains sans raison.
   */
  surfaceToleranceWidened: boolean
  /** Médiane €/m² des mutations de terrain du secteur, ou `null` (§3.6). */
  landPricePerSqm: number | null
  /** Bornes de nettoyage §3.3, adaptées au type de bien. */
  sampleBounds?: CleanOptions
  /** Date de référence **injectée** — voir l'avertissement en tête de module. */
  referenceDate: string
}

export interface CoefficientBreakdown {
  surface: number
  floor: number
  outdoor: number
  condition: number
  dpe: number
  total: number
  clamped: boolean
}

export interface ValuationOutput {
  value: number | null
  pricePerSqm: number | null
  range: { low: number; high: number; halfWidthPct: number; basis: 'iqr' | 'fixed' }
  confidence: {
    score: number
    label: ConfidenceLabel
    breakdown: {
      count: number
      proximity: number
      freshness: number
      dispersion: number
      penalties: number
    }
  }
  display: { showCentralValue: boolean; confidenceLabelFr: string; warnings: string[] }
  method: {
    level: CascadeLevel
    radiusM: number | null
    windowMonths: number
    surfaceTolerancePct: number
    comparablesCount: number
    comparablesRejected: Record<string, number>
    medianPriceM2Raw: number | null
    timeAdjustmentFactor: number
    coefficients: CoefficientBreakdown
    landValue: number
    dispersion: number
    medianAgeMonths: number
  }
  /** Comparables retenus, pour l'anonymisation et l'affichage par l'appelant. */
  retained: AdjustedComparable[]
  /** `true` si l'échantillon n'a pas permis de produire une valeur. */
  insufficientSample: boolean
}

/* ══════════════════════════════════════════════════════════════════════════
 * Paramètres — §3.3 et §3.6 à §3.8
 * ════════════════════════════════════════════════════════════════════════ */

/** Bornes absolues du §3.3, point 1. */
export const PRICE_M2_FLOOR = 200
export const PRICE_M2_CEILING = 25_000
export const SURFACE_FLOOR = 9
export const SURFACE_CEILING = 1_000
export const VALUE_FLOOR = 5_000
export const VALUE_CEILING = 15_000_000

/** §3.3, point 3 — plafond d'échantillon retenu pour le calcul. */
export const SAMPLE_CAP = 150
/** §3.2 — « N_min absolu = 5 », en dessous le niveau est rejeté. */
export const MIN_SAMPLE = 5

/** §3.6 — bornes individuelles des coefficients. */
export const COEFFICIENT_BOUNDS = {
  surface: [0.85, 1.15],
  floor: [0.9, 1.06],
  outdoor: [1.0, 1.08],
  condition: [0.85, 1.08],
  dpe: [0.8, 1.15],
} as const

/** §3.6 — garde-fou cumulé. */
export const K_TOTAL_MIN = 0.7
export const K_TOTAL_MAX = 1.35

/** §3.7 — fourchette. Le facteur 0,5 est explicitement « ajustable » (Lot 7). */
export const RANGE_FACTOR = 0.5
export const RANGE_MIN = 0.04
export const RANGE_MAX = 0.25
/** §3.9 — amplitude fixe du repli sans comparables. */
export const REFERENCE_RANGE = 0.2

/** §3.8 — malus. */
export const PENALTIES = {
  geocodeApproximate: 5,
  geocodeCityCentroid: 12,
  dpeUnknown: 5,
  clamped: 10,
  wideSurfaceTolerance: 5,
} as const

/**
 * §3.9 — confiance **plafonnée** sur les territoires hors DVF.
 *
 * §3.8 est explicite : « Département sans DVF (§3.9) → plafonnement à 35 (**et
 * non un malus**) », et §3.9 en tire la conséquence attendue : « `confidence`
 * plafonnée à 35 → l'UI bascule **automatiquement** en mode “confiance
 * faible” » (seuil 30-49).
 */
export const NO_DVF_CONFIDENCE_CAP = 35

/**
 * Score de départ du chemin §3.9, **avant** plafonnement.
 *
 * Les quatre composantes du §3.8 (`C_n`, `C_geo`, `C_temps`, `C_disp`) sont
 * toutes **non mesurables** sans échantillon : il n'y a ni comparable, ni
 * distance, ni âge, ni dispersion. Les évaluer à 0 reviendrait à transformer
 * l'absence de mesure en mauvaise note, ce que §3.8 refuse précisément en
 * qualifiant le traitement de plafond et non de malus.
 *
 * On part donc du maximum de l'échelle, on retranche les malus réellement
 * observés (géocodage, DPE, écrêtage), puis on applique le plafond. En
 * pratique le plafond absorbe les malus — c'est voulu : §3.9 exige que ces
 * territoires basculent en « confiance faible », pas en « données
 * insuffisantes ». Le détail des malus reste publié dans
 * `confidence.breakdown.penalties`, donc auditable.
 */
export const REFERENCE_BASE_SCORE = 100

/** §3.5 — demi-vie de la pondération temporelle, en mois. */
export const TIME_HALF_LIFE_MONTHS = 24
/** §3.5 — distance de référence de la pondération géographique, en mètres. */
export const GEO_REFERENCE_METRES = 500

/* ══════════════════════════════════════════════════════════════════════════
 * Primitives numériques
 * ════════════════════════════════════════════════════════════════════════ */

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min
  }
  return Math.min(max, Math.max(min, value))
}

/**
 * Quantile par interpolation linéaire, équivalent de `percentile_cont` en
 * PostgreSQL. Choisi pour que l'écrêtage IQR du §3.3 donne exactement le même
 * résultat qu'une vérification faite en SQL sur le même échantillon.
 */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) {
    return sorted[0]
  }

  const position = clamp(q, 0, 1) * (sorted.length - 1)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)

  if (lower === upper) {
    return sorted[lower]
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

export function median(values: number[]): number | null {
  return quantile(values, 0.5)
}

/**
 * Quantile **pondéré** — §3.5.
 *
 * « valeur de `p_adj` au point où la somme cumulée des poids (série triée par
 * `p_adj` croissant) atteint 50 % de la somme totale des poids ». On retourne
 * donc la valeur observée, sans interpolation : c'est bien une médiane
 * (robuste aux extrêmes), pas une moyenne déguisée.
 */
export function weightedQuantile(
  entries: Array<{ value: number; weight: number }>,
  q: number
): number | null {
  const usable = entries.filter((entry) => Number.isFinite(entry.value) && entry.weight > 0)
  if (usable.length === 0) {
    // Tous les poids nuls : on retombe sur le quantile non pondéré plutôt
    // que de renvoyer `null` et de perdre un échantillon exploitable.
    return quantile(
      entries.map((entry) => entry.value),
      q
    )
  }

  const sorted = [...usable].sort((a, b) => a.value - b.value)
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0)
  const target = clamp(q, 0, 1) * total

  let cumulative = 0
  for (const entry of sorted) {
    cumulative += entry.weight
    if (cumulative >= target) {
      return entry.value
    }
  }

  return sorted[sorted.length - 1].value
}

/** Arrondi de présentation — §3.7 : au millier ≥ 100 000 €, à la centaine sinon. */
export function roundValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  const step = Math.abs(value) >= 100_000 ? 1_000 : 100
  return Math.round(value / step) * step
}

/**
 * Écart en mois entre deux dates `YYYY-MM-DD`. Pure et déterministe : aucune
 * dépendance au fuseau ni à l'horloge du processus.
 */
export function monthsBetween(from: string, to: string): number {
  const start = parseIsoDate(from)
  const end = parseIsoDate(to)
  if (start === null || end === null) {
    return 0
  }
  const days = (end - start) / 86_400_000
  // 30,4375 = 365,25 / 12. Constante, donc reproductible.
  return days / 30.4375
}

function parseIsoDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '')
  if (!match) {
    return null
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

/* ══════════════════════════════════════════════════════════════════════════
 * §3.3 — Nettoyage et écrêtage
 * ════════════════════════════════════════════════════════════════════════ */

export interface CleanResult {
  kept: RawComparable[]
  rejected: Record<string, number>
}

/**
 * Bornes du §3.3, surchargeables.
 *
 * Les valeurs par défaut décrivent du **bâti**. Un terrain a d'autres ordres
 * de grandeur (quelques euros le m² en zone agricole, plusieurs hectares de
 * surface) : lui appliquer les bornes du bâti écarterait tout l'échantillon,
 * silencieusement.
 */
export interface CleanOptions {
  priceMin?: number
  priceMax?: number
  surfaceMin?: number
  surfaceMax?: number
}

/**
 * Nettoyage du §3.3, dans l'ordre exact de la spec :
 *  1. bornes absolues,
 *  2. écrêtage IQR (`[Q1 − 1,5·IQR ; Q3 + 1,5·IQR]`),
 *  3. plafond des 150 comparables les plus proches.
 *
 * Exporté séparément de `computeValuation` parce que la **cascade** en a
 * besoin : le §3.3, point 4, impose de vérifier `N ≥ 5` *après* écrêtage pour
 * décider si un niveau est accepté. Sans cette fonction partagée, la
 * condition d'acceptation d'un niveau et le calcul final travailleraient sur
 * deux échantillons différents — un écart silencieux et très difficile à
 * diagnostiquer.
 */
export function cleanSample(comparables: RawComparable[], options: CleanOptions = {}): CleanResult {
  const priceMin = options.priceMin ?? PRICE_M2_FLOOR
  const priceMax = options.priceMax ?? PRICE_M2_CEILING
  const surfaceMin = options.surfaceMin ?? SURFACE_FLOOR
  const surfaceMax = options.surfaceMax ?? SURFACE_CEILING

  const rejected: Record<string, number> = {}
  const bump = (reason: string) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1
  }

  /* 1 — Bornes absolues -------------------------------------------------- */
  const withinBounds = comparables.filter((item) => {
    if (!Number.isFinite(item.prixM2) || item.prixM2 < priceMin) {
      bump('prix_hors_bornes')
      return false
    }
    if (item.prixM2 > priceMax) {
      bump('prix_hors_bornes')
      return false
    }
    if (!Number.isFinite(item.surface) || item.surface < surfaceMin) {
      bump('surface_hors_bornes')
      return false
    }
    if (item.surface > surfaceMax) {
      bump('surface_hors_bornes')
      return false
    }
    if (
      item.valeurFonciere !== undefined &&
      item.valeurFonciere !== null &&
      (item.valeurFonciere < VALUE_FLOOR || item.valeurFonciere > VALUE_CEILING)
    ) {
      bump('valeur_hors_bornes')
      return false
    }
    return true
  })

  /* 2 — Écrêtage IQR ----------------------------------------------------- */
  /*
   * Sur un échantillon de moins de 4 valeurs, les quartiles n'ont pas de
   * sens : les calculer reviendrait à écarter des observations sur la foi
   * d'une statistique construite sur elles-mêmes. On ne fait rien.
   */
  let clipped = withinBounds
  if (withinBounds.length >= 4) {
    const prices = withinBounds.map((item) => item.prixM2)
    const q1 = quantile(prices, 0.25)!
    const q3 = quantile(prices, 0.75)!
    const iqr = q3 - q1
    const low = q1 - 1.5 * iqr
    const high = q3 + 1.5 * iqr

    clipped = withinBounds.filter((item) => {
      if (item.prixM2 < low || item.prixM2 > high) {
        bump('iqr')
        return false
      }
      return true
    })
  }

  /* 3 — Plafond d'échantillon (150 plus proches) ------------------------- */
  let kept = clipped
  if (clipped.length > SAMPLE_CAP) {
    const byDistance = [...clipped].sort(
      (a, b) =>
        (a.distanceMetres ?? Number.MAX_SAFE_INTEGER) -
        (b.distanceMetres ?? Number.MAX_SAFE_INTEGER)
    )
    kept = byDistance.slice(0, SAMPLE_CAP)
    rejected['plafond_echantillon'] = clipped.length - SAMPLE_CAP
  }

  return { kept, rejected }
}

/* ══════════════════════════════════════════════════════════════════════════
 * §3.5 — Pondérations
 * ════════════════════════════════════════════════════════════════════════ */

/** `w_geo = 1 / (1 + (d/500)²)`. Distance inconnue ⇒ poids neutre. */
export function geoWeight(distanceMetres: number | null): number {
  if (distanceMetres === null || !Number.isFinite(distanceMetres) || distanceMetres < 0) {
    return 1
  }
  const ratio = distanceMetres / GEO_REFERENCE_METRES
  return 1 / (1 + ratio * ratio)
}

/** `w_temps = 0,5 ^ (age_mois / 24)`. Demi-vie de 24 mois. */
export function timeWeight(ageMonths: number): number {
  const age = Math.max(0, ageMonths)
  return Math.pow(0.5, age / TIME_HALF_LIFE_MONTHS)
}

/** `w_surface = 1 / (1 + |S_i − S| / S)`. */
export function surfaceWeight(comparableSurface: number, targetSurface: number): number {
  if (!Number.isFinite(targetSurface) || targetSurface <= 0) {
    return 1
  }
  return 1 / (1 + Math.abs(comparableSurface - targetSurface) / targetSurface)
}

/* ══════════════════════════════════════════════════════════════════════════
 * §3.6 — Coefficients d'ajustement
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * `k_surface = (S_med / S) ^ α` — neutre quand le bien est à la médiane de
 * son échantillon, ce qui évite le double comptage avec le filtre ±30 %.
 */
export function surfaceCoefficient(
  targetSurface: number,
  medianSurface: number | null,
  alpha: number | undefined
): number {
  if (
    !alpha ||
    medianSurface === null ||
    medianSurface <= 0 ||
    !Number.isFinite(targetSurface) ||
    targetSurface <= 0
  ) {
    return 1
  }
  const raw = Math.pow(medianSurface / targetSurface, alpha)
  return clamp(raw, COEFFICIENT_BOUNDS.surface[0], COEFFICIENT_BOUNDS.surface[1])
}

/**
 * Clé de `k_etage` — appartement uniquement (§3.6).
 * Tout champ inconnu retombe sur `null` ⇒ coefficient 1,00.
 */
export function floorKey(property: PropertyInput): FloorKey | null {
  if (property.propertyType !== 'appartement') {
    return null
  }
  const floor = property.floor
  if (floor === null || floor === undefined || !Number.isFinite(floor)) {
    return null
  }
  if (floor === 0) {
    return 'ground-floor'
  }
  if (property.isTopFloor === true && property.hasElevator === true) {
    return 'top-with-elevator'
  }
  if (property.hasElevator === false) {
    return floor >= 3 ? 'high-no-elevator' : 'low-no-elevator'
  }
  return null
}

/** `k_exterieur` — non appliqué à la maison : déjà présent dans le comparable. */
export function outdoorKey(property: PropertyInput): OutdoorKey | null {
  if (property.propertyType !== 'appartement') {
    return null
  }
  if (!property.outdoor || property.outdoor === 'none') {
    return null
  }
  return property.outdoor
}

function lookup(table: Partial<Record<string, number>>, key: string | null): number {
  if (!key) {
    return 1
  }
  const value = table[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 1
}

/** Calcule les cinq coefficients, leurs bornes et le garde-fou cumulé. */
export function computeCoefficients(
  property: PropertyInput,
  medianSurface: number | null,
  coefficients: CoefficientTable
): CoefficientBreakdown {
  const builtType = property.propertyType === 'maison' ? 'maison' : 'appartement'

  const surface = surfaceCoefficient(
    property.surface,
    medianSurface,
    coefficients.surfaceAlpha[builtType]
  )

  const floor = clamp(
    lookup(coefficients.floor, floorKey(property)),
    COEFFICIENT_BOUNDS.floor[0],
    COEFFICIENT_BOUNDS.floor[1]
  )

  const outdoor = clamp(
    lookup(coefficients.outdoor, outdoorKey(property)),
    COEFFICIENT_BOUNDS.outdoor[0],
    COEFFICIENT_BOUNDS.outdoor[1]
  )

  const condition = clamp(
    lookup(coefficients.condition, property.condition ?? null),
    COEFFICIENT_BOUNDS.condition[0],
    COEFFICIENT_BOUNDS.condition[1]
  )

  const dpeTable = coefficients.dpe[builtType] ?? {}
  const dpe =
    property.dpe === 'unknown'
      ? 1
      : clamp(lookup(dpeTable, property.dpe), COEFFICIENT_BOUNDS.dpe[0], COEFFICIENT_BOUNDS.dpe[1])

  const product = surface * floor * outdoor * condition * dpe
  const total = clamp(product, K_TOTAL_MIN, K_TOTAL_MAX)

  return {
    surface: round4(surface),
    floor: round4(floor),
    outdoor: round4(outdoor),
    condition: round4(condition),
    dpe: round4(dpe),
    total: round4(total),
    /*
     * §3.6 : « Si la borne est atteinte, method.clamped = true — l'information
     * est retournée, affichée dans la méthodologie du rapport, et coûte 10
     * points de confiance. Un bien qui sort de ces bornes est un bien
     * atypique, donc mal estimé par comparaison : il faut le dire. »
     */
    clamped: product < K_TOTAL_MIN || product > K_TOTAL_MAX,
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * `V_terrain` — §3.6.
 *
 * La valeur foncière DVF **inclut déjà le terrain** : on n'additionne jamais
 * un prix de terrain à un prix de bâti. On ne valorise donc que l'**écart** à
 * la surface de terrain médiane des comparables : un terrain « dans la norme
 * du secteur » ne change rien.
 *
 * `terrainValueAt` applique la dégressivité des grands terrains : au-delà de
 * 5 000 m², la fraction excédentaire ne vaut que 30 % du prix au m².
 */
export function terrainValueAt(surface: number, pricePerSqm: number): number {
  const base = Math.min(Math.max(0, surface), 5_000)
  const above = Math.max(0, surface - 5_000)
  return pricePerSqm * base + 0.3 * pricePerSqm * above
}

export function computeLandValue(options: {
  property: PropertyInput
  builtValue: number
  medianTerrainSurface: number | null
  landPricePerSqm: number | null
  referencePriceM2: number
  fallbackRatio: number | null
}): number {
  const { property, builtValue, medianTerrainSurface, landPricePerSqm, referencePriceM2 } = options

  if (property.propertyType !== 'maison') {
    return 0
  }
  const terrainSize = property.terrainSize
  if (terrainSize === null || terrainSize === undefined || terrainSize <= 0) {
    return 0
  }

  // À défaut de mutations de terrain dans le périmètre : ratio de repli du
  // §3.6. Absent de la base ⇒ 0, jamais une valeur inventée.
  const pricePerSqm =
    landPricePerSqm !== null && landPricePerSqm > 0
      ? landPricePerSqm
      : (options.fallbackRatio ?? 0) * referencePriceM2

  if (pricePerSqm <= 0) {
    return 0
  }

  const reference = medianTerrainSurface ?? 0
  const raw = terrainValueAt(terrainSize, pricePerSqm) - terrainValueAt(reference, pricePerSqm)

  // Plafond ±25 % de la valeur bâtie (§3.6).
  const cap = 0.25 * builtValue
  return clamp(raw, -cap, cap)
}

/* ══════════════════════════════════════════════════════════════════════════
 * §3.8 — Indice de confiance
 * ════════════════════════════════════════════════════════════════════════ */

/** `C_geo` — la proximité réelle, pas le nom de la commune. */
export function proximityScore(level: CascadeLevel, radiusM: number | null): number {
  switch (level) {
    case 'radius':
      return 25 * (1 - Math.min(1, (radiusM ?? 5_000) / 5_000))
    case 'commune':
      return 12
    case 'epci':
      return 7
    case 'departement':
      return 3
    default:
      return 0
  }
}

export function confidenceLabel(score: number): ConfidenceLabel {
  if (score >= 75) return 'high'
  if (score >= 50) return 'medium'
  if (score >= 30) return 'low'
  return 'insufficient'
}

export function confidenceLabelFr(label: ConfidenceLabel): string {
  switch (label) {
    case 'high':
      return 'Confiance élevée'
    case 'medium':
      return 'Confiance moyenne'
    case 'low':
      return 'Confiance faible'
    default:
      return 'Données insuffisantes'
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Le calcul
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * `computeValuation` — §3.3 à §3.8.
 *
 * Pure. Injectez `referenceDate` : ne cherchez pas l'horloge ici.
 */
export function computeValuation(input: ValuationInput): ValuationOutput {
  const { property, coefficients, referenceDate } = input

  /* §3.3 — nettoyage ---------------------------------------------------- */
  const { kept, rejected } = cleanSample(input.comparables, input.sampleBounds)

  if (kept.length === 0) {
    return emptyOutput(input, rejected)
  }

  /* §3.4 — ajustement temporel ------------------------------------------ */
  const adjusted: AdjustedComparable[] = kept.map((item) => {
    const factor =
      typeof item.timeIndexFactor === 'number' && Number.isFinite(item.timeIndexFactor)
        ? item.timeIndexFactor
        : 1
    const ageMonths = Math.max(0, monthsBetween(item.dateMutation, referenceDate))

    return {
      ...item,
      adjustedPriceM2: item.prixM2 * factor,
      ageMonths,
      weight:
        geoWeight(item.distanceMetres) *
        timeWeight(ageMonths) *
        surfaceWeight(item.surface, property.surface),
    }
  })

  const timeAdjustmentFactor = median(adjusted.map((item) => item.timeIndexFactor ?? 1)) ?? 1

  /* §3.5 — médiane pondérée --------------------------------------------- */
  const entries = adjusted.map((item) => ({ value: item.adjustedPriceM2, weight: item.weight }))
  const referencePriceM2 = weightedQuantile(entries, 0.5)
  const q1 = weightedQuantile(entries, 0.25)
  const q3 = weightedQuantile(entries, 0.75)

  if (referencePriceM2 === null || referencePriceM2 <= 0) {
    return emptyOutput(input, rejected)
  }

  const dispersion = q1 !== null && q3 !== null ? Math.max(0, (q3 - q1) / referencePriceM2) : 0

  /* §3.6 — coefficients -------------------------------------------------- */
  const medianSurface = median(adjusted.map((item) => item.surface))
  const breakdown = computeCoefficients(property, medianSurface, coefficients)

  const builtValue = referencePriceM2 * breakdown.total * property.surface

  const terrainSurfaces = adjusted
    .map((item) => item.surfaceTerrain)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

  const landValue = computeLandValue({
    property,
    builtValue,
    medianTerrainSurface: terrainSurfaces.length > 0 ? median(terrainSurfaces) : null,
    landPricePerSqm: input.landPricePerSqm,
    referencePriceM2,
    fallbackRatio: coefficients.terrainFallbackRatio,
  })

  /* §3.7 — valeur centrale et fourchette --------------------------------- */
  const value = roundValue(builtValue + landValue)
  const pricePerSqm = property.surface > 0 ? Math.round(value / property.surface) : null

  const n = adjusted.length
  const sampleFactor = 1 + 4 / Math.sqrt(n)
  const halfWidth = clamp(RANGE_FACTOR * dispersion * sampleFactor, RANGE_MIN, RANGE_MAX)

  /* §3.8 — confiance ----------------------------------------------------- */
  const medianAgeMonths = median(adjusted.map((item) => item.ageMonths)) ?? 0

  const countScore = 40 * Math.min(1, Math.log(1 + n) / Math.log(31))
  const proximity = proximityScore(input.level, input.radiusM)
  const freshness = 15 * (1 - Math.min(1, medianAgeMonths / 36))
  const dispersionScore = 20 * (1 - Math.min(1, dispersion / 0.6))

  let penalties = 0
  if (input.geocodePrecision === 'approximate') penalties += PENALTIES.geocodeApproximate
  if (input.geocodePrecision === 'city-centroid') penalties += PENALTIES.geocodeCityCentroid
  if (property.dpe === 'unknown') penalties += PENALTIES.dpeUnknown
  if (breakdown.clamped) penalties += PENALTIES.clamped
  if (input.surfaceToleranceWidened) penalties += PENALTIES.wideSurfaceTolerance

  const score = Math.round(
    clamp(countScore + proximity + freshness + dispersionScore - penalties, 0, 100)
  )
  const label = confidenceLabel(score)

  return {
    value,
    pricePerSqm,
    range: {
      low: roundValue(value * (1 - halfWidth)),
      high: roundValue(value * (1 + halfWidth)),
      halfWidthPct: Math.round(halfWidth * 10_000) / 10_000,
      basis: 'iqr',
    },
    confidence: {
      score,
      label,
      breakdown: {
        count: round2(countScore),
        proximity: round2(proximity),
        freshness: round2(freshness),
        dispersion: round2(dispersionScore),
        penalties,
      },
    },
    display: {
      /*
       * ────────────────────────────────────────────────────────────────────
       * DÉCISION CLIENT — LE PRIX EST TOUJOURS AFFICHÉ.
       * ────────────────────────────────────────────────────────────────────
       * Le §3.8 prévoyait `showCentralValue = false` sous 30 points, et le
       * §10 en faisait une décision tranchée. **Le client a tranché en sens
       * inverse.** Le champ est conservé au contrat (le front, le PDF et
       * l'e-mail le lisent déjà) mais vaut toujours `true`.
       *
       * Ce sont désormais l'indice de confiance et les avertissements qui
       * portent, seuls, le signal de fragilité — d'où l'importance de ne
       * jamais les édulcorer.
       */
      showCentralValue: true,
      confidenceLabelFr: confidenceLabelFr(label),
      warnings: buildWarnings({
        level: input.level,
        n,
        score,
        clamped: breakdown.clamped,
        dpeUnknown: property.dpe === 'unknown',
        geocodePrecision: input.geocodePrecision,
        surfaceToleranceWidened: input.surfaceToleranceWidened,
      }),
    },
    method: {
      level: input.level,
      radiusM: input.radiusM,
      windowMonths: input.windowMonths,
      surfaceTolerancePct: input.surfaceTolerancePct,
      comparablesCount: n,
      comparablesRejected: rejected,
      medianPriceM2Raw: Math.round(referencePriceM2),
      timeAdjustmentFactor: Math.round(timeAdjustmentFactor * 10_000) / 10_000,
      coefficients: breakdown,
      landValue: Math.round(landValue),
      dispersion: round4(dispersion),
      medianAgeMonths: round2(medianAgeMonths),
    },
    retained: adjusted,
    insufficientSample: false,
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * §3.9 — Repli départemental (hors DVF)
 * ════════════════════════════════════════════════════════════════════════ */

export interface ReferenceValuationInput {
  property: PropertyInput
  /** €/m² de `references_departementales`. */
  referencePriceM2: number
  coefficients: CoefficientTable
  geocodePrecision: GeocodePrecision
}

/**
 * Valorisation par référence départementale — §3.9.
 *
 * Utilisée **uniquement** pour 57, 67, 68 et 976. La cascade de comparables
 * n'est pas exécutée du tout : sans cette garde, elle descendrait
 * silencieusement au niveau national et présenterait une moyenne nationale
 * comme un prix local. C'est le pire scénario possible, parce qu'il est
 * indétectable par l'utilisateur.
 *
 * `k_surface` vaut 1 : il n'y a pas d'échantillon, donc pas de surface
 * médiane de référence. Inventer une dégressivité ici serait exactement le
 * genre de faux raffinement que la spec proscrit.
 */
export function computeReferenceValuation(input: ReferenceValuationInput): ValuationOutput {
  const { property, coefficients } = input

  const breakdown = computeCoefficients(property, null, coefficients)
  const value = roundValue(input.referencePriceM2 * breakdown.total * property.surface)
  const pricePerSqm = property.surface > 0 ? Math.round(value / property.surface) : null

  let penalties = 0
  if (input.geocodePrecision === 'approximate') penalties += PENALTIES.geocodeApproximate
  if (input.geocodePrecision === 'city-centroid') penalties += PENALTIES.geocodeCityCentroid
  if (property.dpe === 'unknown') penalties += PENALTIES.dpeUnknown
  if (breakdown.clamped) penalties += PENALTIES.clamped

  /*
   * §3.9 : « confidence plafonnée à 35 » — un PLAFOND, pas un malus.
   *
   * L'implémentation précédente calculait `35 − malus`. Strasbourg + DPE
   * inconnu + géocodage au centroïde communal donnait donc 35 − 17 = 18,
   * c'est-à-dire le libellé « Données insuffisantes » (0-29) — alors que
   * §3.9 exige explicitement « l'UI bascule automatiquement en mode confiance
   * faible » (30-49), avec CTA expert. Le repli départemental était ainsi
   * présenté comme une panne de données, ce qu'il n'est pas.
   */
  const computedScore = clamp(REFERENCE_BASE_SCORE - penalties, 0, 100)
  const score = Math.round(Math.min(computedScore, NO_DVF_CONFIDENCE_CAP))
  const label = confidenceLabel(score)

  const warnings = [
    'Les départements du Bas-Rhin, du Haut-Rhin, de la Moselle et de Mayotte relèvent du ' +
      'régime du Livre foncier : leurs transactions ne figurent pas dans la base publique DVF ' +
      'de la DGFiP. Cette estimation repose sur des références départementales et non sur des ' +
      'transactions comparables. Sa précision est nettement réduite ; nous vous recommandons ' +
      'une évaluation sur place.',
  ]
  if (property.dpe === 'unknown') {
    warnings.push(WARNING_DPE_UNKNOWN)
  }
  if (input.geocodePrecision !== 'exact') {
    warnings.push(WARNING_GEOCODE)
  }

  return {
    value,
    pricePerSqm,
    range: {
      // §3.9 : amplitude fixe, faute de dispersion observée à exploiter.
      low: roundValue(value * (1 - REFERENCE_RANGE)),
      high: roundValue(value * (1 + REFERENCE_RANGE)),
      halfWidthPct: REFERENCE_RANGE,
      basis: 'fixed',
    },
    confidence: {
      score,
      label,
      breakdown: { count: 0, proximity: 0, freshness: 0, dispersion: 0, penalties },
    },
    display: {
      showCentralValue: true,
      confidenceLabelFr: confidenceLabelFr(label),
      warnings,
    },
    method: {
      level: 'departement-reference',
      radiusM: null,
      windowMonths: 0,
      surfaceTolerancePct: 0,
      comparablesCount: 0,
      comparablesRejected: {},
      medianPriceM2Raw: Math.round(input.referencePriceM2),
      timeAdjustmentFactor: 1,
      coefficients: breakdown,
      landValue: 0,
      dispersion: 0,
      medianAgeMonths: 0,
    },
    retained: [],
    insufficientSample: false,
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Avertissements — français, prêts à afficher (§5.3 `display.warnings`)
 * ════════════════════════════════════════════════════════════════════════ */

export const WARNING_DPE_UNKNOWN =
  "Le DPE n'est pas renseigné : la valeur verte n'a pas pu être prise en compte."
export const WARNING_GEOCODE =
  "Votre adresse n'a pas pu être localisée précisément : les comparables ont été " +
  'sélectionnés autour d’un point approché.'
export const WARNING_CLAMPED =
  'Les caractéristiques de votre bien sortent des bornes habituelles du marché : ' +
  "l'ajustement appliqué a été plafonné, et l'estimation par comparaison est moins fiable."
export const WARNING_WIDE_TOLERANCE =
  'La tolérance de surface a été élargie à ±40 % pour réunir suffisamment de ventes comparables.'

function levelWarning(level: CascadeLevel): string | null {
  switch (level) {
    case 'radius':
      return null
    case 'commune':
      return 'Faute de ventes assez proches, l’estimation repose sur les transactions de votre commune.'
    case 'epci':
      return 'Faute de ventes assez proches, l’estimation repose sur les transactions de votre intercommunalité.'
    case 'departement':
      return 'Faute de ventes assez proches, l’estimation repose sur les transactions de votre département.'
    case 'region':
      return 'Faute de ventes assez proches, l’estimation repose sur les transactions de votre région.'
    case 'national':
      return (
        'Aucune vente comparable n’a été trouvée à proximité : l’estimation repose sur un ' +
        'échantillon national de biens similaires. Elle ne reflète pas votre marché local.'
      )
    default:
      return null
  }
}

function buildWarnings(context: {
  level: CascadeLevel
  n: number
  score: number
  clamped: boolean
  dpeUnknown: boolean
  geocodePrecision: GeocodePrecision
  surfaceToleranceWidened: boolean
}): string[] {
  const warnings: string[] = []

  const levelMessage = levelWarning(context.level)
  if (levelMessage) {
    warnings.push(levelMessage)
  }
  if (context.n < 10) {
    warnings.push(
      `Seules ${context.n} ventes comparables ont pu être analysées : la fourchette est volontairement large.`
    )
  }
  if (context.surfaceToleranceWidened) {
    warnings.push(WARNING_WIDE_TOLERANCE)
  }
  if (context.clamped) {
    warnings.push(WARNING_CLAMPED)
  }
  if (context.dpeUnknown) {
    warnings.push(WARNING_DPE_UNKNOWN)
  }
  if (context.geocodePrecision !== 'exact') {
    warnings.push(WARNING_GEOCODE)
  }
  if (context.score < 30) {
    /*
     * Le prix reste affiché (décision client), mais l'utilisateur doit savoir
     * exactement ce qu'il vaut. C'est ce message qui porte l'honnêteté du
     * produit à la place de `showCentralValue = false`.
     */
    warnings.push(
      'Les données disponibles sur ce secteur sont trop peu nombreuses pour un chiffre ferme : ' +
        'considérez la fourchette plutôt que la valeur centrale, et faites confirmer par une visite sur place.'
    )
  }

  return warnings
}

/* ══════════════════════════════════════════════════════════════════════════
 * Sortie « échantillon inexploitable »
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Échantillon vide ou entièrement écarté. On ne fabrique **aucun** prix : la
 * cascade est censée avoir garanti `N ≥ 5`, et si elle a échoué jusqu'au
 * niveau national, l'appelant doit répondre `method.kind = 'not-supported'`
 * plutôt que d'afficher un chiffre sans fondement.
 */
function emptyOutput(input: ValuationInput, rejected: Record<string, number>): ValuationOutput {
  return {
    value: null,
    pricePerSqm: null,
    range: { low: 0, high: 0, halfWidthPct: RANGE_MAX, basis: 'fixed' },
    confidence: {
      score: 0,
      label: 'insufficient',
      breakdown: { count: 0, proximity: 0, freshness: 0, dispersion: 0, penalties: 0 },
    },
    display: {
      showCentralValue: true,
      confidenceLabelFr: confidenceLabelFr('insufficient'),
      warnings: [
        'Nous ne disposons pas d’assez de transactions comparables pour estimer ce bien de ' +
          'manière défendable. Un conseiller peut réaliser une évaluation sur place.',
      ],
    },
    method: {
      level: input.level,
      radiusM: input.radiusM,
      windowMonths: input.windowMonths,
      surfaceTolerancePct: input.surfaceTolerancePct,
      comparablesCount: 0,
      comparablesRejected: rejected,
      medianPriceM2Raw: null,
      timeAdjustmentFactor: 1,
      coefficients: {
        surface: 1,
        floor: 1,
        outdoor: 1,
        condition: 1,
        dpe: 1,
        total: 1,
        clamped: false,
      },
      landValue: 0,
      dispersion: 0,
      medianAgeMonths: 0,
    },
    retained: [],
    insufficientSample: true,
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
