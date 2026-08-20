import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import pg from 'pg'
import copyStreams from 'pg-copy-streams'

import { DVF_CSV_COLUMNS, assertCsvHeaderMatches } from '#dvf/csv_columns'
import {
  BUILD_CANDIDATES_SQL,
  BUILD_TERRAIN_CANDIDATES_SQL,
  CANDIDATE_SUMMARY_SQL,
  CANDIDATE_YEARS_SQL,
  COUNT_PREEXISTING_SQL,
  COUNT_PREEXISTING_TERRAIN_SQL,
  DVF_HELPERS_SQL,
  INSERT_MUTATIONS_SQL,
  INSERT_TERRAIN_SQL,
  MARK_STALE_SQL,
  MARK_STALE_TERRAIN_SQL,
  REJECTED_COUNTS_SQL,
  TERRAIN_REJECTED_COUNTS_SQL,
  TERRAIN_SUMMARY_SQL,
  TERRAIN_YEARS_SQL,
} from '#database/sql/dvf_transform'
import { buildDvfUrl, openDvfStream, type DvfSource } from '#dvf/downloader'

/**
 * Orchestration de l'ingestion DVF — spec §6.2, US-7, Annexe A.7 et A.8.
 *
 * Choix structurants :
 *
 *  - **Une connexion PostgreSQL dédiée** (`pg.Client`, pas le pool Lucid).
 *    Deux raisons impératives : `COPY … FROM STDIN` exige un accès au
 *    protocole de la connexion, et un *advisory lock* de session doit rester
 *    attaché à la même connexion pendant tout l'import.
 *
 *  - **Une transaction par département** (Annexe A.7), jamais une transaction
 *    géante. Un échec sur le département 75 ne perd pas les 94 départements
 *    déjà traités, et la reprise est possible.
 *
 *  - **Aucun DROP, aucun TRUNCATE sur `mutations`.** L'upsert garde le
 *    service interrogeable pendant toute la durée de l'import.
 */

const { from: copyFrom } = copyStreams

/** Clé de l'advisory lock global d'ingestion (arbitraire mais stable). */
export const DVF_ADVISORY_LOCK_KEY = 20_260_819

/**
 * Version des RÈGLES d'ingestion (normalisation, rejets, bornes d'aberration).
 *
 * **À incrémenter à chaque correctif de règle**, y compris quand le SQL de
 * transformation change sans que la spec bouge.
 *
 * Raison d'être : l'idempotence de l'Annexe A.8 fait *skipper* un fichier dont
 * le sha256 est déjà connu. C'est le bon comportement pour un cron mensuel qui
 * retrouve le même fichier — mais cela rendait tout correctif de règle
 * **inopérant sans `--force`** : les lignes fautives restaient en base et le
 * ré-import ne les touchait même pas. En mémorisant la version des règles avec
 * laquelle chaque fichier a été ingéré, un changement de règles invalide le
 * skip de lui-même, et le marquage `stale_reimport` s'applique.
 *
 * Historique :
 *   1 — Lot 1 : règles initiales.
 *   2 — Correctif B2 (parité SQL/normalize) + terrains à parcelles mixtes
 *       (`terrain_mixte`) + marquage `stale_reimport`.
 */
export const DVF_RULES_VERSION = 2

