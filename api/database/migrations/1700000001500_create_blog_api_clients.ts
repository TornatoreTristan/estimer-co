import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Clients autorisés à appeler `/v1/blog/**` (specs/blog-automatisation-ia.md
 * §5) — un agent IA par ligne, jamais un jeton partagé entre plusieurs.
 *
 * `token_hash` : le jeton n'est JAMAIS stocké en clair. `node ace
 * blog:client:create` l'affiche une seule fois à la création ; seul son
 * empreinte SHA-256 est conservée, comparée à chaque requête par
 * `BlogAuthMiddleware`.
 *
 * `revoked_at` plutôt qu'une suppression : un jeton révoqué doit rester
 * traçable dans les jointures de `blog_jobs.client_id` (US A1 : « révocable »,
 * pas « supprimable »).
 */
export default class extends BaseSchema {
  protected tableName = 'blog_api_clients'

  async up() {
    this.schema.raw(`
      CREATE TABLE ${this.tableName} (
        id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        name         text        NOT NULL,
        token_hash   text        NOT NULL UNIQUE,
        -- Scopes accordés : "articles:write", "publish:request", "auteurs:write"…
        scopes       text[]      NOT NULL DEFAULT '{}',
        created_at   timestamptz NOT NULL DEFAULT now(),
        revoked_at   timestamptz NULL
      )
    `)
  }

  async down() {
    this.schema.raw(`DROP TABLE IF EXISTS ${this.tableName}`)
  }
}
