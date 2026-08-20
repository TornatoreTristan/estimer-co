import { createHash } from 'node:crypto'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import logger from '@adonisjs/core/services/logger'

/**
 * Géocodage BAN avec cache — spec §3.1, §6.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE CENTRALE : CE SERVICE NE REJETTE JAMAIS.
 * ══════════════════════════════════════════════════════════════════════════
 * « Un échec BAN ne fait jamais échouer l'estimation : on descend en
 * précision » (§3.1). La méthode `geocode()` retourne donc toujours un
 * `GeocodeResult`, au pire avec `precision: 'city-centroid'`. C'est ce qui
 * garantit qu'une indisponibilité d'un service public tiers ne se transforme
 * pas en panne de notre tunnel de conversion.
 *
 * Cascade : cache base → BAN → centroïde de commune.
 */

export type GeocodePrecision = 'exact' | 'approximate' | 'city-centroid'

export interface GeocodeInput {
  address: string
  postalCode: string
  city: string
}

export interface GeocodeResult {
  label: string
  cityCode: string | null
  city: string
  postcode: string
  lon: number | null
  lat: number | null
  score: number | null
  resultType: string | null
  precision: GeocodePrecision
  hasDvf: boolean
  /** Origine effective du résultat — utile au diagnostic et aux tests. */
  source: 'cache' | 'ban' | 'commune-centroid' | 'none'
}

/** Abstraction du client BAN, pour bouchonner le réseau dans les tests. */
export interface BanClient {
  search(params: { q: string; postcode?: string; limit?: number }): Promise<BanFeature | null>
}

export interface BanFeature {
  label: string
  score: number
  type: string
  citycode: string
  city: string
  postcode: string
  lon: number
  lat: number
}

/**
 * Client BAN réel.
 *
 * Timeout 3 s et **1 retry** (§3.1). Le retry ne concerne que les erreurs
 * réseau et 5xx : réessayer un 400 ne ferait que doubler la charge sur un
 * service public pour le même échec.
 */
export class HttpBanClient implements BanClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 3_000,
    private readonly retries = 1
  ) {}

  async search(params: {
    q: string
    postcode?: string
    limit?: number
  }): Promise<BanFeature | null> {
    const url = new URL('/search/', this.baseUrl)
    url.searchParams.set('q', params.q)
    url.searchParams.set('limit', String(params.limit ?? 1))
    if (params.postcode) {
      url.searchParams.set('postcode', params.postcode)
    }

    let lastError: unknown = null

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        })

        if (response.status >= 500) {
          lastError = new Error(`BAN HTTP ${response.status}`)
          continue
        }

        if (!response.ok) {
          // 4xx : la requête est en cause, réessayer est inutile.
          return null
        }

        const payload = (await response.json()) as BanSearchResponse
        return parseBanResponse(payload)
      } catch (error) {
        lastError = error
      }
    }

    if (lastError) {
      logger.warn({ err: lastError }, 'Géocodage BAN indisponible, repli en cours')
    }

    return null
  }
}

interface BanSearchResponse {
  features?: Array<{
    geometry?: { coordinates?: [number, number] }
    properties?: Record<string, unknown>
  }>
}

/** Extraction de la première entité exploitable. Fonction pure. */
export function parseBanResponse(payload: BanSearchResponse): BanFeature | null {
  const feature = payload.features?.[0]
  const properties = feature?.properties
  const coordinates = feature?.geometry?.coordinates

  if (!properties || !coordinates || coordinates.length < 2) {
    return null
  }

  const [lon, lat] = coordinates
  if (typeof lon !== 'number' || typeof lat !== 'number') {
    return null
  }

  return {
    label: String(properties.label ?? ''),
    score: typeof properties.score === 'number' ? properties.score : 0,
    type: String(properties.type ?? ''),
    citycode: String(properties.citycode ?? ''),
    city: String(properties.city ?? ''),
    postcode: String(properties.postcode ?? ''),
    lon,
    lat,
  }
}

/**
 * Classement de la qualité d'un résultat BAN — §3.1.
 *
 * Fonction pure : c'est la règle métier qui pilote le malus de confiance du
 * §3.8, elle doit être testable sans réseau.
 */
