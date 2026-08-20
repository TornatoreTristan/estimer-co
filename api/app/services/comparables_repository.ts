import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'

import {
  MIN_SAMPLE,
  cleanSample,
  type CascadeLevel,
  type CleanOptions,
  type RawComparable,
} from '#services/valuation_service'

/**
 * Sélection des comparables — spec §3.2, §3.3 + Annexe A.3, A.6, A.10, A.11.
 *
 * **Seul module du projet qui touche PostGIS.** Il filtre, classe et limite ;
 * il ne calcule ni médiane, ni quartile, ni coefficient (A.12). Ce qui en sort
 * est un tableau plat d'objets, directement consommable par le moteur de
 * valorisation pur.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI DU SQL BRUT ET PAS LE QUERY BUILDER
 * ══════════════════════════════════════════════════════════════════════════
 * Ces requêtes sont le chemin chaud du produit, et leur performance dépend
 * d'un détail que le planificateur ne pardonne pas (A.6). Elles doivent
 * pouvoir être copiées telles quelles dans un `EXPLAIN ANALYZE` par la
 * personne qui diagnostique une lenteur en production. Un query builder
 * rendrait cette vérification indirecte, donc rare, donc inutile.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * A.6 — `ST_DWithin` AU `WHERE`, `ST_Distance` AU `SELECT`. JAMAIS L'INVERSE.
 * ══════════════════════════════════════════════════════════════════════════
 * `ST_DWithin(geom, point, r)` sur le type `geography` est réécrit par le
 * planificateur en un prédicat de boîte englobante (`&&`) exploitable par
 * l'index GiST, suivi d'un re-contrôle exact sur les seules lignes
 * candidates : c'est la **seule** forme indexable.
 *
 * `ST_Distance(geom, point) <= r` dans le `WHERE` est un appel de fonction
 * géodésique **sur chaque ligne** : aucune classe d'opérateur ne s'y applique
 * → Seq Scan sur plusieurs millions de lignes. Des secondes contre des
 * millisecondes. Si vous modifiez ces requêtes, gardez cette séparation.
 */

/* ══════════════════════════════════════════════════════════════════════════
 * Contrat
 * ════════════════════════════════════════════════════════════════════════ */

export type ComparableType = 'appartement' | 'maison' | 'terrain'

export interface ComparablesCriteria {
  lon: number
  lat: number
  codeInsee: string | null
  codeEpci: string | null
  codeDepartement: string | null
  codeRegion: string | null
  /** Strate de densité INSEE 1-7, utilisée par le niveau national (§3.2, L9). */
  densiteGrille: number | null
  propertyType: ComparableType
  surface: number
  /** Date de référence injectée — le module n'appelle jamais l'horloge. */
  referenceDate: string
}

export interface CascadeAttempt {
  level: CascadeLevel
  radiusM: number | null
  windowMonths: number
  surfaceTolerancePct: number
  /** Lignes rendues par SQL, avant nettoyage §3.3. */
  fetched: number
  /** Lignes restantes après nettoyage — c'est ce nombre qui décide (§3.3.4). */
  kept: number
  required: number
  accepted: boolean
  /**
   * `true` si le niveau a été **abandonné** : dépassement du
   * `statement_timeout` de 2 s (A.6) ou erreur SQL. Les deux sont des
   * incidents, à distinguer d'un « 0 comparable » qui, lui, est un fait de
   * marché parfaitement normal.
   */
  abandoned?: boolean
}

export interface ComparablesSet {
  found: boolean
  level: CascadeLevel
  radiusM: number | null
  windowMonths: number
  surfaceTolerancePct: number
  surfaceToleranceWidened: boolean
  items: RawComparable[]
  rejected: Record<string, number>
  attempts: CascadeAttempt[]
  /**
   * Bornes de nettoyage §3.3 **adaptées au type de bien**, à retransmettre
   * telles quelles à `computeValuation`.
   *
   * ══════════════════════════════════════════════════════════════════════════
   * POURQUOI CE CHAMP EXISTE
   * ══════════════════════════════════════════════════════════════════════════
   * `cleanSample` est appelé deux fois : ici pour décider si un niveau est
   * accepté (§3.3, point 4), puis dans le moteur de valorisation pour produire
   * l'échantillon final. Les deux DOIVENT utiliser les mêmes bornes.
   *
   * Ce n'était pas le cas : la cascade appliquait `PROFILES.terrain`
   * (1 à 25 000 €/m²) tandis que la valorisation retombait sur les bornes du
   * bâti (200 à 25 000 €/m²). Un terrain à 50 €/m² était donc **accepté par la
   * cascade puis intégralement écarté par le calcul**, qui répondait
   * `insufficientSample` → `not-supported`. Le message parlait d'un manque de
   * transactions comparables alors que quatorze venaient d'être trouvées.
   */
  sampleBounds: CleanOptions
}

/** Plafond K de l'Annexe A.12 : le SQL ne rend jamais plus de 200 lignes. */
export const COMPARABLES_HARD_LIMIT = 200

