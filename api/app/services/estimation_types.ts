import type {
  CascadeLevel,
  ConfidenceLabel,
  DpeClass,
  GeocodePrecision,
  OutdoorKey,
  ConditionKey,
  PropertyType,
} from '#services/valuation_service'

/**
 * Contrat de `POST /v1/estimations` — spec §5.3 et §6.1.
 *
 * Ce fichier est le **contrat public de l'API**. Toute modification d'un champ
 * existant est cassante et impose `/v2` (§6.1) : l'ancienne version reste
 * servie 6 mois. Les ajouts, eux, sont libres — le front est écrit pour
 * tolérer des clés inconnues (US-11).
 */

export interface EstimationRequest {
  address: string
  postalCode: string
  city: string
  propertyType: PropertyType
  surface: number
  rooms?: number | null
  dpe: DpeClass
  floor?: number | null
  hasElevator?: boolean | null
  outdoor?: OutdoorKey | null
  condition?: ConditionKey | null
  terrainSize?: number | null
  lat?: number | null
  lon?: number | null
}

/** Comparable anonymisé — §5.3 et §8.3 : jamais de numéro de voie, jamais de jour. */
export interface EstimationComparable {
  street: string
  city: string
  /** Arrondie au multiple de 50 m. */
  distanceM: number
  /** « 2024-06 » — le mois, jamais le jour. */
  date: string
  propertyType: string
  surface: number
  rooms: number | null
  pricePerSqm: number
  price: number
  timeAdjustedPricePerSqm: number
}

export interface EstimationResult {
  apiVersion: 1
  requestId: string

  value: number | null
  pricePerSqm: number | null

  range: {
    low: number
    high: number
    halfWidthPct: number
    basis: 'iqr' | 'fixed'
  }

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

  display: {
    showCentralValue: boolean
    confidenceLabelFr: string
    warnings: string[]
  }

  method: {
    kind: 'comparables' | 'reference-table' | 'not-supported'
    level: CascadeLevel
    radiusM: number | null
    windowMonths: number
    surfaceTolerancePct: number
    comparablesCount: number
    comparablesRejected: Record<string, number>
    medianPriceM2Raw: number | null
    timeAdjustmentFactor: number
    coefficients: {
      surface: number
      floor: number
      outdoor: number
      condition: number
      dpe: number
      total: number
      clamped: boolean
    }
    /**
     * Provenance des coefficients **réellement appliqués** — §3.6, règle 3.
     *
     * Ajout de contrat (non cassant, US-11 : le front tolère les clés
     * inconnues). Sans lui, `method.coefficients` n'exposait que des nombres
     * et le front ne pouvait pas tenir l'obligation du §3.6 — dire
     * « coefficients de valeur verte de référence, **provisoires** » tant que
     * le Lot 5 n'est pas livré — autrement qu'en la recopiant en dur.
     *
     * Vide si aucun coefficient n'a été appliqué (`not-supported`, ou base de
     * coefficients non provisionnée).
     */
    coefficientSources: Array<{
      key: string
      label: string
      sourceLabel: string
      sourceUrl: string | null
      dateSource: string | null
    }>
    landValue: number
  }

  location: {
    label: string
    cityCode: string | null
    city: string
    postcode: string
    lon: number | null
    lat: number | null
    geocodePrecision: GeocodePrecision
  }

  comparables: EstimationComparable[]

  dataSource: {
    dataCoverage: 'dvf' | 'no-dvf'
    primary: 'DVF' | 'REFERENCE'
    dvfPublicationDate: string | null
    lastImportAt: string | null
    priceIndexQuarter: string | null
    licence: string
    attributionFr: string
    disclaimerFr: string
  }

  computedAt: string
}

/**
 * Avertissement légal du §8.1, **sans exception** sur toute page et tout PDF
 * affichant un prix. Il est servi par l'API et jamais écrit en dur dans le
 * front, pour qu'une révision juridique n'exige pas un redéploiement du site.
 */
export const DISCLAIMER_FR =
  'Cette estimation automatisée ne constitue ni une expertise immobilière, ni un avis de ' +
  "valeur au sens de la Charte de l'expertise en évaluation immobilière. Elle repose sur des " +
  "transactions comparables et ne tient compte ni de l'état intérieur réel du bien, ni de ses " +
  'spécificités (vue, exposition, nuisances, servitudes, travaux votés en copropriété). Seule ' +
  'une visite sur place permet une évaluation engageante.'

/**
 * Variante du §8.1 pour les chemins **sans aucun comparable** — repli
 * départemental §3.9 et `not-supported`.
 *
 * `DISCLAIMER_FR` affirme « Elle repose sur des transactions comparables ».
 * Sur ces chemins `comparables = []` **par construction** : la phrase
 * contredisait, à quelques lignes de distance, le bandeau Livre foncier
 * affiché juste au-dessus, et revendiquait un fondement inexistant — ce que
 * §8.4 (« qualité et honnêteté du chiffre ») interdit.
 */
export const DISCLAIMER_NO_COMPARABLES_FR =
  'Cette estimation automatisée ne constitue ni une expertise immobilière, ni un avis de ' +
  "valeur au sens de la Charte de l'expertise en évaluation immobilière. Elle ne repose sur " +
  'aucune transaction comparable et ne tient compte ni de l’état intérieur réel du bien, ni de ' +
  'ses spécificités (vue, exposition, nuisances, servitudes, travaux votés en copropriété). ' +
  'Seule une visite sur place permet une évaluation engageante.'

/**
 * `dataSource.licence` du chemin `REFERENCE` (§3.9).
 *
 * La Licence Ouverte / Etalab 2.0 couvre les données DVF. Les références
 * départementales n'en viennent pas : les diffuser sous cette licence était
 * une attribution fausse, et §8.2 (point 3) interdit précisément de laisser
 * croire que la DGFiP cautionne un chiffre qui ne vient pas d'elle.
 */
export const REFERENCE_LICENCE_LABEL = 'Références internes — hors Licence Ouverte / Etalab 2.0'

/**
 * Attribution du repli §3.9. **Aucune mention de DVF** : US-6 l'exige
 * explicitement (« aucune mention “source DVF” n'apparaît pour cette
 * estimation »), et la Licence Ouverte interdit de laisser croire que la
 * DGFiP cautionne un chiffre qui ne vient pas d'elle (§8.2, point 3).
 */
export function referenceAttribution(sourceLabel: string, dateSource: string | null): string {
  const date = dateSource ? `, millésime ${dateSource.slice(0, 4)}` : ''
  return (
    `Source : références départementales (${sourceLabel}${date}). Ce territoire relève du ` +
    'régime du Livre foncier ou n’est pas couvert par la base publique de la DGFiP : ' +
    "l'estimation ne repose sur aucune transaction comparable. Géocodage : Base Adresse Nationale."
  )
}
