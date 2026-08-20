import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Extensions PostgreSQL requises — spec §5.1 et Annexe A.4.
 *
 * L'image `postgis/postgis:16-3.4` fournit les binaires ; il reste à activer
 * les extensions dans la base. Ne jamais tenter d'installer PostGIS sur une
 * image `postgres` nue (spec §9, risque principal du Lot 0).
 */
export default class extends BaseSchema {
  async up() {
    // Géométries, ST_DWithin, index GiST.
    this.schema.raw('CREATE EXTENSION IF NOT EXISTS postgis')

    // Index GiST multicolonnes mêlant géométrie et scalaires (A.5) :
    // sans btree_gist, `GIST (geom, type_local, surface_bati)` est impossible.
    this.schema.raw('CREATE EXTENSION IF NOT EXISTS btree_gist')

    // Normalisation des noms de communes (« Saint-Étienne » ~ « saint-etienne »).
    this.schema.raw('CREATE EXTENSION IF NOT EXISTS unaccent')

    // Recherche floue de commune (repli quand le géocodage BAN échoue).
    this.schema.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm')
  }

  async down() {
    /*
     * On ne supprime PAS les extensions au rollback.
     *
     * `DROP EXTENSION postgis` détruirait en cascade toute colonne de type
     * geography/geometry encore présente dans la base — y compris celles
     * appartenant à des migrations non annulées. Le gain serait nul, le
     * risque de perte de données maximal.
     */
  }
}
