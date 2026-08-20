import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'

import env from '#start/env'
import { GeocodingService, type GeocodeResult } from '#services/geocoding_service'
import { ComparablesRepository } from '#services/comparables_repository'
import {
  CoefficientsService,
  coefficientSourceKey,
  type CoefficientSource,
  type LoadedCoefficients,
} from '#services/coefficients_service'
import {
  DataVersionService,
  LICENCE_LABEL,
  type DataVersionPayload,
} from '#services/data_version_service'
import { DEPARTMENTS_WITHOUT_DVF } from '#dvf/importer'
import { hashUserAgent, hmacIp } from '#lib/anonymize'
import {
  EstimationCache,
  buildEstimationCacheKey,
  type EstimationCacheKeyParts,
} from '#services/estimation_cache'
import {
  computeReferenceValuation,
  computeValuation,
  confidenceLabelFr,
  floorKey,
  outdoorKey,
  type AdjustedComparable,
  type PropertyInput,
} from '#services/valuation_service'
import {
  DISCLAIMER_FR,
  DISCLAIMER_NO_COMPARABLES_FR,
  REFERENCE_LICENCE_LABEL,
  referenceAttribution,
  type EstimationComparable,
  type EstimationRequest,
  type EstimationResult,
} from '#services/estimation_types'

/**
 * Orchestrateur d'estimation — spec §6.2.
 *
 * géocodage → comparables → coefficients → `computeValuation` → DTO, cache et
 * journal. **Aucune formule ici** : tout le calcul vit dans
 * `valuation_service`, module pur. Ce fichier n'a que des responsabilités
 * d'entrée/sortie, et c'est ce partage qui rend l'algorithme révisable.
 *
 * Trois gardes structurent le flux, dans cet ordre :
 *  1. `local-commercial` → non calculé (§3.2). DVF renseigne trop mal ce
 *     segment ; « il vaut mieux dire “nous vous rappelons” que sortir un
 *     chiffre au hasard ».
 *  2. `has_dvf = false` → repli départemental (§3.9). **La cascade n'est pas
 *     exécutée du tout.**
 *  3. cascade épuisée → `not-supported`, jamais un repêchage d'échantillon
 *     incomplet.
 */

export interface EstimationContext {
  requestId: string
  /**
   * Date du jour, `YYYY-MM-DD`. **Injectée** : c'est ici, et nulle part en
   * aval, que le calcul touche à l'horloge.
   */
  referenceDate: string
  clientIp?: string | null
  userAgent?: string | null
}

interface CommuneInfo {
  codeInsee: string
  nom: string
  codeDepartement: string
  codeRegion: string | null
  codeEpci: string | null
  densiteGrille: number | null
  hasDvf: boolean
}

/** Cache applicatif partagé par le processus (§2.6, point 4). */
const responseCache = new EstimationCache<EstimationResult>(
  env.get('ESTIMATION_CACHE_TTL') ?? 86_400
)

export class EstimationService {
  constructor(
    private readonly geocoding = new GeocodingService(),
    private readonly comparables = new ComparablesRepository(),
    private readonly coefficients = new CoefficientsService(),
    private readonly dataVersion = new DataVersionService()
  ) {}

  /** Vide le cache applicatif — réservé aux tests. */
  static clearCache(): void {
    responseCache.clear()
  }

