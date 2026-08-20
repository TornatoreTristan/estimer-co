import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Marquage des lignes obsolètes au ré-import — Annexe A.2 et A.7.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ
 * ══════════════════════════════════════════════════════════════════════════
 * L'ingestion ne supprime jamais (A.7 : « aucun DROP, aucun TRUNCATE sur
 * `mutations` ») et l'upsert ne réécrit que les mutations que les règles
 * COURANTES retiennent. Conséquence : dès qu'une règle d'ingestion est
 * corrigée, les lignes produites par l'ANCIENNE règle restent en base — non
 * réécrites, non marquées, donc **comptées dans les médianes**. Mesuré sur la
 * Creuse : 105 lignes obsolètes, et jusqu'à +149 % sur une médiane communale.
 *
 * Le ré-import marque désormais ces lignes `exclusion_reason =
 * 'stale_reimport'` (A.2 : « marquer, jamais supprimer »). Trois ajouts ici :
 *
 *  1. `rows_stale_marked` sur `dvf_imports` et `ingestion_runs`. Un non-zéro
 *     sur un ré-import de routine est le signal qui manquait : il dit que les
 *     règles ont changé, ou qu'une mutation a disparu du fichier source.
 *
 *  2. `rules_version` sur `dvf_imports`. L'idempotence par sha256 fait
 *     *skipper* un fichier identique (A.8) — ce qui rendrait tout correctif de
 *     règle inopérant sans `--force`. En mémorisant la version des règles avec
 *     laquelle le fichier a été ingéré, un changement de règles invalide le
 *     skip de lui-même.
 *
 *  3. Un index de balayage `(code_departement, source_annee, imported_at)`.
 *     Sans lui, l'UPDATE de marquage impose un parcours complet des partitions
 *     à CHAQUE département, soit ~96 parcours d'une table de 6-7 M de lignes
 *     par import national. L'index existant `_dep_idx` ne peut pas servir :
 *     il est partiel sur `is_outlier = false`, alors que le marquage doit
 *     aussi atteindre des lignes déjà marquées pour un autre motif.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(`
      ALTER TABLE dvf_imports
        ADD COLUMN rows_stale_marked bigint   NOT NULL DEFAULT 0,
        -- Version des règles d'ingestion appliquées. Voir DVF_RULES_VERSION
        -- (app/dvf/importer.ts) : à incrémenter à chaque correctif de règle.
        ADD COLUMN rules_version     smallint NOT NULL DEFAULT 1
    `)

    this.schema.raw(`
      ALTER TABLE ingestion_runs
        ADD COLUMN rows_stale_marked bigint NOT NULL DEFAULT 0
    `)

    for (const table of ['mutations', 'mutations_terrain']) {
      this.schema.raw(`
        CREATE INDEX ${table}_stale_scan_idx
          ON ${table} (code_departement, source_annee, imported_at)
      `)
    }
  }

  async down() {
    for (const table of ['mutations', 'mutations_terrain']) {
      this.schema.raw(`DROP INDEX IF EXISTS ${table}_stale_scan_idx`)
    }

    this.schema.raw(`
      ALTER TABLE ingestion_runs
        DROP COLUMN IF EXISTS rows_stale_marked
    `)

    this.schema.raw(`
      ALTER TABLE dvf_imports
        DROP COLUMN IF EXISTS rows_stale_marked,
        DROP COLUMN IF EXISTS rules_version
    `)
  }
}
