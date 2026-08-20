import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import pg from 'pg'

import env from '#start/env'
import {
  DVF_RULES_VERSION,
  DvfImporter,
  parseDepartments,
  type DepartmentImportResult,
} from '#dvf/importer'
import { HttpDvfSource } from '#dvf/downloader'

/**
 * `node ace dvf:import` — spec §6.2, US-7.
 *
 * Exemples :
 *   node ace dvf:import --year=2025 --dep=23 --dry-run
 *   node ace dvf:import --year=2025 --dep=75,23
 *   node ace dvf:import --year=2025 --dep=all --force
 */
export default class DvfImport extends BaseCommand {
  static commandName = 'dvf:import'
  static description =
    'Importe les mutations DVF géolocalisées (Etalab) pour une année et un ou plusieurs départements'

  static options: CommandOptions = {
    startApp: true,
    staysAlive: false,
  }

  @flags.number({ description: 'Millésime à importer, ex. --year=2025', required: true })
  declare year: number

  @flags.string({
    description: 'Département(s) : « 23 », « 75,23 » ou « all ». Par défaut : all',
  })
  declare dep: string

  @flags.boolean({
    description: 'Simulation : aucune écriture en base, seulement le rapport de comptage',
  })
  declare dryRun: boolean

  @flags.boolean({
    description: 'Réimporte même si le fichier a déjà été ingéré (ETag/sha256 identiques)',
  })
  declare force: boolean

  @flags.string({ description: 'URL de base des fichiers DVF (défaut : DVF_BASE_URL)' })
  declare source: string

  async run() {
    const departments = parseDepartments(this.dep)
    const baseUrl = this.source || env.get('DVF_BASE_URL')

    this.logger.info(
      `Import DVF ${this.year} — ${departments.length} département(s)` +
        (this.dryRun ? ' — MODE SIMULATION (aucune écriture)' : '')
    )

    /*
     * Connexion dédiée : COPY FROM STDIN et advisory lock de session exigent
     * une connexion stable, hors du pool applicatif.
     */
    const client = new pg.Client({
      host: env.get('DB_HOST'),
      port: env.get('DB_PORT'),
      user: env.get('DB_USER'),
      password: env.get('DB_PASSWORD'),
      database: env.get('DB_DATABASE'),
      // Un département dense peut demander plusieurs minutes.
      statement_timeout: 30 * 60 * 1000,
    })

    await client.connect()
    const importer = new DvfImporter(client)

    let runId: number | null = null

    try {
      /*
       * US-7 : « un import déjà en cours ⇒ le second s'arrête immédiatement
       * avec un message explicite et un code de sortie non nul ».
       */
      if (!(await importer.acquireLock())) {
        this.logger.error(
          'Un import DVF est déjà en cours sur cette base. Abandon. ' +
            "Attendez sa fin, ou vérifiez qu'aucun processus n'est resté bloqué."
        )
        this.exitCode = 1
        return
      }

      await importer.ensureHelpers()

      if (!this.dryRun) {
        runId = await this.#startRun(client, departments)
      }

      const results: DepartmentImportResult[] = []
      // Timeout explicite : un téléchargement qui traîne doit échouer, pas
      // suspendre l'import de tous les départements suivants.
      const source = new HttpDvfSource(120_000)

      for (const codeDepartement of departments) {
        this.logger.info(`→ ${codeDepartement} …`)

        const result = await importer.importDepartment(codeDepartement, {
          annee: this.year,
          departements: departments,
          baseUrl,
          dryRun: this.dryRun,
          force: this.force,
          source,
          logger: {
            info: (message) => this.logger.info(message),
            warn: (message) => this.logger.warning(message),
          },
        })

        results.push(result)
        this.#reportDepartment(result)

        if (!this.dryRun) {
          await this.#recordImport(client, result, runId)
          await this.#updateProgress(client, runId, result)
        }
      }

      if (!this.dryRun) {
        // ANALYZE en fin d'import : cf. Annexe A.6.
        this.logger.info('ANALYZE des tables de mutations …')
        await importer.analyze()
        await this.#refreshAggregates(client)
        await this.#finishRun(client, runId, results)
        await this.#publishDatasetVersion(client, results, baseUrl)
      }

      this.#reportTotals(results)

      if (results.some((result) => result.status === 'failed')) {
        this.exitCode = 1
      }
    } finally {
      await importer.releaseLock().catch(() => undefined)
      await client.end().catch(() => undefined)
    }
  }