/** A.10 — écart maximal de médiane communale admis au-delà de 2 km. */
export const MARKET_COHERENCE_TOLERANCE = 0.35

/** A.6 — un niveau qui dérape est abandonné, on passe au suivant. */
export const CASCADE_STATEMENT_TIMEOUT = '2s'

/* ══════════════════════════════════════════════════════════════════════════
 * Plan de cascade — §3.2 réordonné par l'Annexe A.11
 * ════════════════════════════════════════════════════════════════════════ */

export interface PlannedLevel {
  level: CascadeLevel
  radiusM: number | null
  windowMonths: number
  /** Seuil d'acceptation du §3.2, avant application du plancher absolu. */
  minCount: number
}

/**
 * A.11 — **temporel avant géographique**.
 *
 * « La proximité est plus discriminante que la fraîcheur, et l'ajustement
 * temporel corrige déjà chaque comparable par l'indice de sa période :
 * allonger la fenêtre coûte en dispersion, pas en biais. »
 *
 * D'où l'ordre : on épuise les rayons à 24 mois, **puis** on rejoue les mêmes
 * rayons à 36 mois, et seulement ensuite on quitte le rayon. Le §3.2 seul
 * aurait fait passer L3 (2 km / 36 mois) avant un second essai de L1 à
 * 36 mois — c'est-à-dire aurait préféré un bien à 2 km à un bien à 400 m,
 * pour la seule raison qu'il est plus récent.
 */
const RADIUS_LEVELS: Array<{ radiusM: number; minCount: number }> = [
  { radiusM: 500, minCount: 15 },
  { radiusM: 1_000, minCount: 15 },
  { radiusM: 2_000, minCount: 12 },
  { radiusM: 5_000, minCount: 10 },
]

/** Passes 1 et 2 de l'A.11, puis la commune (L5) : le bloc rejouable (§3.2). */
function replayableLevels(): PlannedLevel[] {
  return [
    ...RADIUS_LEVELS.map((entry) => ({
      level: 'radius' as const,
      radiusM: entry.radiusM,
      windowMonths: 24,
      minCount: entry.minCount,
    })),
    ...RADIUS_LEVELS.map((entry) => ({
      level: 'radius' as const,
      radiusM: entry.radiusM,
      windowMonths: 36,
      minCount: entry.minCount,
    })),
    { level: 'commune' as const, radiusM: null, windowMonths: 36, minCount: 8 },
  ]
}

/** L6 à L9, atteints seulement après le rejeu à tolérance élargie. */
function administrativeLevels(): PlannedLevel[] {
  return [
    { level: 'epci', radiusM: null, windowMonths: 36, minCount: 8 },
    { level: 'commune', radiusM: null, windowMonths: 60, minCount: 8 },
    { level: 'departement', radiusM: null, windowMonths: 60, minCount: 8 },
    { level: 'region', radiusM: null, windowMonths: 60, minCount: 8 },
    // §3.2 : « toujours accepté » — sous réserve du plancher absolu de 5.
    { level: 'national', radiusM: null, windowMonths: 60, minCount: MIN_SAMPLE },
  ]
}

/* ══════════════════════════════════════════════════════════════════════════
 * Paramètres par type de bien
 * ════════════════════════════════════════════════════════════════════════ */

export interface TypeProfile {
  table: 'mutations' | 'mutations_terrain'
  surfaceColumn: 'surface_bati' | 'surface_terrain'
  /** Tolérance de surface nominale, en % (§3.2). */
  baseTolerance: number
  /** Tolérance après élargissement (§3.2 : ±30 % → ±40 %). */
  widenedTolerance: number
  /** §3.2 : pour un terrain, « seuils divisés par 2 ». */
  thresholdDivisor: number
  /** Bornes de nettoyage §3.3, adaptées au type. */
  cleanOptions: CleanOptions
}

export const PROFILES: Record<ComparableType, TypeProfile> = {
  appartement: {
    table: 'mutations',
    surfaceColumn: 'surface_bati',
    baseTolerance: 30,
    widenedTolerance: 40,
    thresholdDivisor: 1,
    cleanOptions: {},
  },
  maison: {
    table: 'mutations',
    surfaceColumn: 'surface_bati',
    baseTolerance: 30,
    widenedTolerance: 40,
    thresholdDivisor: 1,
    cleanOptions: {},
  },
  terrain: {
    table: 'mutations_terrain',
    surfaceColumn: 'surface_terrain',
    // §3.2, cas particuliers : « terrain → tolérance de surface ±50 %,
    // seuils divisés par 2 ».
    baseTolerance: 50,
    widenedTolerance: 60,
    thresholdDivisor: 2,
    /*
     * Les bornes du §3.3 (9 à 1 000 m², 200 à 25 000 €/m²) décrivent du bâti.
     * Les appliquer à un terrain écarterait l'intégralité du segment : un
     * terrain agricole se vend quelques euros le m², un terrain à bâtir peut
     * dépasser 10 000 m².
     */
    cleanOptions: { surfaceMin: 1, surfaceMax: 100_000, priceMin: 1, priceMax: 25_000 },
  },
}

