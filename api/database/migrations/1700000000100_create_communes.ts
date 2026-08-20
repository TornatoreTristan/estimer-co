import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Référentiel communal INSEE — spec §5.1.
 *
 * Sert de repli quand le géocodage BAN échoue (centroïde), de source des
 * libellés propres, du rattachement EPCI/département/région, et porte le
 * drapeau `has_dvf` (§1.3, §2.7).
 */
export default class extends BaseSchema {
  protected tableName = 'communes'

  async up() {
    this.schema.raw(`
      CREATE TABLE ${this.tableName} (
        code_insee        char(5)     PRIMARY KEY,
        nom               text        NOT NULL,
        nom_normalise     text        NOT NULL,          -- minuscules, sans accent : recherche floue
        codes_postaux     text[]      NOT NULL DEFAULT '{}',
        code_departement  char(3)     NOT NULL,
        code_region       char(2)     NOT NULL,
        code_epci         char(9)     NULL,
        population        integer      NULL,
        densite_grille    smallint    NULL,              -- grille de densité INSEE, 1 à 7
        centroid          geography(Point,4326) NOT NULL,
        -- false pour 57, 67, 68 (Livre foncier alsacien-mosellan) et 976.
        -- Ces départements sont absents de DVF : le repli §3.9 s'appuie
        -- dessus. Jamais un silence, jamais une fausse mention DVF.
        has_dvf           boolean     NOT NULL DEFAULT true,
        updated_at        timestamptz NOT NULL DEFAULT now()
      )
    `)

    this.schema.raw(
      `CREATE INDEX communes_codes_postaux_gin ON ${this.tableName} USING GIN (codes_postaux)`
    )
    this.schema.raw(`CREATE INDEX communes_departement_idx ON ${this.tableName} (code_departement)`)
    this.schema.raw(
      `CREATE INDEX communes_epci_idx ON ${this.tableName} (code_epci) WHERE code_epci IS NOT NULL`
    )
    this.schema.raw(`CREATE INDEX communes_region_idx ON ${this.tableName} (code_region)`)
    this.schema.raw(
      `CREATE INDEX communes_centroid_gist ON ${this.tableName} USING GIST (centroid)`
    )
    // Recherche floue de commune par nom (repli de géocodage).
    this.schema.raw(
      `CREATE INDEX communes_nom_trgm ON ${this.tableName} USING GIN (nom_normalise gin_trgm_ops)`
    )
  }

  async down() {
    this.schema.raw(`DROP TABLE IF EXISTS ${this.tableName}`)
  }
}
