import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Journal anonymisé des estimations — spec §5.1, §2.6 (point 5), §8.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUNE DONNÉE PERSONNELLE, PAR CONSTRUCTION.
 * ══════════════════════════════════════════════════════════════════════════
 * §8.3 : « l'adresse d'un bien reste une donnée à caractère personnel dès
 * qu'elle est reliable à une personne : elle n'est donc jamais journalisée en
 * clair — `estimations_log` ne conserve que le code INSEE ». Il n'existe donc
 * ici **aucune colonne** pouvant accueillir une adresse, un nom, un e-mail ou
 * un téléphone : la conformité est garantie par le schéma, pas par la
 * discipline du code appelant.
 *
 * L'IP n'est stockée que sous forme de HMAC-SHA256 salé (`IP_HASH_SALT`,
 * jamais commité) : suffisant pour compter les requêtes d'un même client et
 * détecter un abus, insuffisant pour remonter à l'IP.
 *
 * Rétention **12 mois**, purge par tâche planifiée.
 */
export default class extends BaseSchema {
  protected tableName = 'estimations_log'

  async up() {
    this.schema.raw(`
      CREATE TABLE ${this.tableName} (
        id                bigserial PRIMARY KEY,
        created_at        timestamptz NOT NULL DEFAULT now(),

        -- Granularité géographique maximale autorisée : la commune.
        code_insee        char(5)     NULL,
        code_departement  char(3)     NULL,

        type_bien         text        NOT NULL,
        surface           integer     NULL,

        method_kind       text        NOT NULL,
        method_level      text        NULL,
        radius_m          integer     NULL,
        n_comparables     integer     NOT NULL DEFAULT 0,
        confidence        smallint    NULL,

        value_low         integer     NULL,
        value_mid         integer     NULL,
        value_high        integer     NULL,
        price_m2          integer     NULL,

        duration_ms       integer     NOT NULL DEFAULT 0,
        -- true quand la réponse provient du cache applicatif 24 h (§2.6).
        cache_hit         boolean     NOT NULL DEFAULT false,

        -- HMAC-SHA256(IP, IP_HASH_SALT). Jamais l'IP en clair (§8.3).
        ip_hmac           char(64)    NULL,
        ua_hash           char(64)    NULL,
        api_version       smallint    NOT NULL DEFAULT 1
      )
    `)

    // Purge de rétention : `DELETE … WHERE created_at < now() - interval '12 months'`.
    this.schema.raw(`CREATE INDEX estimations_log_created_idx ON ${this.tableName} (created_at)`)
    // Détection d'abus (§2.6 : « > 5 000 req/jour depuis moins de 20 IP »).
    this.schema.raw(
      `CREATE INDEX estimations_log_ip_idx ON ${this.tableName} (ip_hmac, created_at DESC)
         WHERE ip_hmac IS NOT NULL`
    )
    // Pilotage qualité (Lot 6) : distribution des niveaux de cascade.
    this.schema.raw(
      `CREATE INDEX estimations_log_method_idx ON ${this.tableName} (method_kind, created_at DESC)`
    )
  }

  async down() {
    this.schema.raw(`DROP TABLE IF EXISTS ${this.tableName}`)
  }
}