/* ══════════════════════════════════════════════════════════════════════════
 * Repository
 * ════════════════════════════════════════════════════════════════════════ */

export class ComparablesRepository {
  /**
   * Exécute la cascade et retourne le premier niveau satisfaisant.
   *
   * Rappel §3.3, point 4 : la condition d'acceptation porte sur le nombre de
   * comparables **après écrêtage**, pas sur le nombre de lignes rendues par
   * SQL. C'est pour cela que `cleanSample` — fonction pure partagée avec le
   * moteur de valorisation — est appelée ici : le niveau retenu et le calcul
   * final travaillent ainsi, par construction, sur le même échantillon.
   */
  async findComparables(criteria: ComparablesCriteria): Promise<ComparablesSet> {
    const profile = PROFILES[criteria.propertyType]
    const attempts: CascadeAttempt[] = []

    const phases: Array<{ levels: PlannedLevel[]; tolerance: number; widened: boolean }> = [
      { levels: replayableLevels(), tolerance: profile.baseTolerance, widened: false },
      // §3.2 : rejeu **une seule fois** de L1→L5 à tolérance élargie.
      { levels: replayableLevels(), tolerance: profile.widenedTolerance, widened: true },
      /*
       * Les niveaux administratifs utilisent la tolérance élargie, mais ne
       * portent PAS le drapeau : §3.8 n'attache le malus de 5 points
       * « tolérance de surface élargie à ±40 % » qu'au **rejeu** L1→L5, qui
       * est un signal de rareté locale. Aux niveaux administratifs, la
       * dégradation est déjà entièrement portée par `C_geo` (12 points pour
       * la commune, 3 pour le département, 0 au national) : ajouter le malus
       * revenait à sanctionner deux fois le même fait.
       */
      { levels: administrativeLevels(), tolerance: profile.widenedTolerance, widened: false },
    ]

    for (const phase of phases) {
      for (const planned of phase.levels) {
        const required = requiredCount(planned.minCount, profile.thresholdDivisor)

        const fetched = await this.#runLevel(criteria, profile, planned, phase.tolerance)

        if (fetched === null) {
          attempts.push({
            level: planned.level,
            radiusM: planned.radiusM,
            windowMonths: planned.windowMonths,
            surfaceTolerancePct: phase.tolerance,
            fetched: 0,
            kept: 0,
            required,
            accepted: false,
            abandoned: true,
          })
          continue
        }

        const { kept, rejected } = cleanSample(fetched, profile.cleanOptions)
        const accepted = kept.length >= required

        attempts.push({
          level: planned.level,
          radiusM: planned.radiusM,
          windowMonths: planned.windowMonths,
          surfaceTolerancePct: phase.tolerance,
          fetched: fetched.length,
          kept: kept.length,
          required,
          accepted,
        })

        if (accepted) {
          return {
            found: true,
            level: planned.level,
            radiusM: planned.radiusM,
            windowMonths: planned.windowMonths,
            surfaceTolerancePct: phase.tolerance,
            surfaceToleranceWidened: phase.widened,
            // On rend l'échantillon **brut** : le moteur de valorisation
            // rejoue le nettoyage et publie le détail des rejets (§3.3).
            items: fetched,
            rejected,
            attempts,
            sampleBounds: profile.cleanOptions,
          }
        }
      }
    }

    /*
     * Cascade épuisée. On ne « repêche » surtout pas le meilleur niveau
     * incomplet : un échantillon de 3 ventes ne produit pas un prix
     * défendable, et l'afficher quand même serait précisément la faute que
     * cette spec cherche à corriger. L'appelant répondra 200 avec
     * `method.kind = 'not-supported'`.
     */
    return {
      found: false,
      level: 'national',
      radiusM: null,
      windowMonths: 60,
      surfaceTolerancePct: profile.widenedTolerance,
      surfaceToleranceWidened: false,
      items: [],
      rejected: {},
      attempts,
      sampleBounds: profile.cleanOptions,
    }
  }

  /**
   * Effectif minimum d'une médiane de terrain — §3.6.
   *
   * Sans plancher, **une seule vente de terrain fixait la médiane communale**,
   * et cette médiane multipliait ensuite toute la surface du jardin dans la
   * valorisation. Dans une commune rurale où une seule parcelle a changé de
   * main dans l'année, un prix atypique — une cession entre voisins, un
   * terrain enclavé — devenait la référence de tout le monde.
   *
   * 5 est aligné sur l'esprit de la cascade du §3.2 : « un échantillon de 3
   * ventes ne produit pas un prix défendable ». On préfère le repli
   * départemental, puis le ratio forfaitaire sourcé, à une médiane d'un seul
   * point.
   */
  static readonly LAND_MEDIAN_MIN_SAMPLE = 5