export interface DepartmentImportResult {
  codeDepartement: string
  annee: number
  url: string
  status: 'success' | 'skipped' | 'dry-run' | 'failed'
  etag: string | null
  /**
   * `Last-Modified` du fichier source. C'est la **date de publication réelle**
   * du millésime DVF ingéré : elle alimente `dataset_versions.published_at`,
   * donc la mention légale « publiées le … » du §8.1. Sans elle, cette date
   * resterait `null` et le front n'aurait rien de juste à afficher (US-9).
   */
  lastModified: string | null
  sha256: string | null
  rowsRead: number
  mutationsSeen: number
  rowsKept: number
  rowsInserted: number
  rowsUpdated: number
  rowsRejected: number
  outliers: number
  /**
   * Lignes marquées `stale_reimport` — Annexe A.2.
   *
   * Mutations du périmètre (département × millésime) que l'upsert n'a PAS
   * réécrites : elles proviennent d'une règle d'ingestion antérieure, ou ont
   * disparu du fichier source. **Un non-zéro sur un ré-import de routine est
   * un signal**, pas une statistique : il dit que les règles ont changé.
   */
  rowsStaleMarked: number
  /** Idem pour `mutations_terrain` (§5.1). */
  terrainStaleMarked: number
  rejectedCounts: Record<string, number>
  /**
   * Ventes de terrain nu (§5.1, table `mutations_terrain`).
   *
   * Comptées à part du bâti : ce sont deux tables, deux marchés et deux jeux
   * de bornes. Les additionner au rapport masquerait, par exemple, un
   * département où le terrain ne remonte pas du tout.
   */
  terrainSeen: number
  terrainKept: number
  terrainInserted: number
  terrainUpdated: number
  terrainRejected: number
  /**
   * Rejets de terrain PAR MOTIF. Le total seul ne permet pas de distinguer un
   * problème de données (`surface_absente`) d'une décision de périmètre
   * attendue et massive en zone rurale (`nature_culture_non_retenue`).
   */
  terrainRejectedCounts: Record<string, number>
  terrainOutliers: number
  durationMs: number
  error?: string
}

export interface ImportOptions {
  annee: number
  departements: string[]
  baseUrl: string
  dryRun: boolean
  force: boolean
  source: DvfSource
  /** Journalisation ; injectée pour rester silencieux dans les tests. */
  logger?: { info: (message: string) => void; warn: (message: string) => void }
}

export class DvfConcurrentImportError extends Error {
  constructor() {
    super(
      "Un import DVF est déjà en cours sur cette base. Attendez qu'il se termine " +
        "avant d'en lancer un autre."
    )
    this.name = 'DvfConcurrentImportError'
  }
}

/**
 * Transform qui valide l'en-tête CSV **avant** de laisser passer quoi que ce
 * soit vers `COPY`.
 *
 * Sans cette garde, un changement de format chez Etalab (colonne ajoutée ou
 * déplacée) chargerait des valeurs décalées d'une colonne : l'import
 * réussirait, et les prix seraient silencieusement faux. On préfère un échec
 * bruyant.
 */
export class CsvHeaderGuard extends Transform {
  #buffer = ''
  #validated = false

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    if (this.#validated) {
      this.push(chunk)
      return callback()
    }

    this.#buffer += chunk.toString('utf8')
    const newlineIndex = this.#buffer.indexOf('\n')

    if (newlineIndex === -1) {
      // En-tête incomplet : on attend le prochain morceau.
      return callback()
    }

    const headerLine = this.#buffer.slice(0, newlineIndex).replace(/\r$/, '')

    try {
      assertCsvHeaderMatches(headerLine)
    } catch (error) {
      return callback(error as Error)
    }

    this.#validated = true
    this.push(Buffer.from(this.#buffer, 'utf8'))
    this.#buffer = ''
    callback()
  }

  _flush(callback: (error?: Error) => void) {
    if (!this.#validated) {
      return callback(
        new Error("Le fichier DVF est vide ou tronqué : aucun en-tête n'a pu être lu.")
      )
    }
    callback()
  }
}

/**
 * Compte les lignes de données traversant le flux (hors en-tête), pour
 * alimenter `rows_read`.
 */
export class LineCounter extends Transform {
  #count = 0
  #trailingNewline = true

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    for (const byte of chunk) {
      if (byte === 0x0a) {
        this.#count += 1
      }
    }
    this.#trailingNewline = chunk.length === 0 || chunk[chunk.length - 1] === 0x0a
    this.push(chunk)
    callback()
  }

  /** Nombre de lignes de données (l'en-tête est retiré). */
  get dataLines(): number {
    const total = this.#count + (this.#trailingNewline ? 0 : 1)
    return Math.max(0, total - 1)
  }
}

export class DvfImporter {
  constructor(private readonly client: pg.Client) {}

