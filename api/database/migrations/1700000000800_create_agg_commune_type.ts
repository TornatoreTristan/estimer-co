import { BaseSchema } from '@adonisjs/lucid/schema'
import { AGG_COMMUNE_TYPE_SQL } from '#database/sql/agg_commune_type'

/**
 * Vue matérialisée `agg_commune_type` — spec §5.1.
 *
 * Alimente `GET /v1/marche/:codeInsee` (cible p95 < 100 ms, §3.10), les pages
 * SEO départementales et le repli rapide. Rafraîchie en fin d'import par
 * `node ace refresh:aggregates`.
 *
 * Note d'architecture : agréger ici ne contredit pas l'Annexe A.12. Celle-ci
 * interdit au SQL de calculer médianes et quartiles **sur le chemin des
 * comparables** (où le module de valorisation pur doit rester seul maître du
 * calcul) ; une vue matérialisée de statistiques de marché est un usage
 * différent, hors chemin chaud d'estimation.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(AGG_COMMUNE_TYPE_SQL)

    /*
     * Index UNIQUE obligatoire : sans lui, `REFRESH MATERIALIZED VIEW
     * CONCURRENTLY` est refusé par PostgreSQL, et un rafraîchissement non
     * concurrent poserait un verrou exclusif rendant l'endpoint marché
     * indisponible pendant toute la durée du recalcul.
     */
    this.schema.raw(`
      CREATE UNIQUE INDEX agg_commune_type_pk
        ON agg_commune_type (code_insee, type_local, tranche_surface)
    `)

    /*
     * Premier remplissage IMMÉDIAT, sur une base encore vide — donc
     * instantané.
     *
     * Motif : PostgreSQL **refuse toute lecture** d'une vue matérialisée
     * jamais peuplée (« materialized view has not been populated »). Depuis
     * que la garde de cohérence de marché (A.10) y lit ses médianes
     * communales, une vue laissée `WITH NO DATA` ferait échouer chaque
     * requête de cascade au-delà de 2 km ; la requête étant protégée, le
     * niveau serait abandonné et la cascade descendrait d'un cran **sans que
     * rien ne le signale**.
     *
     * Ce remplissage rend aussi possible le `REFRESH … CONCURRENTLY` de fin
     * d'import, qui exige une vue déjà peuplée au moins une fois.
     */
    this.schema.raw('REFRESH MATERIALIZED VIEW agg_commune_type')
  }

  async down() {
    this.schema.raw('DROP MATERIALIZED VIEW IF EXISTS agg_commune_type')
  }
}
