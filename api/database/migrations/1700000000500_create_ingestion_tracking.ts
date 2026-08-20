import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Traçabilité et idempotence de l'ingestion — spec §5.1 + Annexe A.8.
 *
 * Trois tables complémentaires, à trois granularités différentes :
 *
 *  - `dvf_imports`     : une ligne par FICHIER (année × département). Porte
 *                        l'ETag/sha256 et le détail des rejets. C'est le
 *                        niveau exigé par US-7 (« une ligne par département
 *                        avec statut, rows_read et rejected_counts »).
 *  - `ingestion_runs`  : une ligne par EXÉCUTION de la commande. Porte la
 *                        progression, pour permettre une reprise (A.8).
 *  - `dataset_versions`: le millésime courant des données, source des
 *                        mentions légales (§8.1) et clé de cache globale.
 */
export default class extends BaseSchema {
  async up() {
    /*
     * Un fichier déjà ingéré avec le même contenu ne doit jamais être
     * retraité : l'unicité (annee, departement, sha256) fait du rejeu un
     * no-op, ce qui rend un cron rejoué ou un retry de CI inoffensif.
     */
    this.schema.raw(`
      CREATE TABLE dvf_imports (
        id                bigserial PRIMARY KEY,
        source_url        text        NOT NULL,
        annee             smallint    NOT NULL,
        code_departement  char(3)     NOT NULL,
        etag              text        NULL,
        sha256            char(64)    NULL,
        rows_read         bigint      NOT NULL DEFAULT 0,
        rows_kept         bigint      NOT NULL DEFAULT 0,
        rows_inserted     bigint      NOT NULL DEFAULT 0,
        rows_updated      bigint      NOT NULL DEFAULT 0,
        -- Compteur de rejets PAR MOTIF (§6.2, US-7). Un import qui rejette
        -- 80 % de ses lignes doit pouvoir être diagnostiqué sans relire le
        -- fichier source.
        rejected_counts   jsonb       NOT NULL DEFAULT '{}'::jsonb,
        status            text        NOT NULL DEFAULT 'running',
        error             text        NULL,
        run_id            bigint      NULL,
        started_at        timestamptz NOT NULL DEFAULT now(),
        finished_at       timestamptz NULL,
        CONSTRAINT dvf_imports_status_chk
          CHECK (status IN ('running', 'success', 'failed', 'skipped', 'dry-run'))
      )
    `)

    this.schema.raw(`
      CREATE UNIQUE INDEX dvf_imports_file_uniq
        ON dvf_imports (annee, code_departement, sha256)
        WHERE sha256 IS NOT NULL AND status = 'success'
    `)
    this.schema.raw(
      `CREATE INDEX dvf_imports_dep_idx ON dvf_imports (code_departement, annee, started_at DESC)`
    )

    /*
     * `progression` liste les départements déjà traités : c'est ce qui rend
     * `--resume` possible sans transaction géante (A.7).
     */
    this.schema.raw(`
      CREATE TABLE ingestion_runs (
        id               bigserial PRIMARY KEY,
        source           text        NOT NULL,
        millesime        smallint    NULL,
        fichier_url      text        NULL,
        checksum_sha256  char(64)    NULL,
        statut           text        NOT NULL DEFAULT 'running',
        rows_read        bigint      NOT NULL DEFAULT 0,
        rows_inserted    bigint      NOT NULL DEFAULT 0,
        rows_updated     bigint      NOT NULL DEFAULT 0,
        rows_rejected    bigint      NOT NULL DEFAULT 0,
        rejets           jsonb       NOT NULL DEFAULT '{}'::jsonb,
        progression      jsonb       NOT NULL DEFAULT '{}'::jsonb,
        dataset_version  text        NULL,
        error            text        NULL,
        started_at       timestamptz NOT NULL DEFAULT now(),
        finished_at      timestamptz NULL,
        CONSTRAINT ingestion_runs_statut_chk
          CHECK (statut IN ('running', 'success', 'failed', 'partial', 'dry-run'))
      )
    `)

    // Annexe A.8 : « rejouer le même fichier est un no-op ».
    this.schema.raw(`
      CREATE UNIQUE INDEX ingestion_runs_replay_uniq
        ON ingestion_runs (source, millesime, checksum_sha256)
        WHERE checksum_sha256 IS NOT NULL AND statut = 'success'
    `)

    /*
     * `dataset_versions` — Annexe A.8.
     * Consommée par `GET /v1/meta/data-version` et par les mentions légales
     * du §8.1. `sources` est sérialisé tel quel dans le DTO : la date de
     * publication affichée provient TOUJOURS d'ici, jamais d'une constante
     * écrite en dur dans le front (US-9).
     */
    this.schema.raw(`
      CREATE TABLE dataset_versions (
        id               bigserial PRIMARY KEY,
        dataset_version  text        NOT NULL UNIQUE,
        published_at     timestamptz NULL,
        sources          jsonb       NOT NULL DEFAULT '[]'::jsonb,
        is_current       boolean     NOT NULL DEFAULT false,
        created_at       timestamptz NOT NULL DEFAULT now()
      )
    `)

    // Un seul millésime courant à la fois, garanti par la base.
    this.schema.raw(`
      CREATE UNIQUE INDEX dataset_versions_current_uniq
        ON dataset_versions (is_current) WHERE is_current
    `)
  }

  async down() {
    this.schema.raw('DROP TABLE IF EXISTS dvf_imports')
    this.schema.raw('DROP TABLE IF EXISTS ingestion_runs')
    this.schema.raw('DROP TABLE IF EXISTS dataset_versions')
  }
}
