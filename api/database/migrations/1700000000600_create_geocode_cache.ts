import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Cache de géocodage — spec §3.1 et §5.1.
 *
 * Objectif double :
 *  - ne jamais réinterroger la BAN pour une adresse déjà vue, et rester très
 *    en deçà de ses limites d'usage (service public gratuit, ~50 req/s/IP) ;
 *  - garantir un temps de réponse stable sur les adresses populaires.
 *
 * RGPD (§8.3) : cette table contient des adresses, donc des données à
 * caractère personnel dès qu'elles sont reliables à une personne. TTL 90
 * jours, purge automatique, à inscrire au registre des traitements.
 */
export default class extends BaseSchema {
  protected tableName = 'geocode_cache'

  async up() {
    this.schema.raw(`
      CREATE TABLE ${this.tableName} (
        -- SHA-256 de la requête normalisée (§3.1).
        query_hash   char(64)    PRIMARY KEY,
        query        text        NOT NULL,
        label        text        NULL,
        code_insee   char(5)     NULL,
        city         text        NULL,
        postcode     char(5)     NULL,
        longitude    double precision NULL,
        latitude     double precision NULL,
        geom         geography(Point,4326) NULL,
        score        numeric(4,3) NULL,
        -- 'housenumber' | 'street' | 'locality' | 'municipality' | 'none'
        result_type  text        NULL,
        -- 'exact' | 'approximate' | 'city-centroid'
        precision    text        NULL,
        provider     text        NOT NULL DEFAULT 'ban',
        fetched_at   timestamptz NOT NULL DEFAULT now(),
        expires_at   timestamptz NOT NULL
      )
    `)

    // Purge des entrées expirées (tâche planifiée) et filtrage à la lecture.
    this.schema.raw(`CREATE INDEX geocode_cache_expires_idx ON ${this.tableName} (expires_at)`)
  }

  async down() {
    this.schema.raw(`DROP TABLE IF EXISTS ${this.tableName}`)
  }
}