  /**
   * @param version état des données, **transmis par le contrôleur** quand il
   *        l'a déjà lu (§6.1 : il en a besoin pour le 503 et l'en-tête
   *        `X-Data-Version`). Éviter la double lecture est l'objet même du
   *        paramètre.
   */
  async estimate(
    request: EstimationRequest,
    context: EstimationContext,
    version?: DataVersionPayload
  ): Promise<EstimationResult> {
    const startedAt = Date.now()

    const dataVersion = version ?? (await this.dataVersion.current())

    const cacheKey = buildEstimationCacheKey(
      this.#cacheKeyParts(request, dataVersion.datasetVersion)
    )
    const cached = responseCache.get(cacheKey)

    if (cached) {
      const result = { ...cached, requestId: context.requestId }
      await this.#log(result, request, context, Date.now() - startedAt, true)
      return result
    }

    const { result, cacheable } = await this.#compute(request, context, dataVersion)

    /*
     * ══════════════════════════════════════════════════════════════════════
     * ON NE MET EN CACHE QUE CE QUI EST REPRODUCTIBLE.
     * ══════════════════════════════════════════════════════════════════════
     * Le commentaire l'affirmait déjà ; l'appel, lui, était inconditionnel.
     * Conséquence : un simple dépassement du `statement_timeout` de 2 s
     * (A.6) sur un niveau de cascade — un incident transitoire — figeait un
     * `not-supported` pendant 24 h pour cette adresse, et le bouton
     * « Relancer le calcul » du front devenait inopérant : il ne pouvait que
     * relire la même réponse en cache.
     */
    if (cacheable) {
      responseCache.set(cacheKey, result)
    }

    await this.#log(result, request, context, Date.now() - startedAt, false)
    return result
  }

  /* ── Chemin de calcul ─────────────────────────────────────────────────── */