  /**
   * Fenêtre temporelle de la médiane de terrain — §3.6.
   *
   * Alignée sur le niveau le plus large de la cascade. Sans fenêtre, une vente
   * de 2014 pesait autant qu'une vente de l'an dernier dans la valorisation du
   * jardin, alors que le foncier constructible a connu depuis des évolutions à
   * deux chiffres.
   */
  static readonly LAND_MEDIAN_WINDOW_MONTHS = 60

  /**
   * Médiane €/m² des mutations de terrain — §3.6.
   *
   * Deux périmètres essayés dans l'ordre : **la commune, puis le
   * département**. Chacun doit réunir au moins
   * `LAND_MEDIAN_MIN_SAMPLE` ventes sur `LAND_MEDIAN_WINDOW_MONTHS` mois.
   *
   * `null` si aucun des deux ne l'atteint : l'appelant retombe alors sur le
   * ratio de repli sourcé, jamais sur une valeur inventée. C'est un repli
   * documenté ; une médiane d'une seule vente n'en est pas un.
   */
  async landPricePerSqm(
    codeInsee: string | null,
    codeDepartement: string | null
  ): Promise<number | null> {
    /*
     * Le département est essayé APRÈS la commune, et seulement si celle-ci
     * n'a pas assez de ventes. L'ordre est celui de la cascade du §3.2 : on
     * ne s'éloigne qu'à défaut.
     */
    const scopes: Array<{ column: string; value: string }> = []
    if (codeInsee) {
      scopes.push({ column: 't.code_insee', value: codeInsee })
    }
    if (codeDepartement) {
      scopes.push({ column: 't.code_departement', value: codeDepartement })
    }

    for (const scope of scopes) {
      const median = await this.#landMedianForScope(scope.column, scope.value)
      if (median !== null) {
        return median
      }
    }

    return null
  }

  /**
   * Médiane d'un périmètre, ou `null` si l'effectif minimum n'est pas atteint.
   *
   * Le `HAVING` est calculé par PostgreSQL dans la même passe que la médiane :
   * on ne paie pas deux requêtes pour vérifier un effectif.
   */
  async #landMedianForScope(column: string, value: string): Promise<number | null> {
    // Le prédicat de périmètre est construit ici plutôt qu'exprimé par un
    // `IS NULL` sur un paramètre, que PostgreSQL ne saurait pas typer.
    const sql = `
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY t.prix_m2)::double precision AS median,
             count(*)::int AS n
        FROM mutations_terrain t
       WHERE t.is_outlier = false
         AND t.prix_m2 IS NOT NULL
         AND ${column} = ?
         AND t.date_mutation >= (current_date - make_interval(months => ?))
      HAVING count(*) >= ?
    `

