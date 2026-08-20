import db from '@adonisjs/lucid/services/db'
import { DEPARTMENTS_WITHOUT_DVF } from '#dvf/importer'

/**
 * État des données servi par `GET /v1/meta/data-version` — spec §6.1.
 *
 * **Doit fonctionner base vide** (exigence du Lot 0) : le front consomme cet
 * endpoint au build Astro pour figer la mention légale dans les pages
 * statiques. S'il échouait tant qu'aucun import n'a eu lieu, le site ne
 * pourrait pas se construire avant la première ingestion — un couplage
 * inacceptable entre le calendrier de déploiement et celui des données.
 */

export interface DataVersionPayload {
  /** §5.3 : date seule, `"2025-10-01"` — jamais un horodatage complet. */
  dvfPublicationDate: string | null
  lastImportAt: string | null
  coveredDepartmentsCount: number
  missingDepartments: string[]
  priceIndexQuarter: string | null
  coefficientsUpdatedAt: string | null
  licence: string
  attributionFr: string
  /** Millésime courant, sert d'en-tête `X-Data-Version` et de clé de cache. */
  datasetVersion: string | null
  /**
   * `true` dès qu'au moins une mutation existe. C'est **cette** valeur qui
   * décide du 503 `DATA_UNAVAILABLE` (§6.1) : elle repose sur un `EXISTS`,
   * qui s'arrête à la première ligne trouvée.
   */
  hasMutations: boolean
  /**
   * **Ordre de grandeur**, pas un décompte exact.
   *
   * Un `COUNT(*)` sans filtre sur `mutations` est un parcours complet de la
   * table. Invisible à 1 700 lignes, il devient un scan de 6 à 7 M de lignes
   * (Annexe A.9) exécuté sur le chemin chaud d'une estimation — y compris
   * quand la réponse vient du cache applicatif, ce qui annulait l'intérêt
   * même du cache. On lit donc l'estimation du planificateur
   * (`pg_class.reltuples`), rafraîchie par l'`ANALYZE` de fin d'import.
   * Vaut 0 tant qu'aucun `ANALYZE` n'a eu lieu : c'est une jauge de suivi,
   * jamais une condition de service — voir `hasMutations`.
   */
  mutationsCount: number
}

export const LICENCE_LABEL = 'Licence Ouverte / Etalab 2.0'

/**
 * Présence de données, en temps constant.
 *
 * `EXISTS` et non `COUNT(*)` : PostgreSQL s'arrête à la première ligne
 * trouvée. C'est la seule information dont dépend le service (503
 * `DATA_UNAVAILABLE`, §6.1) ; le décompte exact n'a jamais servi qu'à
 * l'affichage.
 *
 * Exporté parce que `GET /health` a exactement le même besoin — et que le
 * dupliquer, c'est prendre le risque qu'un seul des deux soit corrigé.
 */
export const MUTATIONS_PRESENCE_SQL = `SELECT EXISTS (SELECT 1 FROM mutations) AS present`

/**
 * **Ordre de grandeur** du nombre de mutations, lu dans les statistiques du
 * planificateur, donc en temps constant.
 *
 * `reltuples` vaut -1 tant qu'aucun `ANALYZE` n'a eu lieu, et les partitions
 * portent chacune leur estimation : on somme les valeurs positives des
 * partitions de `mutations`. La valeur est rafraîchie par l'`ANALYZE` de fin
 * d'import.
 */
export const MUTATIONS_APPROXIMATE_COUNT_SQL = `
SELECT coalesce(sum(GREATEST(child.reltuples, 0)), 0)::bigint AS total
  FROM pg_inherits
  JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
  JOIN pg_class child  ON child.oid  = pg_inherits.inhrelid
 WHERE parent.relname = 'mutations'
`

/**
 * Phrase d'attribution prête à afficher (§8.1).
 *
 * Construite ici, jamais côté front : la date doit rester juste sans
 * redéploiement du site (US-9).
 */
export function buildAttribution(
  publicationDate: string | null,
  lastImportAt: string | null
): string {
  if (!publicationDate && !lastImportAt) {
    return (
      'Source : Demandes de valeurs foncières (DVF), Direction générale des finances ' +
      `publiques. Données diffusées sous ${LICENCE_LABEL}. Géocodage : Base Adresse Nationale.`
    )
  }

  const parts = [
    'Source : Demandes de valeurs foncières (DVF), Direction générale des finances publiques',
  ]

  if (publicationDate) {
    parts.push(`publiées le ${formatFrenchDate(publicationDate)}`)
  }
  if (lastImportAt) {
    parts.push(`mises à jour dans notre base le ${formatFrenchDate(lastImportAt)}`)
  }

  return (
    `${parts.join(', ')}. Données diffusées sous ${LICENCE_LABEL}. ` +
    'Géocodage : Base Adresse Nationale.'
  )
}

/**
 * « 2025-04-01 » → « 2025-T2 », format attendu par le DTO (§5.3).
 * Fonction pure, exportée pour être testée sans base.
 */
