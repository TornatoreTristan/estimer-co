import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Indice Insee-Notaires des prix des logements anciens — spec §5.1, §3.4.
 *
 * La table est créée au Lot 2 parce que l'ajustement temporel du §3.4 en
 * dépend ; son **alimentation** relève du Lot 4 (`indices:import`). Tant
 * qu'elle est vide, le facteur d'ajustement vaut 1 et le DTO expose
 * `priceIndexQuarter: null` : le calcul reste juste, simplement non corrigé
 * de l'inflation immobilière — un biais connu, exposé, et non un silence.
 *
 * `code_region = 'FR'` porte la série nationale, utilisée par la cascade de
 * repli du §3.4 (région,type) → (région,tous) → (FR,type) → (FR,tous).
 * `type_bien = 'all'` joue le même rôle pour le type de bien. Les deux
 * conventions évitent une table de replis parallèle.
 */
export default class extends BaseSchema {
  protected tableName = 'indices_prix'

  async up() {
    this.schema.raw(`
      CREATE TABLE ${this.tableName} (
        id            bigserial PRIMARY KEY,

        -- Code région INSEE sur 2 caractères, ou 'FR' pour la série nationale.
        code_region   char(2)       NOT NULL,
        -- 'appartement' | 'maison' | 'all'
        type_bien     text          NOT NULL,
        -- Premier jour du trimestre (2025-04-01 = T2 2025).
        trimestre     date          NOT NULL,
        indice        numeric(8,3)  NOT NULL,
        base_100      text          NOT NULL,

        source_label  text          NOT NULL,
        source_url    text          NOT NULL,
        published_at  date          NULL,
        created_at    timestamptz   NOT NULL DEFAULT now(),

        CONSTRAINT indices_prix_indice_chk CHECK (indice > 0)
      )
    `)

    this.schema.raw(`
      CREATE UNIQUE INDEX indices_prix_serie_uniq
        ON ${this.tableName} (code_region, type_bien, trimestre)
    `)

    /*
     * §3.4 : « T0 = dernier trimestre PUBLIÉ », et aucune extrapolation
     * au-delà. Cette lecture (« le trimestre le plus récent d'une série »)
     * est faite à chaque estimation : elle doit être indexée.
     */
    this.schema.raw(`
      CREATE INDEX indices_prix_dernier_idx
        ON ${this.tableName} (code_region, type_bien, trimestre DESC)
    `)
  }

  async down() {
    this.schema.raw(`DROP TABLE IF EXISTS ${this.tableName}`)
  }
}
