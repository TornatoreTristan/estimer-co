import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Suivi d'une opération d'écriture Git déclenchée par l'IA
 * (specs/blog-automatisation-ia.md §5) : un `blog_job` par appel
 * `POST /v1/blog/articles`, `/articles/:slug/publish` ou `/auteurs`.
 *
 * `UNIQUE (client_id, idempotency_key)` porte à lui seul l'idempotence (B3) :
 * un rejeu avec la même clé retombe sur la même ligne, jamais une nouvelle
 * branche ni une nouvelle PR. `payload_hash` détecte le cas « même clé,
 * payload différent » (422 `idempotency_key_reused`), qui n'est PAS une
 * violation de la contrainte SQL mais une règle applicative vérifiée avant
 * l'upsert.
 *
 * `response` rejoue TEL QUEL le corps HTTP d'origine — c'est ce qui garantit
 * qu'un retry reçoit une réponse strictement identique (B3), y compris le
 * code 201 initial (que le rejeu renvoie en 200, cf. la gate applicative).
 */
export default class extends BaseSchema {
  protected tableName = 'blog_jobs'

  async up() {
    this.schema.raw(`
      CREATE TABLE ${this.tableName} (
        id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id             uuid        NOT NULL REFERENCES blog_api_clients(id) ON DELETE CASCADE,
        idempotency_key       text        NOT NULL,
        -- article_upsert | article_publish | auteur_create
        action                text        NOT NULL,
        slug                  text        NOT NULL,
        branch                text        NOT NULL,
        -- pending | validating | failed | pushed | pr_open | pr_merged | pr_closed
        status                text        NOT NULL DEFAULT 'pending',
        pr_number             integer     NULL,
        pr_url                text        NULL,
        payload_hash          text        NOT NULL,
        response              jsonb       NULL,
        validation_errors     jsonb       NULL,
        validation_warnings   jsonb       NULL,
        error_message         text        NULL,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now(),

        UNIQUE (client_id, idempotency_key)
      )
    `)

    // Détecte une opération déjà en cours sur un slug (G2, 409 operation_in_progress).
    this.schema.raw(`CREATE INDEX blog_jobs_slug_idx ON ${this.tableName} (slug)`)
  }

  async down() {
    this.schema.raw(`DROP TABLE IF EXISTS ${this.tableName}`)
  }
}