export function formatQuarter(value: Date | string | null): string | null {
  if (!value) {
    return null
  }
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1
  return `${date.getUTCFullYear()}-T${quarter}`
}

function formatFrenchDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

/**
 * Durée de mémorisation de l'état des données.
 *
 * Même valeur que `CoefficientsService`, et pour la même raison : ces
 * informations changent au rythme d'un import (mensuel), pas d'une requête.
 * 60 s suffisent à absorber toute la charge d'un pic sans jamais retarder
 * visiblement la prise en compte d'un nouveau millésime.
 */
const CACHE_TTL_MS = 60 * 1_000

export class DataVersionService {
  static #cache: { value: DataVersionPayload; expiresAt: number } | null = null

  /** Vide le cache mémoire — utilisé par les tests après un reseed. */
  static resetCache(): void {
    DataVersionService.#cache = null
  }

  /**
   * Lit l'état courant, **mémorisé 60 s**.
   *
   * Sans mémorisation, `POST /v1/estimations` déclenchait six requêtes
   * d'inventaire par appel — dont un `COUNT(*)` sans filtre sur `mutations` —
   * et les déclenchait **deux fois** (contrôleur puis service), y compris
   * lorsque la réponse était servie par le cache applicatif. À 1 700 lignes
   * personne ne le voyait ; à 6-7 M de lignes, c'était deux parcours complets
   * de table sur le chemin chaud.
   */
  async current(): Promise<DataVersionPayload> {
    const cached = DataVersionService.#cache
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value
    }

    const value = await this.#read()
    DataVersionService.#cache = { value, expiresAt: Date.now() + CACHE_TTL_MS }
    return value
  }

  /**
   * Lecture réelle. Toute requête est protégée : une table vide, voire
   * absente, renvoie un état « aucune donnée » plutôt qu'une erreur.
   */
  async #read(): Promise<DataVersionPayload> {
    const version = await this.#safe(() =>
      db.from('dataset_versions').select('*').where('is_current', true).first()
    )

    const lastImport = await this.#safe(() =>
      db
        .from('dvf_imports')
        .select('finished_at')
        .where('status', 'success')
        .orderBy('finished_at', 'desc')
        .first()
    )

    const covered = await this.#safe(() =>
      db
        .from('dvf_imports')
        .where('status', 'success')
        .countDistinct('code_departement as total')
        .first()
    )

    const presence = await this.#safe(() => db.rawQuery(MUTATIONS_PRESENCE_SQL))
    const approximate = await this.#safe(() => db.rawQuery(MUTATIONS_APPROXIMATE_COUNT_SQL))

    /*
     * Dernier trimestre d'indice Insee-Notaires effectivement chargé (§3.4).
     * Reste `null` tant que le Lot 4 n'a pas livré `indices:import` : le
     * facteur d'ajustement temporel vaut alors 1, et la méthodologie affichée
     * ne doit surtout pas mentionner un ajustement qui n'a pas eu lieu.
     */
    const lastIndex = await this.#safe(() =>
      db.from('indices_prix').select('trimestre').orderBy('trimestre', 'desc').first()
    )

    /*
     * §3.6 : les coefficients sont recalibrés (Lots 5 et 7) sans
     * redéploiement. Le front doit donc pouvoir dater les coefficients
     * appliqués, comme il date les données DVF.
     */
    const coefficients = await this.#safe(() =>
      db.from('coefficients_reference').where('actif', true).max('updated_at as latest').first()
    )

    /*
     * §5.3 spécifie `dvfPublicationDate: "2025-10-01"` — une DATE, pas un
     * horodatage. Un ISO complet obligeait chaque consommateur (page,
     * PDF, e-mail) à le retailler, avec un risque de décalage d'un jour selon
     * le fuseau appliqué à l'affichage.
     */
    const publishedAt = version?.published_at
      ? new Date(version.published_at).toISOString().slice(0, 10)
      : null
    const lastImportAt = lastImport?.finished_at
      ? new Date(lastImport.finished_at).toISOString()
      : null

    return {
      dvfPublicationDate: publishedAt,
      lastImportAt,
      coveredDepartmentsCount: Number(covered?.total ?? 0),
      missingDepartments: [...DEPARTMENTS_WITHOUT_DVF],
      priceIndexQuarter: formatQuarter(lastIndex?.trimestre ?? null),
      coefficientsUpdatedAt: coefficients?.latest
        ? new Date(coefficients.latest).toISOString()
        : null,
      licence: LICENCE_LABEL,
      attributionFr: buildAttribution(publishedAt, lastImportAt),
      datasetVersion: version?.dataset_version ?? null,
      hasMutations: presence?.rows?.[0]?.present === true,
      mutationsCount: Number(approximate?.rows?.[0]?.total ?? 0),
    }
  }

  /** Exécute une requête en absorbant toute erreur (base vide, non migrée…). */
  async #safe<T>(query: () => Promise<T>): Promise<T | null> {
    try {
      return await query()
    } catch {
      return null
    }
  }
}