  /**
   * @returns `cacheable = false` dès qu'un niveau de cascade a été **abandonné**
   *          (incident) ou que la réponse est un `not-supported`. Un
   *          `not-supported` est peu coûteux à recalculer et peut cesser d'être
   *          vrai au prochain import : le figer 24 h n'apporte rien et
   *          désarme le seul recours de l'utilisateur.
   */
  async #compute(
    request: EstimationRequest,
    context: EstimationContext,
    version: DataVersionPayload
  ): Promise<{ result: EstimationResult; cacheable: boolean }> {
    const geocode = await this.#resolveLocation(request)
    const commune = await this.#lookupCommune(geocode.cityCode, request.postalCode)

    const coefficients = await this.coefficients.load()
    const coefficientTable = coefficients.table

    const property: PropertyInput = {
      propertyType: request.propertyType,
      surface: request.surface,
      rooms: request.rooms ?? null,
      dpe: request.dpe,
      floor: request.floor ?? null,
      hasElevator: request.hasElevator ?? null,
      outdoor: request.outdoor ?? null,
      condition: request.condition ?? null,
      terrainSize: request.terrainSize ?? null,
    }

    /* Garde 1 — `local-commercial` (§3.2) ------------------------------- */
    if (request.propertyType === 'local-commercial') {
      return {
        result: this.#notSupported(geocode, context, version, 'dvf', [
          'Les locaux commerciaux ne sont pas estimables à partir de la base DVF, qui renseigne ' +
            'très mal ce segment. Un conseiller vous recontacte pour une évaluation dédiée.',
        ]),
        cacheable: false,
      }
    }

    /* Garde 2 — territoires hors DVF (§3.9) ------------------------------ */
    const codeDepartement = commune?.codeDepartement ?? departmentFromPostcode(request.postalCode)
    const hasDvf = this.#hasDvf(commune, codeDepartement, geocode)

    if (!hasDvf) {
      return this.#referenceTable({
        request,
        property,
        geocode,
        commune,
        codeDepartement,
        coefficients,
        context,
        version,
      })
    }

    /* Cascade de comparables (§3.2) -------------------------------------- */
    const comparableType = request.propertyType as 'appartement' | 'maison' | 'terrain'

    const set =
      geocode.lon === null || geocode.lat === null
        ? null
        : await this.comparables.findComparables({
            lon: geocode.lon,
            lat: geocode.lat,
            codeInsee: commune?.codeInsee ?? geocode.cityCode,
            codeEpci: commune?.codeEpci ?? null,
            codeDepartement: codeDepartement,
            codeRegion: commune?.codeRegion ?? null,
            densiteGrille: commune?.densiteGrille ?? null,
            propertyType: comparableType,
            surface: request.surface,
            referenceDate: context.referenceDate,
          })

    /*
     * A.6 : un niveau abandonné (dépassement du `statement_timeout` de 2 s ou
     * erreur SQL) est un **incident**, pas un fait de marché. La réponse qui
     * en découle n'est pas reproductible et ne doit donc pas être mise en
     * cache 24 h.
     */
    const hadIncident = (set?.attempts ?? []).some((attempt) => attempt.abandoned === true)

    if (!set || !set.found) {
      /*
       * Garde 3. La cascade est allée jusqu'au niveau national sans réunir
       * 5 comparables exploitables. On ne « repêche » pas le meilleur niveau
       * incomplet : trois ventes ne font pas un prix défendable.
       */
      return {
        result: this.#notSupported(geocode, context, version, 'dvf', [
          'Nous ne disposons pas encore d’assez de transactions comparables sur ce secteur pour ' +
            'produire une estimation défendable. Un conseiller peut réaliser une évaluation sur place.',
        ]),
        cacheable: false,
      }
    }

    const landPricePerSqm =
      request.propertyType === 'maison' && (request.terrainSize ?? 0) > 0
        ? await this.comparables.landPricePerSqm(
            commune?.codeInsee ?? geocode.cityCode,
            codeDepartement
          )
        : null

    const valuation = computeValuation({
      property,
      comparables: set.items,
      coefficients: coefficientTable,
      geocodePrecision: geocode.precision,
      level: set.level,
      radiusM: set.radiusM,
      windowMonths: set.windowMonths,
      surfaceTolerancePct: set.surfaceTolerancePct,
      surfaceToleranceWidened: set.surfaceToleranceWidened,
      /*
       * Mêmes bornes que celles ayant servi à ACCEPTER le niveau (§3.3,
       * point 4). Sans ce passage, la valorisation retombait sur les bornes du
       * bâti (200 €/m² minimum) et écartait l'intégralité d'un échantillon de
       * terrains à 50 €/m², pourtant validé par la cascade.
       */
      sampleBounds: set.sampleBounds,
      landPricePerSqm,
      referenceDate: context.referenceDate,
    })

    if (valuation.insufficientSample) {
      return {
        result: this.#notSupported(geocode, context, version, 'dvf', valuation.display.warnings),
        cacheable: false,
      }
    }

    return {
      cacheable: !hadIncident,
      result: {
        apiVersion: 1,
        requestId: context.requestId,
        value: valuation.value,
        pricePerSqm: valuation.pricePerSqm,
        range: valuation.range,
        confidence: valuation.confidence,
        display: valuation.display,
        method: {
          kind: 'comparables',
          level: valuation.method.level,
          radiusM: valuation.method.radiusM,
          windowMonths: valuation.method.windowMonths,
          surfaceTolerancePct: valuation.method.surfaceTolerancePct,
          comparablesCount: valuation.method.comparablesCount,
          comparablesRejected: valuation.method.comparablesRejected,
          medianPriceM2Raw: valuation.method.medianPriceM2Raw,
          timeAdjustmentFactor: valuation.method.timeAdjustmentFactor,
          coefficients: valuation.method.coefficients,
          coefficientSources: collectCoefficientSources({
            property,
            sources: coefficients.sources,
            landFallbackUsed: valuation.method.landValue !== 0 && landPricePerSqm === null,
          }),
          landValue: valuation.method.landValue,
        },
        location: this.#location(geocode, commune),
        comparables: anonymizeComparables(valuation.retained),
        dataSource: {
          dataCoverage: 'dvf',
          primary: 'DVF',
          dvfPublicationDate: version.dvfPublicationDate,
          lastImportAt: version.lastImportAt,
          priceIndexQuarter: version.priceIndexQuarter,
          licence: LICENCE_LABEL,
          attributionFr: version.attributionFr,
          disclaimerFr: DISCLAIMER_FR,
        },
        computedAt: new Date().toISOString(),
      },
    }
  }

  /* ── §3.9 — repli départemental ───────────────────────────────────────── */

  async #referenceTable(options: {
    request: EstimationRequest
    property: PropertyInput
    geocode: GeocodeResult
    commune: CommuneInfo | null
    codeDepartement: string | null
    coefficients: LoadedCoefficients
    context: EstimationContext
    version: DataVersionPayload
  }): Promise<{ result: EstimationResult; cacheable: boolean }> {
    const { request, property, geocode, commune, codeDepartement, context, version } = options

    // Le repli n'a de sens que pour un logement : ni terrain, ni local
    // commercial n'ont de référence départementale sourcée.
    const typeBien = request.propertyType === 'maison' ? 'maison' : 'appartement'

    const reference = codeDepartement
      ? await this.coefficients.departmentReference(codeDepartement, typeBien)
      : null

    if (!reference || request.propertyType === 'terrain') {
      return {
        /*
         * `dataCoverage: 'no-dvf'` et non `'dvf'` : on est arrivé ici PARCE
         * QUE le territoire est hors DVF. Annoncer une couverture DVF sur ce
         * chemin faisait afficher au front une mention de source qui ne
         * correspond à rien (§8.2, point 3).
         */
        result: this.#notSupported(geocode, context, version, 'no-dvf', [
          'Ce territoire n’est pas couvert par la base publique DVF (régime du Livre foncier ou ' +
            'Mayotte) et nous ne disposons pas de référence départementale pour ce type de bien. ' +
            'Un conseiller vous recontacte.',
        ]),
        cacheable: false,
      }
    }

    const valuation = computeReferenceValuation({
      property,
      referencePriceM2: reference.prixM2,
      coefficients: options.coefficients.table,
      geocodePrecision: geocode.precision,
    })

    return {
      // Chemin entièrement déterministe : aucune requête de cascade, donc
      // aucun incident possible à figer.
      cacheable: true,
      result: {
        apiVersion: 1,
        requestId: context.requestId,
        value: valuation.value,
        pricePerSqm: valuation.pricePerSqm,
        range: valuation.range,
        confidence: valuation.confidence,
        display: valuation.display,
        method: {
          kind: 'reference-table',
          level: 'departement-reference',
          radiusM: null,
          windowMonths: 0,
          surfaceTolerancePct: 0,
          comparablesCount: 0,
          comparablesRejected: {},
          medianPriceM2Raw: valuation.method.medianPriceM2Raw,
          timeAdjustmentFactor: 1,
          coefficients: valuation.method.coefficients,
          coefficientSources: collectCoefficientSources({
            property,
            sources: options.coefficients.sources,
            landFallbackUsed: false,
          }),
          landValue: 0,
        },
        location: this.#location(geocode, commune),
        // §3.9 : « comparables = [] ». Il n'y a rien à montrer, et prétendre le
        // contraire serait le seul vrai mensonge possible ici.
        comparables: [],
        dataSource: {
          dataCoverage: 'no-dvf',
          primary: 'REFERENCE',
          dvfPublicationDate: null,
          lastImportAt: null,
          priceIndexQuarter: null,
          /*
           * Surtout PAS la Licence Ouverte : elle couvre les données DVF, dont
           * ce chiffre ne vient pas. Voir `REFERENCE_LICENCE_LABEL`.
           */
          licence: REFERENCE_LICENCE_LABEL,
          attributionFr: referenceAttribution(reference.sourceLabel, reference.dateSource),
          // `comparables = []` : l'avertissement ne peut pas invoquer des
          // « transactions comparables » qui n'existent pas (§8.4).
          disclaimerFr: DISCLAIMER_NO_COMPARABLES_FR,
        },
        computedAt: new Date().toISOString(),
      },
    }
  }

  /* ── `not-supported` ──────────────────────────────────────────────────── */

  /**
   * @param dataCoverage couverture **réelle** du territoire. Le repli §3.9 qui
   *        échoue faute de référence départementale reste un territoire
   *        `no-dvf` : lui coller `'dvf'` faisait afficher une attribution DVF
   *        sur un chemin qui n'a jamais touché DVF.
   */
  #notSupported(
    geocode: GeocodeResult,
    context: EstimationContext,
    version: DataVersionPayload,
    dataCoverage: 'dvf' | 'no-dvf',
    warnings: string[]
  ): EstimationResult {
    return {
      apiVersion: 1,
      requestId: context.requestId,
      // §5.3 : « value : null si method.kind === 'not-supported' ».
      value: null,
      pricePerSqm: null,
      range: { low: 0, high: 0, halfWidthPct: 0, basis: 'fixed' },
      confidence: {
        score: 0,
        label: 'insufficient',
        breakdown: { count: 0, proximity: 0, freshness: 0, dispersion: 0, penalties: 0 },
      },
      display: {
        /*
         * Annexe B.1 : « `display.showCentralValue` reste dans le DTO mais
         * renvoie TOUJOURS `true` ». Ce chemin renvoyait `false`.
         *
         * Sans conséquence visible — `value` est `null` ici, il n'y a donc
         * aucune valeur centrale à masquer — mais c'est une divergence de
         * contrat, et l'annexe existe précisément pour empêcher qu'on
         * « recorrige » le code vers la version initiale de la spec. Un
         * consommateur qui branche une logique sur ce champ (PDF, e-mail
         * interne) doit lire la même règle partout.
         */
        showCentralValue: true,
        confidenceLabelFr: confidenceLabelFr('insufficient'),
        warnings,
      },
      method: {
        kind: 'not-supported',
        level: 'national',
        radiusM: null,
        windowMonths: 0,
        surfaceTolerancePct: 0,
        comparablesCount: 0,
        comparablesRejected: {},
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
        // Aucun coefficient n'a été appliqué : rien à sourcer.
        coefficientSources: [],
        landValue: 0,
      },
      location: this.#location(geocode, null),
      comparables: [],
      dataSource: {
        dataCoverage,
        primary: dataCoverage === 'no-dvf' ? 'REFERENCE' : 'DVF',
        dvfPublicationDate: dataCoverage === 'no-dvf' ? null : version.dvfPublicationDate,
        lastImportAt: dataCoverage === 'no-dvf' ? null : version.lastImportAt,
        priceIndexQuarter: dataCoverage === 'no-dvf' ? null : version.priceIndexQuarter,
        licence: dataCoverage === 'no-dvf' ? REFERENCE_LICENCE_LABEL : LICENCE_LABEL,
        attributionFr:
          dataCoverage === 'no-dvf'
            ? 'Ce territoire n’est pas couvert par la base publique DVF de la DGFiP ' +
              '(régime du Livre foncier ou Mayotte). Aucune estimation n’a pu être produite.'
            : version.attributionFr,
        // Aucun prix n'est rendu, mais l'avertissement ne doit pas davantage
        // invoquer des comparables inexistants.
        disclaimerFr: DISCLAIMER_NO_COMPARABLES_FR,
      },
      computedAt: new Date().toISOString(),
    }
  }

  /* ── Localisation ─────────────────────────────────────────────────────── */

  /**
   * §6.1 : « `lat`, `lon` — si fournis **et cohérents avec `postalCode`**, le
   * géocodage BAN est court-circuité ».
   *
   * La cohérence est vérifiée, sans quoi n'importe quel appelant pourrait
   * faire calculer une estimation « à Guéret » sur des comparables parisiens
   * en envoyant un couple de coordonnées arbitraire.
   *
   * La précision annoncée reste `approximate` : nous ne savons pas comment
   * l'appelant a obtenu ces coordonnées. Les créditer d'une précision
   * `exact` reviendrait à offrir 5 points de confiance à une information
   * dont nous ignorons la qualité.
   */
  async #resolveLocation(request: EstimationRequest): Promise<GeocodeResult> {
    if (
      typeof request.lat === 'number' &&
      typeof request.lon === 'number' &&
      Number.isFinite(request.lat) &&
      Number.isFinite(request.lon)
    ) {
      const commune = await this.#communeNearPoint(request.postalCode, request.lon, request.lat)

      if (commune) {
        return {
          label: `${commune.nom} ${request.postalCode}`.trim(),
          cityCode: commune.codeInsee,
          city: commune.nom,
          postcode: request.postalCode,
          lon: request.lon,
          lat: request.lat,
          score: null,
          resultType: 'provided',
          precision: 'approximate',
          hasDvf: commune.hasDvf,
          source: 'none',
        }
      }
      // Coordonnées incohérentes avec le code postal : on les ignore et on
      // géocode normalement plutôt que d'échouer.
    }

    return this.geocoding.geocode({
      address: request.address,
      postalCode: request.postalCode,
      city: request.city,
    })
  }

  #location(geocode: GeocodeResult, commune: CommuneInfo | null): EstimationResult['location'] {
    return {
      label: geocode.label,
      cityCode: geocode.cityCode ?? commune?.codeInsee ?? null,
      city: commune?.nom ?? geocode.city,
      postcode: geocode.postcode,
      lon: geocode.lon,
      lat: geocode.lat,
      geocodePrecision: geocode.precision,
    }
  }

  /**
   * `has_dvf` de la commune. À défaut de commune connue, on retombe sur la
   * liste des départements non couverts (§1.3) : mieux vaut déclencher le
   * repli à tort que présenter une moyenne nationale comme un prix strasbourgeois.
   */
  #hasDvf(
    commune: CommuneInfo | null,
    codeDepartement: string | null,
    geocode: GeocodeResult
  ): boolean {
    if (commune) {
      return commune.hasDvf
    }
    if (codeDepartement && DEPARTMENTS_WITHOUT_DVF.includes(codeDepartement)) {
      return false
    }
    return geocode.hasDvf
  }

  /* ── Accès référentiel ────────────────────────────────────────────────── */

  async #lookupCommune(codeInsee: string | null, postalCode: string): Promise<CommuneInfo | null> {
    try {
      if (codeInsee) {
        const byInsee = await db.rawQuery(
          `SELECT code_insee, nom, code_departement, code_region, code_epci, densite_grille, has_dvf
             FROM communes WHERE code_insee = ? LIMIT 1`,
          [codeInsee]
        )
        const row = byInsee.rows?.[0]
        if (row) {
          return mapCommune(row)
        }
      }

      const byPostcode = await db.rawQuery(
        `SELECT code_insee, nom, code_departement, code_region, code_epci, densite_grille, has_dvf
           FROM communes
          WHERE ? = ANY (codes_postaux)
          ORDER BY population DESC NULLS LAST
          LIMIT 1`,
        [postalCode]
      )
      const row = byPostcode.rows?.[0]
      return row ? mapCommune(row) : null
    } catch (error) {
      logger.warn({ err: error }, 'Référentiel communal indisponible')
      return null
    }
  }

  /**
   * Commune du code postal la plus proche du point fourni. Au-delà de 30 km,
   * on considère le couple (coordonnées, code postal) incohérent : c'est
   * large pour une commune rurale étendue, et bien trop étroit pour laisser
   * passer un point situé dans un autre département.
   */
  async #communeNearPoint(
    postalCode: string,
    lon: number,
    lat: number
  ): Promise<CommuneInfo | null> {
    try {
      const result = await db.rawQuery(
        `SELECT code_insee, nom, code_departement, code_region, code_epci, densite_grille, has_dvf,
                ST_Distance(centroid, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography) AS distance_m
           FROM communes
          WHERE ? = ANY (codes_postaux)
          ORDER BY distance_m ASC
          LIMIT 1`,
        [lon, lat, postalCode]
      )

      const row = result.rows?.[0]
      if (!row || Number(row.distance_m) > 30_000) {
        return null
      }
      return mapCommune(row)
    } catch (error) {
      logger.warn({ err: error }, 'Vérification de cohérence des coordonnées impossible')
      return null
    }
  }

  /* ── Journalisation anonymisée (§8.3) ─────────────────────────────────── */

  #cacheKeyParts(
    request: EstimationRequest,
    datasetVersion: string | null
  ): EstimationCacheKeyParts {
    return {
      lat: request.lat ?? null,
      lon: request.lon ?? null,
      cityCode: null,
      propertyType: request.propertyType,
      surface: request.surface,
      dpe: request.dpe,
      options: [
        request.postalCode,
        request.city.trim().toLowerCase(),
        request.address.trim().toLowerCase(),
        request.rooms ?? '',
        request.floor ?? '',
        request.hasElevator ?? '',
        request.outdoor ?? '',
        request.condition ?? '',
        request.terrainSize ?? '',
      ],
      datasetVersion,
    }
  }

  /**
   * Journalise **sans aucune PII** : ni adresse, ni nom de voie, ni
   * coordonnées — seulement le code INSEE (§8.3). L'IP n'apparaît que sous
   * forme de HMAC salé.
   *
   * Une écriture ratée n'invalide jamais une estimation déjà calculée : le
   * journal sert au pilotage qualité, pas au service rendu.
   */
  async #log(
    result: EstimationResult,
    request: EstimationRequest,
    context: EstimationContext,
    durationMs: number,
    cacheHit: boolean
  ): Promise<void> {
    try {
      await db.rawQuery(
        `INSERT INTO estimations_log (
           code_insee, code_departement, type_bien, surface,
           method_kind, method_level, radius_m, n_comparables, confidence,
           value_low, value_mid, value_high, price_m2,
           duration_ms, cache_hit, ip_hmac, ua_hash, api_version
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          result.location.cityCode,
          departmentFromInsee(result.location.cityCode) ??
            departmentFromPostcode(request.postalCode),
          request.propertyType,
          Math.round(request.surface),
          result.method.kind,
          result.method.level,
          result.method.radiusM,
          result.method.comparablesCount,
          result.confidence.score,
          result.value === null ? null : result.range.low,
          result.value,
          result.value === null ? null : result.range.high,
          result.pricePerSqm,
          durationMs,
          cacheHit,
          hmacIp(context.clientIp ?? null, env.get('IP_HASH_SALT')),
          hashUserAgent(context.userAgent ?? null),
          1,
        ]
      )
    } catch (error) {
      logger.warn({ err: error }, 'Journalisation d’estimation impossible')
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Provenance des coefficients appliqués — §3.6, règle 3
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Sélectionne, parmi les lignes de `coefficients_reference`, celles dont le
 * coefficient a **réellement** été appliqué à ce bien.
 *
 * On expose les clés appliquées plutôt que toute la table : afficher les
 * vingt lignes sur chaque réponse serait du bruit, et l'utilisateur n'a pas à
 * lire la source d'un coefficient d'étage pour une maison.
 *
 * Les clés sont dérivées des mêmes fonctions pures que le calcul lui-même
 * (`floorKey`, `outdoorKey`) : impossible d'annoncer une source pour un
 * coefficient qui n'aurait pas été appliqué, ou l'inverse.
 *
 * **Fonction pure**, exportée pour être testée sans base.
 */
export function collectCoefficientSources(options: {
  property: PropertyInput
  sources: Map<string, CoefficientSource>
  /** `true` si `V_terrain` a utilisé le repli forfaitaire du §3.6. */
  landFallbackUsed: boolean
}): CoefficientSource[] {
  const { property, sources } = options
  const builtType = property.propertyType === 'maison' ? 'maison' : 'appartement'

  /*
   * Une même clé peut être stockée pour un type précis ou pour `all` (§5.1 :
   * unicité sur `(cle, type_bien, …)`). On tente les deux variantes, dans
   * l'ordre de spécificité, et l'on retient la première trouvée.
   */
  const wanted: string[] = [coefficientSourceKey('surface.alpha', builtType)]

  if (property.dpe !== 'unknown') {
    wanted.push(
      coefficientSourceKey(`dpe.${property.dpe}`, builtType),
      coefficientSourceKey(`dpe.${property.dpe}`, 'all')
    )
  }
  if (property.condition) {
    wanted.push(
      coefficientSourceKey(`etat.${property.condition}`, 'all'),
      coefficientSourceKey(`etat.${property.condition}`, builtType)
    )
  }

  const floor = floorKey(property)
  if (floor) {
    wanted.push(
      coefficientSourceKey(`etage.${floor}`, 'appartement'),
      coefficientSourceKey(`etage.${floor}`, 'all')
    )
  }

  const outdoor = outdoorKey(property)
  if (outdoor) {
    wanted.push(
      coefficientSourceKey(`exterieur.${outdoor}`, 'all'),
      coefficientSourceKey(`exterieur.${outdoor}`, 'appartement')
    )
  }

  if (options.landFallbackUsed) {
    wanted.push(coefficientSourceKey('terrain.fallback_ratio', 'all'))
  }

  const seen = new Set<string>()
  const collected: CoefficientSource[] = []

  for (const key of wanted) {
    const source = sources.get(key)
    // Une clé absente n'est pas une erreur : le coefficient a alors valu 1,00
    // (`coefficients_service`), il n'y a donc rien à sourcer.
    if (source && !seen.has(source.key)) {
      seen.add(source.key)
      collected.push(source)
    }
  }

  return collected
}

/* ══════════════════════════════════════════════════════════════════════════
 * Anonymisation des comparables — §5.3 et §8.3
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * « Distances arrondies à 50 m, dates au mois, prix arrondis », et **jamais
 * de numéro de voie** (§8.3).
 *
 * Ce n'est pas de la cosmétique : à l'échelle d'une petite commune, numéro +
 * date exacte + prix suffisent à identifier un vendeur. Le nom de voie seul,
 * lui, est déjà ce que la base contient (le numéro n'est pas ingéré).
 *
 * Fonction pure, exportée pour être testée sans base.
 */
export function anonymizeComparables(
  retained: AdjustedComparable[],
  limit = 5
): EstimationComparable[] {
  return [...retained]
    .sort(
      (a, b) =>
        (a.distanceMetres ?? Number.MAX_SAFE_INTEGER) -
        (b.distanceMetres ?? Number.MAX_SAFE_INTEGER)
    )
    .slice(0, limit)
    .map((item) => ({
      street: item.street ?? '',
      city: item.city ?? '',
      distanceM: item.distanceMetres === null ? 0 : Math.round(item.distanceMetres / 50) * 50,
      // Le mois, jamais le jour.
      date: item.dateMutation.slice(0, 7),
      propertyType: item.propertyType ?? '',
      surface: Math.round(item.surface),
      rooms: item.rooms ?? null,
      pricePerSqm: Math.round(item.prixM2 / 10) * 10,
      price: Math.round((item.valeurFonciere ?? item.prixM2 * item.surface) / 1_000) * 1_000,
      timeAdjustedPricePerSqm: Math.round(item.adjustedPriceM2 / 10) * 10,
    }))
}

/* ══════════════════════════════════════════════════════════════════════════
 * Utilitaires
 * ════════════════════════════════════════════════════════════════════════ */

function mapCommune(row: Record<string, unknown>): CommuneInfo {
  return {
    codeInsee: String(row.code_insee).trim(),
    nom: String(row.nom),
    codeDepartement: String(row.code_departement).trim(),
    codeRegion: row.code_region === null ? null : String(row.code_region).trim(),
    codeEpci: row.code_epci === null ? null : String(row.code_epci).trim(),
    densiteGrille: row.densite_grille === null ? null : Number(row.densite_grille),
    hasDvf: Boolean(row.has_dvf),
  }
}

/**
 * Département déduit du code postal. Approximation volontairement simple,
 * utilisée **uniquement** en repli quand le référentiel communal ne répond
 * pas ; elle suffit à déclencher le repli §3.9 sur 57/67/68/976, qui est le
 * cas où se tromper coûte le plus cher.
 *
 * Fonction pure, exportée pour être testée.
 */
/**
 * Département déduit d'un code INSEE. `97xxx`/`98xxx` → 3 caractères (DOM),
 * `2A`/`2B` → la Corse conserve sa lettre. Fonction pure.
 */
export function departmentFromInsee(codeInsee: string | null): string | null {
  if (!codeInsee || codeInsee.length < 2) {
    return null
  }
  if (codeInsee.startsWith('97') || codeInsee.startsWith('98')) {
    return codeInsee.slice(0, 3)
  }
  return codeInsee.slice(0, 2)
}

export function departmentFromPostcode(postalCode: string): string | null {
  const value = (postalCode ?? '').trim()
  if (!/^\d{5}$/.test(value)) {
    return null
  }
  // 97xxx / 98xxx : DOM-COM, le code département fait 3 chiffres.
  if (value.startsWith('97') || value.startsWith('98')) {
    return value.slice(0, 3)
  }
  return value.slice(0, 2)
}