    try {
      const result = await db.rawQuery(sql, [
        value,
        ComparablesRepository.LAND_MEDIAN_WINDOW_MONTHS,
        ComparablesRepository.LAND_MEDIAN_MIN_SAMPLE,
      ])
      const median = result.rows?.[0]?.median
      return median === null || median === undefined ? null : Number(median)
    } catch (error) {
      logger.warn({ err: error }, 'Prix médian des terrains indisponible, repli sur le ratio §3.6')
      return null
    }
  }

  /* ── Exécution d'un niveau ────────────────────────────────────────────── */

  /**
   * Retourne les lignes du niveau, ou `null` si la requête a été abandonnée
   * (timeout de 2 s, A.6). `null` et « 0 ligne » ne sont pas la même chose :
   * le premier est un incident à tracer, le second un fait de marché.
   */
  async #runLevel(
    criteria: ComparablesCriteria,
    profile: TypeProfile,
    planned: PlannedLevel,
    tolerancePct: number
  ): Promise<RawComparable[] | null> {
    const built =
      planned.level === 'radius'
        ? buildRadiusQuery(criteria, profile, planned, tolerancePct)
        : buildAdministrativeQuery(criteria, profile, planned, tolerancePct)

    if (!built) {
      // Rattachement administratif inconnu (pas d'EPCI, pas de région…).
      return []
    }

    try {
      const rows = await db.transaction(async (trx) => {
        /*
         * A.6 : « SET LOCAL statement_timeout = '2s' sur chaque requête de
         * cascade : un niveau qui dérape est abandonné, on passe au suivant
         * plutôt que de faire attendre l'utilisateur. »
         * `SET LOCAL` n'a d'effet que dans une transaction — d'où
         * l'encapsulation, qui n'a aucun autre rôle ici.
         */
        await trx.rawQuery(`SET LOCAL statement_timeout = '${CASCADE_STATEMENT_TIMEOUT}'`)
        /*
         * `null` est un paramètre parfaitement valide pour le pilote (il
         * devient `NULL` en SQL), mais le type `StrictValues` de Knex ne
         * l'inclut pas. Le transtypage est donc purement déclaratif : il ne
         * masque aucun risque d'exécution.
         */
        return trx.rawQuery(built.sql, built.bindings as Array<string | number | boolean>)
      })

      return (rows.rows ?? []).map(mapRow)
    } catch (error) {
      logger.warn(
        { err: error, level: planned.level, radiusM: planned.radiusM },
        'Niveau de cascade abandonné'
      )
      return null
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Construction des requêtes
 * ════════════════════════════════════════════════════════════════════════ */

/** Valeurs acceptées par le pilote pour un paramètre positionnel. */
type Binding = string | number | boolean | null

interface BuiltQuery {
  sql: string
  bindings: Binding[]
}

/**
 * Colonnes projetées, identiques pour les deux formes de requête.
 *
 * `distanceExpression` diffère : au rayon, la distance est déjà calculée dans
 * la CTE (et sert au tri) ; en administratif, elle est calculée **après** la
 * limitation à 200 lignes.
 *
 * `to_char(date, 'YYYY-MM-DD')` plutôt que la date brute : le pilote `pg`
 * rendrait un `Date` interprété dans le fuseau du processus, ce qui suffirait
 * à décaler une mutation du 1er janvier d'un an. Le module de valorisation ne
 * manipule que des chaînes ISO.
 */
function projection(distanceExpression: string): string {
  return `
        c.id,
        c.code_insee,
        to_char(c.date_mutation, 'YYYY-MM-DD')      AS date_mutation,
        c.type_local,
        c.surface,
        c.surface_terrain,
        c.nb_pieces,
        c.valeur_fonciere::double precision         AS valeur_fonciere,
        c.prix_m2::double precision                 AS prix_m2,
        c.adresse_voie,
        ${distanceExpression},
        com.nom                                     AS city`
}

/**
 * Fenêtre temporelle : date de référence − N mois, au format `YYYY-MM-DD`.
 * Calculée en JavaScript à partir de la date **injectée** plutôt que par
 * `now() - interval` en SQL : c'est ce qui rend la cascade reproductible et
 * testable (aucune horloge implicite, y compris celle du serveur de base).
 */
export function windowStart(referenceDate: string, months: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(referenceDate)
  if (!match) {
    return '1970-01-01'
  }

  const year = Number(match[1])
  const monthIndex = Number(match[2]) - 1 - months
  const day = Number(match[3])

  /*
   * ── POURQUOI CE N'EST PAS UN SIMPLE `Date.UTC(y, m - months, d)` ────────
   * `Date.UTC` reporte un jour qui n'existe pas dans le mois cible :
   * `Date.UTC(2025, 1, 31)` (31 février) devient le **3 mars**. Pour une date
   * de référence au 31 mars, la fenêtre de 24 mois démarrait donc au 3 mars
   * au lieu du 28 février — trois jours de transactions perdus, quatre fois
   * par an (les 31 des mois précédant février, avril, juin, septembre,
   * novembre), sans que rien ne le signale.
   *
   * On borne donc explicitement le jour au dernier jour du mois cible. Le
   * jour 0 du mois suivant EST le dernier jour du mois courant.
   */
  const lastDayOfTargetMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
  const date = new Date(Date.UTC(year, monthIndex, Math.min(day, lastDayOfTargetMonth)))

  return date.toISOString().slice(0, 10)
}

/** Bornes de surface du §3.2, `surface × (1 ± tolérance)`. */
export function surfaceBounds(surface: number, tolerancePct: number): [number, number] {
  const ratio = tolerancePct / 100
  return [Math.max(0, surface * (1 - ratio)), surface * (1 + ratio)]
}

/** §3.2 pour le terrain : « seuils divisés par 2 », jamais sous le plancher absolu. */
export function requiredCount(minCount: number, divisor: number): number {
  return Math.max(MIN_SAMPLE, Math.ceil(minCount / divisor))
}

/* ══════════════════════════════════════════════════════════════════════════
 * Médianes communales de la garde A.10 — lues dans `agg_commune_type`
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── LE PROBLÈME CORRIGÉ ───────────────────────────────────────────────────
 * Ces deux CTE calculaient un `percentile_cont` **sur tout l'historique**, à
 * chaque requête, dès que la garde s'active (≥ 2 km). Sur un département
 * dense, c'est plusieurs centaines de milliers de lignes agrégées sur le
 * chemin chaud, sous `statement_timeout = 2s` (A.6) : le niveau était
 * abandonné et la cascade descendait d'un cran **en silence**, produisant une
 * estimation plausible mais fondée sur un périmètre plus large que celui
 * annoncé. Invisible à 1 700 lignes, systématique à 6-7 M.
 *
 * ── LA SOLUTION ───────────────────────────────────────────────────────────
 * `agg_commune_type` — vue matérialisée déjà créée par le Lot 0, rafraîchie
 * en fin d'import, et jusqu'ici consommée par aucun code — porte exactement
 * cette statistique, précalculée.
 *
 * ── L'APPROXIMATION, ASSUMÉE ──────────────────────────────────────────────
 * La vue est groupée par tranche de 20 m² : elle donne une médiane PAR
 * tranche, pas une médiane communale unique. On agrège donc les tranches en
 * moyenne pondérée par leur effectif — ce n'est pas rigoureusement la médiane
 * communale, mais A.10 s'en sert pour un test à ±35 %, pas pour produire un
 * prix. L'écart entre les deux est d'un ordre de grandeur inférieur au seuil.
 *
 * ── COMPORTEMENT SI LA VUE EST VIDE ───────────────────────────────────────
 * `med` vaut alors NULL et la clause de garde laisse passer tous les
 * comparables (mode permissif, comme lorsque la commune de référence est
 * inconnue). C'est le repli sûr — on préfère un échantillon large à un
 * échantillon vide — mais cela signifie que la garde reste inactive tant que
 * `refresh:aggregates` n'a pas tourné : `dvf:import` l'appelle désormais en
 * fin d'exécution pour cette raison.
 *
 * ── TERRAIN ───────────────────────────────────────────────────────────────
 * La vue n'agrège que `mutations` (bâti). Le terrain conserve donc le calcul
 * direct : son volume est sans commune mesure avec celui du bâti (quelques
 * milliers de lignes par département), et il n'existe pas de vue équivalente.
 */

/** Médiane €/m² approchée d'UNE commune, pour un prédicat donné. */
function communeMedianSql(profile: TypeProfile, predicate: string): string {
  if (profile.table !== 'mutations') {
    return `
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY r.prix_m2)::double precision AS med
    FROM ${profile.table} r
   WHERE ${predicate}
     AND r.is_outlier = false
     AND r.prix_m2 IS NOT NULL`
  }

  return `
  -- Moyenne des médianes de tranche, pondérée par l'effectif (voir ci-dessus).
  SELECT (sum(r.mediane * r.n) / NULLIF(sum(r.n), 0))::double precision AS med
    FROM agg_commune_type r
   WHERE ${predicate}`
}

/** Médiane €/m² approchée de chaque commune présente dans `candidates`. */
function communeMediansSql(profile: TypeProfile): string {
  if (profile.table !== 'mutations') {
    return `
  SELECT t.code_insee,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY t.prix_m2)::double precision AS med
    FROM ${profile.table} t
   WHERE t.type_local = ?
     AND t.is_outlier = false
     AND t.prix_m2 IS NOT NULL
     AND t.code_insee IN (SELECT DISTINCT code_insee FROM candidates)
   GROUP BY t.code_insee`
  }

  return `
  SELECT t.code_insee,
         (sum(t.mediane * t.n) / NULLIF(sum(t.n), 0))::double precision AS med
    FROM agg_commune_type t
   WHERE t.type_local = ?
     AND t.code_insee IN (SELECT DISTINCT code_insee FROM candidates)
   GROUP BY t.code_insee`
}

/**
 * Niveaux au rayon (L1 à L4).
 *
 * Deux points structurants :
 *  - `geoloc_fine = true` (A.3) : « une mutation posée au centroïde communal
 *    doit être exclue des niveaux au rayon — un point au centre de la commune
 *    n'a aucun sens dans un rayon de 500 m ». Elle reste utilisable aux
 *    niveaux administratifs, où seule l'appartenance compte.
 *  - garde de cohérence de marché (A.10) au-delà de 2 km : sans elle, un
 *    rayon de 5 km autour d'une commune littorale prisée aspire le village
 *    agricole voisin, et inversement.
 */
export function buildRadiusQuery(
  criteria: ComparablesCriteria,
  profile: TypeProfile,
  planned: PlannedLevel,
  tolerancePct: number
): BuiltQuery | null {
  const [surfaceMin, surfaceMax] = surfaceBounds(criteria.surface, tolerancePct)
  const since = windowStart(criteria.referenceDate, planned.windowMonths)

  /*
   * A.10 — GARDE DE COHÉRENCE DE MARCHÉ : POURQUOI 2 km ET NON 5 km.
   *
   * L'annexe est ambiguë sur ce point : son titre dit « L3 et au-delà »
   * (L3 = 2 km dans le plan de cascade) tandis que son corps dit « à partir
   * du rayon de 5 km ». Nous retenons **2 km**, c'est-à-dire la lecture du
   * titre, pour deux raisons :
   *  - c'est le premier niveau où le rayon peut franchir plusieurs limites
   *    communales, donc le premier où la garde a un objet ;
   *  - se tromper dans ce sens coûte un échantillon un peu plus étroit ;
   *    se tromper dans l'autre laisse un village agricole peser sur le prix
   *    d'une commune littorale, ce qui est invisible et faux.
   * En deçà de 2 km, on est dans le même marché par construction.
   */
  const marketGuard = (planned.radiusM ?? 0) >= 2_000 && criteria.codeInsee !== null

  /*
   * Les paramètres sont **positionnels** (`?`), pas nommés.
   *
   * Ce n'est PAS une contrainte technique : `geocoding_service` utilise des
   * binds nommés avec des transtypages `::geography` sans difficulté, Knex
   * sachant parfaitement distinguer `:nom` de `::type`. (Une note de ce
   * fichier affirmait le contraire ; elle était fausse et contredisait
   * l'autre module.)
   *
   * C'est un choix de lisibilité propre au chemin chaud : ces requêtes
   * doivent pouvoir être copiées telles quelles dans un `EXPLAIN ANALYZE`, et
   * une liste positionnelle se substitue mécaniquement, dans l'ordre. La
   * liste ci-dessous suit exactement l'ordre d'apparition des `?` dans le
   * SQL — toute insertion de prédicat doit être répercutée ici.
   */
  /*
   * Les CTE de la garde ne sont construites QUE si la garde s'applique.
   *
   * Ce n'est pas une micro-optimisation : à 500 m et 1 km, agréger les
   * médianes communales serait un travail intégralement jeté (le prédicat
   * final vaudrait `false = false`, donc toujours vrai). Les omettre garde en
   * outre la requête lisible dans un `EXPLAIN` — et évite de dépendre de
   * `agg_commune_type` sur des niveaux qui n'en ont aucun besoin.
   */
  const bindings: Binding[] = marketGuard
    ? [
        // CTE `ref` — médiane de la commune de référence (A.10).
        criteria.codeInsee,
        criteria.propertyType,
      ]
    : []

  bindings.push(
    // CTE `candidates` — projection ST_Distance, puis prédicat ST_DWithin.
    criteria.lon,
    criteria.lat,
    criteria.lon,
    criteria.lat,
    planned.radiusM,
    criteria.propertyType,
    surfaceMin,
    surfaceMax,
    since
  )

  if (marketGuard) {
    // CTE `commune_med`, puis tolérance de la garde.
    bindings.push(criteria.propertyType, MARKET_COHERENCE_TOLERANCE)
  }

  bindings.push(COMPARABLES_HARD_LIMIT)

  const guardCte = marketGuard
    ? `WITH ref AS (
  ${communeMedianSql(profile, 'r.code_insee = ? AND r.type_local = ?')}
),
candidates AS (`
    : `WITH candidates AS (`

  const guardJoin = marketGuard
    ? `  LEFT JOIN commune_med cm ON cm.code_insee = c.code_insee\n`
    : ''

  const guardWhere = marketGuard
    ? ` WHERE (SELECT med FROM ref) IS NULL
    OR cm.med IS NULL
    OR abs(cm.med - (SELECT med FROM ref)) <= ? * (SELECT med FROM ref)\n`
    : ''

  const guardMedians = marketGuard
    ? `,
commune_med AS (
  ${communeMediansSql(profile)}
)`
    : ''

  const sql = `
${guardCte}
  SELECT m.id,
         m.code_insee,
         m.date_mutation,
         m.type_local,
         m.${profile.surfaceColumn}                AS surface,
         m.surface_terrain,
         m.nb_pieces,
         m.valeur_fonciere,
         m.prix_m2,
         m.adresse_voie,
         -- A.6 : ST_Distance UNIQUEMENT en projection / tri.
         ST_Distance(m.geom, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography) AS distance_m
    FROM ${profile.table} m
   -- A.6 : ST_DWithin est la SEULE forme indexable (GiST + boîte englobante).
   WHERE ST_DWithin(m.geom, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)
     AND m.type_local = ?
     AND m.is_outlier = false
     -- A.3 : un point au centroïde communal n'a rien à faire dans un rayon.
     AND m.geoloc_fine = true
     -- Transtypage obligatoire : la colonne de surface est un entier, et
     -- PostgreSQL en déduirait le type du paramètre. Une borne de 45,5 m²
     -- (65 m² − 30 %) provoquerait alors « invalid input syntax for type
     -- integer », le niveau serait abandonné, et la cascade descendrait d'un
     -- cran en silence.
     AND m.${profile.surfaceColumn} BETWEEN ?::double precision AND ?::double precision
     AND m.date_mutation >= ?
     AND m.prix_m2 IS NOT NULL
)${guardMedians}
SELECT ${projection('c.distance_m')}
  FROM candidates c
${guardJoin}  LEFT JOIN communes com   ON com.code_insee = c.code_insee
${guardWhere} ORDER BY c.distance_m ASC
 LIMIT ?`

  return { sql, bindings }
}

/**
 * Niveaux administratifs (L5 à L9).
 *
 * La sélection est **d'abord** filtrée, triée et limitée à 200 lignes, et
 * `ST_Distance` n'est calculé qu'ensuite, sur ces 200 lignes. À l'échelle
 * d'une région ou du pays, projeter une distance géodésique sur des centaines
 * de milliers de lignes coûterait bien plus cher que tout le reste de la
 * requête — pour une valeur qui ne sert qu'à pondérer 200 comparables.
 */
export function buildAdministrativeQuery(
  criteria: ComparablesCriteria,
  profile: TypeProfile,
  planned: PlannedLevel,
  tolerancePct: number
): BuiltQuery | null {
  const [surfaceMin, surfaceMax] = surfaceBounds(criteria.surface, tolerancePct)
  const since = windowStart(criteria.referenceDate, planned.windowMonths)

  let scope = ''
  const scopeBindings: Binding[] = []

  switch (planned.level) {
    case 'commune':
      if (!criteria.codeInsee) return null
      scope = 'm.code_insee = ?'
      scopeBindings.push(criteria.codeInsee)
      break
    case 'epci':
      if (!criteria.codeEpci) return null
      scope = 'm.code_insee IN (SELECT code_insee FROM communes WHERE code_epci = ?)'
      scopeBindings.push(criteria.codeEpci)
      break
    case 'departement':
      if (!criteria.codeDepartement) return null
      scope = 'm.code_departement = ?'
      scopeBindings.push(criteria.codeDepartement)
      break
    case 'region':
      if (!criteria.codeRegion) return null
      scope = 'm.code_insee IN (SELECT code_insee FROM communes WHERE code_region = ?)'
      scopeBindings.push(criteria.codeRegion)
      break
    case 'national':
      /*
       * §3.2, L9 : « même type, même tranche de surface, même strate de
       * densité INSEE ». La strate n'est appliquée que si elle est connue :
       * un `densite_grille` non renseigné ne doit pas vider l'échantillon de
       * dernier recours.
       */
      if (criteria.densiteGrille !== null) {
        scope = 'm.code_insee IN (SELECT code_insee FROM communes WHERE densite_grille = ?)'
        scopeBindings.push(criteria.densiteGrille)
      } else {
        scope = 'true'
      }
      break
    default:
      return null
  }

  const bindings: Binding[] = [
    ...scopeBindings,
    criteria.propertyType,
    surfaceMin,
    surfaceMax,
    since,
    criteria.surface,
    COMPARABLES_HARD_LIMIT,
    criteria.lon,
    criteria.lat,
  ]

  const sql = `
WITH candidates AS (
  SELECT m.id,
         m.code_insee,
         m.date_mutation,
         m.type_local,
         m.${profile.surfaceColumn}  AS surface,
         m.surface_terrain,
         m.nb_pieces,
         m.valeur_fonciere,
         m.prix_m2,
         m.adresse_voie,
         m.geom
    FROM ${profile.table} m
   WHERE ${scope}
     AND m.type_local = ?
     AND m.is_outlier = false
     -- Transtypage obligatoire : la colonne de surface est un entier, et
     -- PostgreSQL en déduirait le type du paramètre. Une borne de 45,5 m²
     -- (65 m² − 30 %) provoquerait alors « invalid input syntax for type
     -- integer », le niveau serait abandonné, et la cascade descendrait d'un
     -- cran en silence.
     AND m.${profile.surfaceColumn} BETWEEN ?::double precision AND ?::double precision
     AND m.date_mutation >= ?
     AND m.prix_m2 IS NOT NULL
   -- Classement par similarité (§3.2) : surface d'abord, fraîcheur ensuite.
   ORDER BY abs(m.${profile.surfaceColumn} - ?::double precision) ASC, m.date_mutation DESC
   LIMIT ?
)
SELECT ${projection(
    'ST_Distance(c.geom, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography) AS distance_m'
  )}
  FROM candidates c
  LEFT JOIN communes com ON com.code_insee = c.code_insee`

  return { sql, bindings }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Frontière SQL → calcul (A.12)
 * ════════════════════════════════════════════════════════════════════════ */

interface ComparableRow {
  code_insee: string
  date_mutation: string
  type_local: string
  surface: number | string | null
  surface_terrain: number | string | null
  nb_pieces: number | null
  valeur_fonciere: number | string | null
  prix_m2: number | string | null
  adresse_voie: string | null
  distance_m: number | string | null
  city: string | null
}

/**
 * Conversion en objet plat. **C'est ici que s'arrête PostgreSQL.**
 *
 * Les `numeric` de PostgreSQL arrivent en chaînes via `pg` (pour ne pas
 * perdre en précision) : les convertir ici, une fois, évite que le moteur de
 * valorisation ne reçoive un mélange de nombres et de chaînes et ne produise
 * des concaténations là où il attend des additions.
 */
function mapRow(row: ComparableRow): RawComparable {
  return {
    prixM2: toNumber(row.prix_m2) ?? 0,
    surface: toNumber(row.surface) ?? 0,
    distanceMetres: toNumber(row.distance_m),
    dateMutation: row.date_mutation,
    valeurFonciere: toNumber(row.valeur_fonciere),
    surfaceTerrain: toNumber(row.surface_terrain),
    rooms: row.nb_pieces === null ? null : Number(row.nb_pieces),
    street: row.adresse_voie,
    city: row.city,
    propertyType: row.type_local as RawComparable['propertyType'],
    // Lot 4 : remplacé par l'indice Insee-Notaires. 1 = aucun ajustement.
    timeIndexFactor: 1,
  }
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null
  }
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