  /**
   * Prend le verrou d'ingestion. Retourne `false` si un autre import le
   * détient déjà (US-7 : « le second s'arrête immédiatement »).
   *
   * `pg_try_advisory_lock` ne bloque pas : c'est ce qui permet de sortir en
   * erreur immédiatement plutôt que d'attendre indéfiniment.
   */
  async acquireLock(): Promise<boolean> {
    const result = await this.client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [DVF_ADVISORY_LOCK_KEY]
    )
    return result.rows[0]?.locked === true
  }

  async releaseLock(): Promise<void> {
    await this.client.query('SELECT pg_advisory_unlock($1)', [DVF_ADVISORY_LOCK_KEY])
  }

  /** Installe les fonctions SQL utilitaires (idempotent). */
  async ensureHelpers(): Promise<void> {
    await this.client.query(DVF_HELPERS_SQL)
  }

  /**
   * Vérifie si ce fichier a déjà été ingéré avec succès **sous les règles
   * courantes**. Annexe A.8 : « rejouer le même fichier est un no-op ».
   *
   * Le `rules_version = DVF_RULES_VERSION` est la clause qui empêche cette
   * optimisation de se retourner contre nous : sans elle, un correctif de
   * règle d'ingestion restait sans effet tant que personne ne pensait à
   * `--force`, et les lignes produites par l'ancienne règle survivaient
   * indéfiniment dans les médianes.
   */
  async isAlreadyImported(
    annee: number,
    codeDepartement: string,
    identifier: { etag?: string | null; sha256?: string | null }
  ): Promise<boolean> {
    if (identifier.sha256) {
      const bySha = await this.client.query(
        `SELECT 1 FROM dvf_imports
         WHERE annee = $1 AND code_departement = $2 AND sha256 = $3
           AND status = 'success' AND rules_version = $4
         LIMIT 1`,
        [annee, codeDepartement, identifier.sha256, DVF_RULES_VERSION]
      )
      if (bySha.rowCount && bySha.rowCount > 0) {
        return true
      }
    }

    if (identifier.etag) {
      const byEtag = await this.client.query(
        `SELECT 1 FROM dvf_imports
         WHERE annee = $1 AND code_departement = $2 AND etag = $3
           AND status = 'success' AND rules_version = $4
         LIMIT 1`,
        [annee, codeDepartement, identifier.etag, DVF_RULES_VERSION]
      )
      if (byEtag.rowCount && byEtag.rowCount > 0) {
        return true
      }
    }

    return false
  }

  /**
   * Importe un département pour une année.
   *
   * Déroulé : HEAD → contrôle ETag → COPY en staging → transformation
   * set-based → provisionnement des partitions → upsert → comptage des
   * rejets. Le tout dans UNE transaction.
   */
  async importDepartment(
    codeDepartement: string,
    options: ImportOptions
  ): Promise<DepartmentImportResult> {
    const startedAt = Date.now()
    const url = buildDvfUrl(options.baseUrl, options.annee, codeDepartement)

    const result: DepartmentImportResult = {
      codeDepartement,
      annee: options.annee,
      url,
      status: 'failed',
      etag: null,
      lastModified: null,
      sha256: null,
      rowsRead: 0,
      mutationsSeen: 0,
      rowsKept: 0,
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsRejected: 0,
      outliers: 0,
      rowsStaleMarked: 0,
      terrainStaleMarked: 0,
      rejectedCounts: {},
      terrainSeen: 0,
      terrainKept: 0,
      terrainInserted: 0,
      terrainUpdated: 0,
      terrainRejected: 0,
      terrainRejectedCounts: {},
      terrainOutliers: 0,
      durationMs: 0,
    }

    /*
     * Contrôle de fraîcheur AVANT téléchargement : un ETag déjà connu évite
     * de rapatrier plusieurs centaines de Mo pour rien. C'est ce qui rend la
     * vérification mensuelle (§10) économique.
     */
    try {
      const metadata = await options.source.head(url)
      result.etag = metadata.etag
      result.lastModified = metadata.lastModified

      if (
        !options.force &&
        (await this.isAlreadyImported(options.annee, codeDepartement, metadata))
      ) {
        result.status = 'skipped'
        result.durationMs = Date.now() - startedAt
        options.logger?.info(
          `${codeDepartement} : déjà importé (ETag inchangé), ignoré. Utilisez --force pour forcer.`
        )
        return result
      }
    } catch (error) {
      // Un HEAD refusé n'est pas bloquant : certains miroirs ne l'autorisent
      // pas. On tentera le GET.
      options.logger?.warn(
        `${codeDepartement} : requête HEAD impossible (${(error as Error).message}), poursuite avec GET.`
      )
    }

    await this.client.query('BEGIN')

    try {
      await this.client.query('TRUNCATE mutations_staging')

      const { csv, tap, metadata } = await openDvfStream(options.source, url)
      result.etag = result.etag ?? metadata.etag
      result.lastModified = result.lastModified ?? metadata.lastModified

      const headerGuard = new CsvHeaderGuard()
      const counter = new LineCounter()

      const copySql =
        `COPY mutations_staging (${DVF_CSV_COLUMNS.join(', ')}) ` +
        `FROM STDIN WITH (FORMAT csv, HEADER true)`

      const ingestStream = this.client.query(copyFrom(copySql))

      await pipeline(csv as Readable, headerGuard, counter, ingestStream)

      result.sha256 = tap.digest
      result.rowsRead = counter.dataLines

      // Second contrôle d'idempotence, cette fois sur le contenu réel.
      if (
        !options.force &&
        (await this.isAlreadyImported(options.annee, codeDepartement, result))
      ) {
        await this.client.query('ROLLBACK')
        result.status = 'skipped'
        result.durationMs = Date.now() - startedAt
        options.logger?.info(`${codeDepartement} : contenu identique à un import réussi, ignoré.`)
        return result
      }

      // Transformation set-based (Annexe A.7).
      await this.client.query(BUILD_CANDIDATES_SQL)
      // Second passage sur le même staging : les ventes SANS aucun local,
      // c'est-à-dire les terrains nus (§5.1).
      await this.client.query(BUILD_TERRAIN_CANDIDATES_SQL)

      const terrainSummary = await this.client.query<{
        mutations_seen: string
        kept: string
        rejected: string
        outliers: string
      }>(TERRAIN_SUMMARY_SQL)

      result.terrainSeen = Number(terrainSummary.rows[0]?.mutations_seen ?? 0)
      result.terrainKept = Number(terrainSummary.rows[0]?.kept ?? 0)
      result.terrainRejected = Number(terrainSummary.rows[0]?.rejected ?? 0)
      result.terrainOutliers = Number(terrainSummary.rows[0]?.outliers ?? 0)

      const terrainRejects = await this.client.query<{ reason: string; total: string }>(
        TERRAIN_REJECTED_COUNTS_SQL
      )
      for (const row of terrainRejects.rows) {
        result.terrainRejectedCounts[row.reason] = Number(row.total)
      }

      const summary = await this.client.query<{
        mutations_seen: string
        kept: string
        rejected: string
        outliers: string
      }>(CANDIDATE_SUMMARY_SQL)

      result.mutationsSeen = Number(summary.rows[0]?.mutations_seen ?? 0)
      result.rowsKept = Number(summary.rows[0]?.kept ?? 0)
      result.rowsRejected = Number(summary.rows[0]?.rejected ?? 0)
      result.outliers = Number(summary.rows[0]?.outliers ?? 0)

      const rejects = await this.client.query<{ reason: string; total: string }>(
        REJECTED_COUNTS_SQL
      )
      for (const row of rejects.rows) {
        result.rejectedCounts[row.reason] = Number(row.total)
      }

      if (options.dryRun) {
        /*
         * US-7 : « aucune écriture n'a lieu en base ».
         * Le ROLLBACK annule le remplissage du staging comme la table
         * temporaire ; seuls les compteurs sont rapportés.
         */
        await this.client.query('ROLLBACK')
        result.status = 'dry-run'
        result.durationMs = Date.now() - startedAt
        return result
      }

      // Provisionnement des partitions annuelles réellement nécessaires.
      const years = await this.client.query<{ year: number }>(CANDIDATE_YEARS_SQL)
      for (const { year } of years.rows) {
        await this.client.query('SELECT ensure_annual_partition($1, $2)', ['mutations', year])
      }

      /*
       * Mises à jour = candidats déjà présents, mesurés AVANT l'upsert.
       * (Le `RETURNING (xmax = 0)` est impossible sur une table partitionnée.)
       */
      const preexisting = await this.client.query<{ total: string }>(COUNT_PREEXISTING_SQL)
      result.rowsUpdated = Number(preexisting.rows[0]?.total ?? 0)

      const upsert = await this.client.query<{ upserted: string }>(INSERT_MUTATIONS_SQL, [
        options.annee,
      ])
      const upserted = Number(upsert.rows[0]?.upserted ?? 0)
      result.rowsInserted = Math.max(0, upserted - result.rowsUpdated)

      /* ── Terrains nus (§5.1) ──────────────────────────────────────────── */
      const terrainYears = await this.client.query<{ year: number }>(TERRAIN_YEARS_SQL)
      for (const { year } of terrainYears.rows) {
        await this.client.query('SELECT ensure_annual_partition($1, $2)', [
          'mutations_terrain',
          year,
        ])
      }

      const preexistingTerrain = await this.client.query<{ total: string }>(
        COUNT_PREEXISTING_TERRAIN_SQL
      )
      result.terrainUpdated = Number(preexistingTerrain.rows[0]?.total ?? 0)

      const terrainUpsert = await this.client.query<{ upserted: string }>(INSERT_TERRAIN_SQL, [
        options.annee,
      ])
      result.terrainInserted = Math.max(
        0,
        Number(terrainUpsert.rows[0]?.upserted ?? 0) - result.terrainUpdated
      )

      /* ── Lignes obsolètes (Annexe A.2) ────────────────────────────────
       *
       * APRÈS les deux upserts, dans la MÊME transaction. Toute ligne du
       * périmètre (ce département, CE millésime) que l'upsert n'a pas
       * réécrite provient d'une règle d'ingestion antérieure ou a disparu du
       * fichier source : on la marque, on ne la supprime pas.
       *
       * Le périmètre inclut `source_annee` : sans lui, importer 2025
       * marquerait obsolètes toutes les mutations 2019-2024 du département.
       * Voir le commentaire de `MARK_STALE_SQL`.
       */
      const stale = await this.client.query(MARK_STALE_SQL, [codeDepartement, options.annee])
      result.rowsStaleMarked = stale.rowCount ?? 0

      const staleTerrain = await this.client.query(MARK_STALE_TERRAIN_SQL, [
        codeDepartement,
        options.annee,
      ])
      result.terrainStaleMarked = staleTerrain.rowCount ?? 0

      /*
       * Le staging est vidé dans la même transaction : une fois le
       * département transformé, y laisser plusieurs centaines de milliers de
       * lignes n'aurait aucune utilité et occuperait le disque jusqu'au
       * prochain import.
       */
      await this.client.query('TRUNCATE mutations_staging')

      await this.client.query('COMMIT')
      result.status = 'success'
    } catch (error) {
      await this.client.query('ROLLBACK').catch(() => undefined)
      result.status = 'failed'
      result.error = (error as Error).message
    }

    result.durationMs = Date.now() - startedAt
    return result
  }

  /**
   * `ANALYZE` en fin d'import.
   *
   * Sans statistiques fraîches, le planificateur sous-estime la sélectivité
   * des nouvelles partitions et peut préférer un Seq Scan à l'index GiST —
   * exactement le scénario que l'Annexe A.6 cherche à éviter.
   */
  async analyze(): Promise<void> {
    await this.client.query('ANALYZE mutations')
    await this.client.query('ANALYZE mutations_terrain')
  }
}