export function classifyPrecision(type: string, score: number): GeocodePrecision | 'reject' {
  /*
   * Le seuil de 0,4 est évalué EN PREMIER, et il n'a pas d'exception.
   *
   * L'écriture précédente — `type === 'street' || type === 'locality' ||
   * (score >= 0.4 && score < 0.7)` — court-circuitait le seuil : un résultat
   * `type: 'street'` avec `score: 0,2` était classé `approximate`. §3.1 impose
   * au contraire de replier sur le centroïde communal sous 0,4. Conséquence
   * concrète : les comparables étaient sélectionnés dans un rayon de 500 m
   * autour d'une rue que la BAN elle-même jugeait douteuse, et l'estimation ne
   * subissait que le malus de 5 points au lieu de 12.
   */
  if (!Number.isFinite(score) || score < 0.4) {
    return 'reject'
  }
  if (type === 'housenumber' && score >= 0.7) {
    return 'exact'
  }
  if (type === 'street' || type === 'locality') {
    return 'approximate'
  }
  if (score < 0.7) {
    return 'approximate'
  }
  // Un type non géocodable à l'adresse (`municipality`, `district`…), même
  // très bien noté, ne désigne pas un bien : on repliera sur le centroïde.
  return 'reject'
}

/** Clé de cache : SHA-256 de la requête normalisée (§3.1). */
export function buildQueryHash(input: GeocodeInput): string {
  const normalized = [input.address, input.postalCode, input.city]
    .map((part) => (part ?? '').trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|')

  return createHash('sha256').update(normalized).digest('hex')
}

export class GeocodingService {
  constructor(
    private readonly ban: BanClient = new HttpBanClient(env.get('BAN_API_URL')),
    private readonly ttlDays: number = env.get('GEOCODE_CACHE_TTL_DAYS') ?? 90
  ) {}

  /**
   * Géocode une adresse. **Ne rejette jamais.**
   */
  async geocode(input: GeocodeInput): Promise<GeocodeResult> {
    const queryHash = buildQueryHash(input)

    /* 1 — Cache base ---------------------------------------------------- */
    const cached = await this.#readCache(queryHash)
    if (cached) {
      return cached
    }

    /* 2 — BAN ----------------------------------------------------------- */
    const query = [input.address, input.city].filter(Boolean).join(' ').trim()
    let feature: BanFeature | null = null

    try {
      feature = await this.ban.search({ q: query, postcode: input.postalCode, limit: 1 })
    } catch (error) {
      // Un client bouchonné qui lève ne doit pas davantage faire échouer
      // l'estimation qu'une panne réseau réelle.
      logger.warn({ err: error }, 'Client BAN en erreur, repli sur le centroïde communal')
      feature = null
    }

    if (feature) {
      const precision = classifyPrecision(feature.type, feature.score)

      if (precision !== 'reject') {
        const hasDvf = await this.#hasDvf(feature.citycode)
        const result: GeocodeResult = {
          label: feature.label,
          cityCode: feature.citycode || null,
          city: feature.city || input.city,
          postcode: feature.postcode || input.postalCode,
          lon: feature.lon,
          lat: feature.lat,
          score: feature.score,
          resultType: feature.type,
          precision,
          hasDvf,
          source: 'ban',
        }

        await this.#writeCache(queryHash, input, result)
        return result
      }
    }

    /* 3 — Repli : centroïde de la commune (§3.1) ------------------------ */
    const fallback = await this.#cityCentroid(input)

    // Le repli est mis en cache lui aussi : sans cela, une adresse
    // introuvable interrogerait la BAN à chaque tentative de l'utilisateur.
    await this.#writeCache(queryHash, input, fallback)

    return fallback
  }

  /* ── Cache ─────────────────────────────────────────────────────────── */

  async #readCache(queryHash: string): Promise<GeocodeResult | null> {
    const row = await db
      .from('geocode_cache')
      .select(
        'label',
        'code_insee',
        'city',
        'postcode',
        'longitude',
        'latitude',
        'score',
        'result_type',
        'precision'
      )
      .where('query_hash', queryHash)
      .where('expires_at', '>', new Date())
      .first()

    if (!row) {
      return null
    }

    const hasDvf = await this.#hasDvf(row.code_insee)

    return {
      label: row.label ?? '',
      cityCode: row.code_insee ?? null,
      city: row.city ?? '',
      postcode: row.postcode ?? '',
      lon: row.longitude === null ? null : Number(row.longitude),
      lat: row.latitude === null ? null : Number(row.latitude),
      score: row.score === null ? null : Number(row.score),
      resultType: row.result_type ?? null,
      precision: (row.precision ?? 'city-centroid') as GeocodePrecision,
      hasDvf,
      source: 'cache',
    }
  }

  async #writeCache(queryHash: string, input: GeocodeInput, result: GeocodeResult): Promise<void> {
    const expiresAt = DateTime.utc().plus({ days: this.ttlDays }).toSQL({ includeOffset: false })
    const query = `${input.address} ${input.postalCode} ${input.city}`.trim()

    try {
      /*
       * Paramètres **nommés** ici, positionnels dans `comparables_repository`.
       * La divergence est délibérée et sans piège : Knex distingue
       * parfaitement `:nom` de l'opérateur de transtypage `::type`, comme le
       * montre `:lon::double precision` ci-dessous.
       *
       * Le critère est la lisibilité, pas une contrainte technique. Ici,
       * quinze colonnes plus un `ON CONFLICT` : nommer évite de compter les
       * `?`. Sur le chemin chaud des comparables, au contraire, les requêtes
       * doivent pouvoir être copiées telles quelles dans un `EXPLAIN ANALYZE`,
       * ce que seule une liste positionnelle permet de substituer
       * mécaniquement.
       */
      await db.rawQuery(
        `INSERT INTO geocode_cache (
           query_hash, query, label, code_insee, city, postcode,
           longitude, latitude, geom, score, result_type, precision, provider,
           fetched_at, expires_at
         ) VALUES (
           :hash, :query, :label, :codeInsee, :city, :postcode,
           :lon, :lat,
           CASE WHEN :lon::double precision IS NULL THEN NULL
                ELSE ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography END,
           :score, :resultType, :precision, 'ban', now(), :expiresAt
         )
         ON CONFLICT (query_hash) DO UPDATE SET
           label = EXCLUDED.label, code_insee = EXCLUDED.code_insee,
           city = EXCLUDED.city, postcode = EXCLUDED.postcode,
           longitude = EXCLUDED.longitude, latitude = EXCLUDED.latitude,
           geom = EXCLUDED.geom, score = EXCLUDED.score,
           result_type = EXCLUDED.result_type, precision = EXCLUDED.precision,
           fetched_at = now(), expires_at = EXCLUDED.expires_at`,
        {
          hash: queryHash,
          query,
          label: result.label,
          codeInsee: result.cityCode,
          city: result.city,
          postcode: result.postcode,
          lon: result.lon,
          lat: result.lat,
          score: result.score,
          resultType: result.resultType,
          precision: result.precision,
          expiresAt,
        }
      )
    } catch (error) {
      // Un cache qui n'écrit pas dégrade la performance, jamais le résultat.
      logger.warn({ err: error }, 'Écriture du cache de géocodage impossible')
    }
  }

  /* ── Replis ────────────────────────────────────────────────────────── */

  /**
   * Centroïde de la commune (§3.1).
   *
   * « Si un code postal couvre plusieurs communes, on prend celle dont le
   * libellé correspond le mieux, sinon la plus peuplée. » — d'où le tri par
   * similarité de nom puis par population décroissante.
   */
  async #cityCentroid(input: GeocodeInput): Promise<GeocodeResult> {
    const normalizedCity = input.city.trim().toLowerCase()

    const result = await db.rawQuery(
      `SELECT code_insee, nom, code_departement, has_dvf, population,
              ST_X(centroid::geometry) AS lon,
              ST_Y(centroid::geometry) AS lat
         FROM communes
        WHERE :postcode = ANY (codes_postaux)
        ORDER BY similarity(nom_normalise, unaccent(lower(:city))) DESC,
                 population DESC NULLS LAST
        LIMIT 1`,
      { postcode: input.postalCode, city: normalizedCity }
    )

    const row = result.rows?.[0]

    if (!row) {
      /*
       * Dernier recours : aucune commune connue pour ce code postal (base
       * pas encore alimentée par `cog:import`, ou code postal erroné).
       * On retourne tout de même un résultat exploitable, sans coordonnées.
       * Le Lot 2 traitera ce cas comme une confiance minimale.
       */
      return {
        label: `${input.city} ${input.postalCode}`.trim(),
        cityCode: null,
        city: input.city,
        postcode: input.postalCode,
        lon: null,
        lat: null,
        score: null,
        resultType: null,
        precision: 'city-centroid',
        hasDvf: true,
        source: 'none',
      }
    }

    return {
      label: `${row.nom} ${input.postalCode}`.trim(),
      cityCode: row.code_insee,
      city: row.nom,
      postcode: input.postalCode,
      lon: row.lon === null ? null : Number(row.lon),
      lat: row.lat === null ? null : Number(row.lat),
      score: null,
      resultType: 'municipality',
      precision: 'city-centroid',
      hasDvf: row.has_dvf,
      source: 'commune-centroid',
    }
  }

  /** Couverture DVF de la commune (§1.3). Inconnue ⇒ on suppose couverte. */
  async #hasDvf(codeInsee: string | null): Promise<boolean> {
    if (!codeInsee) {
      return true
    }

    const row = await db.from('communes').select('has_dvf').where('code_insee', codeInsee).first()

    return row ? Boolean(row.has_dvf) : true
  }
}