  /* ── Journal d'exécution (Annexe A.8) ──────────────────────────────── */

  async #startRun(client: pg.Client, departments: string[]): Promise<number> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO ingestion_runs (source, millesime, statut, progression)
       VALUES ('dvf', $1, 'running', $2::jsonb)
       RETURNING id`,
      [this.year, JSON.stringify({ planned: departments, done: [] })]
    )
    return Number(result.rows[0].id)
  }

  async #recordImport(
    client: pg.Client,
    result: DepartmentImportResult,
    runId: number | null
  ): Promise<void> {
    await client.query(
      `INSERT INTO dvf_imports (
         source_url, annee, code_departement, etag, sha256,
         rows_read, rows_kept, rows_inserted, rows_updated, rows_stale_marked,
         rejected_counts, status, error, run_id, rules_version, finished_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15, now())
       -- Correctif d'un défaut du Lot 1 : l'index unique partiel
       -- dvf_imports_file_uniq (annee, code_departement, sha256)
       -- WHERE sha256 IS NOT NULL AND status = 'success' rendait
       -- « dvf:import --force » impossible dès le deuxième passage : les
       -- mutations étaient bien réécrites, puis la commande échouait sur le
       -- journal, laissant ingestion_runs bloqué en « running ».
       -- L'unicité reste la bonne intention (A.8 : rejouer le même fichier
       -- est un no-op) ; c'est le rejeu FORCÉ qui doit mettre la ligne à jour
       -- plutôt que d'en créer une seconde.
       ON CONFLICT (annee, code_departement, sha256)
         WHERE sha256 IS NOT NULL AND status = 'success'
       DO UPDATE SET
         source_url     = EXCLUDED.source_url,
         etag           = EXCLUDED.etag,
         rows_read      = EXCLUDED.rows_read,
         rows_kept      = EXCLUDED.rows_kept,
         rows_inserted  = EXCLUDED.rows_inserted,
         rows_updated   = EXCLUDED.rows_updated,
         rows_stale_marked = EXCLUDED.rows_stale_marked,
         rejected_counts = EXCLUDED.rejected_counts,
         status         = EXCLUDED.status,
         error          = EXCLUDED.error,
         run_id         = EXCLUDED.run_id,
         rules_version  = EXCLUDED.rules_version,
         finished_at    = now()`,
      [
        result.url,
        result.annee,
        result.codeDepartement,
        result.etag,
        result.sha256,
        result.rowsRead,
        result.rowsKept,
        result.rowsInserted,
        result.rowsUpdated,
        // Bâti + terrain : le journal du fichier porte le total marqué par cet
        // import, les deux tables confondues.
        result.rowsStaleMarked + result.terrainStaleMarked,
        JSON.stringify(result.rejectedCounts),
        result.status,
        result.error ?? null,
        runId,
        DVF_RULES_VERSION,
      ]
    )
  }

  async #updateProgress(
    client: pg.Client,
    runId: number | null,
    result: DepartmentImportResult
  ): Promise<void> {
    if (runId === null) {
      return
    }

    // `progression.done` alimente une future reprise (`--resume`).
    await client.query(
      `UPDATE ingestion_runs
          SET progression = jsonb_set(
                progression, '{done}',
                coalesce(progression->'done', '[]'::jsonb) || to_jsonb($2::text)
              ),
              rows_read     = rows_read + $3,
              rows_inserted = rows_inserted + $4,
              rows_updated  = rows_updated + $5,
              rows_rejected = rows_rejected + $6,
              rows_stale_marked = rows_stale_marked + $7
        WHERE id = $1`,
      [
        runId,
        result.codeDepartement,
        result.rowsRead,
        result.rowsInserted,
        result.rowsUpdated,
        result.rowsRejected,
        result.rowsStaleMarked + result.terrainStaleMarked,
      ]
    )
  }

  async #finishRun(
    client: pg.Client,
    runId: number | null,
    results: DepartmentImportResult[]
  ): Promise<void> {
    if (runId === null) {
      return
    }

    const failed = results.filter((result) => result.status === 'failed').length
    const statut = failed === 0 ? 'success' : failed === results.length ? 'failed' : 'partial'

    const rejets: Record<string, number> = {}
    for (const result of results) {
      for (const [reason, count] of Object.entries(result.rejectedCounts)) {
        rejets[reason] = (rejets[reason] ?? 0) + count
      }
    }

    await client.query(
      `UPDATE ingestion_runs
          SET statut = $2, rejets = $3::jsonb, finished_at = now()
        WHERE id = $1`,
      [runId, statut, JSON.stringify(rejets)]
    )
  }

  /* ── Statistiques de marché (§5.1) ─────────────────────────────────── */

  /**
   * Rafraîchit `agg_commune_type` en fin d'import.
   *
   * Ce n'est plus seulement l'alimentation de `GET /v1/marche/:codeInsee` :
   * depuis la correction de la garde A.10, la cascade y lit les médianes
   * communales du chemin chaud. Une vue jamais rafraîchie neutraliserait donc
   * la garde de cohérence de marché **en silence** — exactement le genre de
   * dégradation invisible que cette spec cherche à éliminer.
   *
   * L'échec **ne perd aucune donnée** — l'import est déjà commité — mais il
   * n'est pas anodin pour autant : la garde A.10 retombe en mode permissif, et
   * elle y reste jusqu'au prochain `refresh:aggregates`. Une vue périmée porte
   * en outre les lignes marquées `stale_reimport`, que l'import vient
   * précisément d'écarter.
   *
   * C'était un simple `warn`, noyé dans plusieurs centaines de lignes de
   * rapport : une dégradation silencieuse de la qualité des estimations,
   * exactement ce que cette spec cherche à éliminer. On le remonte donc en
   * **erreur avec code de sortie non nul** — le cron mensuel et la CI le
   * verront, sans que les données importées soient perdues.
   */
  async #refreshAggregates(client: pg.Client): Promise<void> {
    try {
      const populated = await client.query<{ ispopulated: boolean }>(
        `SELECT ispopulated FROM pg_matviews WHERE matviewname = 'agg_commune_type'`
      )

      if (populated.rows.length === 0) {
        // La vue n'existe pas : base non migrée. Rien à rafraîchir, et rien à
        // signaler — ce n'est pas une dégradation, c'est un autre problème.
        return
      }

      this.logger.info('Rafraîchissement de agg_commune_type …')
      await client.query(
        populated.rows[0].ispopulated
          ? 'REFRESH MATERIALIZED VIEW CONCURRENTLY agg_commune_type'
          : 'REFRESH MATERIALIZED VIEW agg_commune_type'
      )
    } catch (error) {
      this.logger.error(
        `Rafraîchissement de agg_commune_type IMPOSSIBLE : ${(error as Error).message}. ` +
          'Les données sont importées, mais la garde de cohérence de marché (A.10) ' +
          'est désormais PERMISSIVE et la vue de marché est périmée. ' +
          'Lancez « node ace refresh:aggregates » avant de considérer cet import comme terminé.'
      )
      this.exitCode = 1
    }
  }

  /* ── Millésime des données (Annexe A.8) ────────────────────────────── */

  /**
   * Publie le millésime courant dans `dataset_versions`.
   *
   * ══════════════════════════════════════════════════════════════════════
   * POURQUOI CETTE ÉTAPE EXISTE
   * ══════════════════════════════════════════════════════════════════════
   * Le Lot 1 avait créé la table sans jamais l'alimenter : conséquence
   * directe, `GET /v1/meta/data-version` renvoyait `dvfPublicationDate: null`
   * et `datasetVersion: null`, et l'en-tête `X-Data-Version` n'était jamais
   * posé. Or US-9 exige que la mention légale porte la **vraie** date de
   * publication et que « la date affichée provienne de la réponse de l'API,
   * jamais d'une valeur écrite en dur ». Sans cette table alimentée,
   * l'exigence était inapplicable.
   *
   * La date retenue est le `Last-Modified` du fichier source le plus récent
   * effectivement ingéré : c'est une donnée observée, pas une supposition sur
   * le calendrier de publication d'Etalab. À défaut (miroir sans en-tête), on
   * n'invente rien : `published_at` reste nul et l'identifiant se réduit au
   * millésime.
   *
   * `dataset_version` sert aussi de **clé du cache applicatif** (§2.6) : un
   * import frais invalide donc immédiatement les estimations mises en cache,
   * ce qui évite qu'un utilisateur voie encore, 23 heures durant, un prix
   * calculé sur les données de la veille.
   */
  async #publishDatasetVersion(
    client: pg.Client,
    results: DepartmentImportResult[],
    baseUrl: string
  ): Promise<void> {
    const successful = results.filter((result) => result.status === 'success')
    if (successful.length === 0) {
      return
    }

    const publishedAt = successful
      .map((result) => result.lastModified)
      .filter((value): value is string => Boolean(value))
      .map((value) => new Date(value))
      .filter((date) => !Number.isNaN(date.getTime()))
      .sort((a, b) => b.getTime() - a.getTime())[0]

    const datasetVersion = publishedAt
      ? `dvf-${publishedAt.getUTCFullYear()}-${String(publishedAt.getUTCMonth() + 1).padStart(2, '0')}`
      : `dvf-${this.year}`

    const sources = [
      {
        name: 'Demandes de valeurs foncières géolocalisées (DVF)',
        producer: 'Direction générale des finances publiques (DGFiP) — diffusion Etalab',
        url: baseUrl,
        licence: 'Licence Ouverte / Etalab 2.0',
        millesime: this.year,
        departements: successful.map((result) => result.codeDepartement),
        publishedAt: publishedAt ? publishedAt.toISOString() : null,
      },
    ]

    await client.query('BEGIN')
    try {
      /*
       * Un seul millésime courant à la fois — l'index unique partiel
       * `WHERE is_current` l'impose. On démarque donc avant de marquer, dans
       * la même transaction, sinon l'insertion viole la contrainte.
       */
      await client.query('UPDATE dataset_versions SET is_current = false WHERE is_current')

      await client.query(
        `INSERT INTO dataset_versions (dataset_version, published_at, sources, is_current)
         VALUES ($1, $2, $3::jsonb, true)
         ON CONFLICT (dataset_version) DO UPDATE SET
           published_at = COALESCE(EXCLUDED.published_at, dataset_versions.published_at),
           sources      = EXCLUDED.sources,
           is_current   = true`,
        [datasetVersion, publishedAt ? publishedAt.toISOString() : null, JSON.stringify(sources)]
      )

      await client.query('COMMIT')
      this.logger.success(
        `Millésime publié : ${datasetVersion}` +
          (publishedAt ? ` (fichiers publiés le ${publishedAt.toISOString().slice(0, 10)})` : '')
      )
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      // Un millésime non publié dégrade la mention légale, il ne doit pas
      // faire échouer un import de plusieurs heures.
      this.logger.warning(
        `Publication du millésime impossible : ${(error as Error).message}. ` +
          'Les données sont importées ; relancez la commande pour republier.'
      )
    }
  }

  /* ── Restitution ───────────────────────────────────────────────────── */

  #reportDepartment(result: DepartmentImportResult): void {
    if (result.status === 'failed') {
      this.logger.error(`   ${result.codeDepartement} : ÉCHEC — ${result.error}`)
      return
    }

    if (result.status === 'skipped') {
      this.logger.info(`   ${result.codeDepartement} : ignoré (déjà importé)`)
      return
    }

    const seconds = (result.durationMs / 1000).toFixed(1)
    this.logger.success(
      `   ${result.codeDepartement} : ${result.rowsRead} lignes lues, ` +
        `${result.mutationsSeen} mutations, ${result.rowsKept} retenues ` +
        `(${result.rowsInserted} insérées / ${result.rowsUpdated} mises à jour), ` +
        `${result.rowsRejected} rejetées, ${result.outliers} marquées aberrantes — ${seconds}s`
    )

    this.logger.info(
      `      terrains nus : ${result.terrainSeen} candidats, ${result.terrainKept} retenus ` +
        `(${result.terrainInserted} insérés / ${result.terrainUpdated} mis à jour), ` +
        `${result.terrainOutliers} marqués aberrants`
    )

    for (const [reason, count] of Object.entries(result.terrainRejectedCounts).sort(
      (a, b) => b[1] - a[1]
    )) {
      this.logger.info(`         · ${reason} : ${count}`)
    }

    /*
     * Annexe A.2. Un non-zéro ici n'est PAS une statistique de routine : il
     * signale des lignes issues d'une règle d'ingestion antérieure, restées
     * en base et jusqu'ici comptées dans les médianes. On le remonte en
     * avertissement pour qu'il ne se noie pas dans le rapport.
     */
    const stale = result.rowsStaleMarked + result.terrainStaleMarked
    if (stale > 0) {
      this.logger.warning(
        `      ${stale} ligne(s) marquée(s) « stale_reimport » ` +
          `(${result.rowsStaleMarked} bâti / ${result.terrainStaleMarked} terrain) : ` +
          "non réécrites par cet import, donc issues d'une règle antérieure ou " +
          'disparues du fichier source. Pensez à « node ace refresh:aggregates ».'
      )
    }

    const rejects = Object.entries(result.rejectedCounts).sort((a, b) => b[1] - a[1])
    for (const [reason, count] of rejects) {
      this.logger.info(`      · ${reason} : ${count}`)
    }
  }

  #reportTotals(results: DepartmentImportResult[]): void {
    const total = (pick: (result: DepartmentImportResult) => number) =>
      results.reduce((sum, result) => sum + pick(result), 0)

    const rejets: Record<string, number> = {}
    for (const result of results) {
      for (const [reason, count] of Object.entries(result.rejectedCounts)) {
        rejets[reason] = (rejets[reason] ?? 0) + count
      }
    }

    this.logger.info('─'.repeat(60))
    this.logger.info(
      `TOTAL : ${total((r) => r.rowsRead)} lignes lues, ` +
        `${total((r) => r.mutationsSeen)} mutations, ` +
        `${total((r) => r.rowsKept)} retenues, ` +
        `${total((r) => r.rowsRejected)} rejetées, ` +
        `${total((r) => r.outliers)} aberrantes`
    )
    this.logger.info(
      `TERRAINS : ${total((r) => r.terrainKept)} retenus ` +
        `(${total((r) => r.terrainInserted)} insérés / ` +
        `${total((r) => r.terrainUpdated)} mis à jour), ` +
        `${total((r) => r.terrainOutliers)} aberrants`
    )

    const stale = total((r) => r.rowsStaleMarked + r.terrainStaleMarked)
    if (stale > 0) {
      this.logger.warning(
        `OBSOLÈTES : ${stale} ligne(s) marquée(s) « stale_reimport » (Annexe A.2).`
      )
    }

    for (const [reason, count] of Object.entries(rejets).sort((a, b) => b[1] - a[1])) {
      this.logger.info(`  · ${reason} : ${count}`)
    }

    if (this.dryRun) {
      this.logger.warning('MODE SIMULATION : aucune écriture n’a été effectuée.')
    }
  }
}