/** Départements sans couverture DVF — §1.3. Un import y est vain. */
export const DEPARTMENTS_WITHOUT_DVF = ['57', '67', '68', '976']

/**
 * Liste des départements français, DOM inclus (§2.7).
 * La Corse utilise 2A/2B ; Mayotte (976) et l'Alsace-Moselle sont exclues car
 * absentes de DVF.
 */
export function allDvfDepartments(): string[] {
  const metropole = Array.from({ length: 95 }, (_, index) => String(index + 1).padStart(2, '0'))
    .filter((code) => code !== '20') // remplacé par 2A / 2B
    .concat(['2A', '2B'])

  const dom = ['971', '972', '973', '974']

  return [...metropole, ...dom].filter((code) => !DEPARTMENTS_WITHOUT_DVF.includes(code)).sort()
}

/**
 * Analyse la valeur de `--dep`. Accepte `all`, un code, ou une liste séparée
 * par des virgules.
 */
export function parseDepartments(value: string | undefined): string[] {
  if (!value || value.trim().toLowerCase() === 'all') {
    return allDvfDepartments()
  }

  return (
    value
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter((code) => code.length > 0)
      // Un code à un chiffre saisi à la main (« 1 ») devient « 01 ».
      .map((code) => (/^\d$/.test(code) ? `0${code}` : code))
  )
}
