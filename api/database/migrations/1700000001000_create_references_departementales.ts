import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Références départementales — spec §5.1 et §3.9.
 *
 * Seule source de prix pour les territoires **absents de DVF** : Bas-Rhin
 * (67), Haut-Rhin (68), Moselle (57) — régime du Livre foncier — et Mayotte
 * (976). Sans cette table, la cascade de comparables descendrait jusqu'au
 * niveau national et présenterait une moyenne nationale comme un prix local :
 * le pire scénario possible, car il est indétectable par l'utilisateur.
 *
 * `source_label` est `NOT NULL` pour la même raison qu'en §8.4 : quand la
 * référence provient de `src/data/prix.ts`, elle doit porter l'étiquette
 * « Estimation interne, hors DVF » (§3.9) et non une mention DVF trompeuse.
 *
 * La clé primaire est `(code_departement, type_bien)` : le prix d'une maison
 * et celui d'un appartement n'ont aucune raison d'être égaux, et §3.9 renvoie
 * bien un prix par type.
 */
export default class extends BaseSchema {
  protected tableName = 'references_departementales'

  async up() {
    this.schema.raw(`
      CREATE TABLE ${this.tableName} (
        code_departement  char(3)       NOT NULL,
        -- 'appartement' | 'maison'
        type_bien         text          NOT NULL,
        prix_m2           numeric(10,2) NOT NULL,
        source_label      text          NOT NULL,
        source_url        text          NULL,
        date_source       date          NOT NULL,
        note              text          NULL,
        updated_at        timestamptz   NOT NULL DEFAULT now(),

        PRIMARY KEY (code_departement, type_bien),

        CONSTRAINT references_departementales_prix_chk
          CHECK (prix_m2 > 0),
        CONSTRAINT references_departementales_source_chk
          CHECK (length(btrim(source_label)) > 0)
      )
    `)
  }

  async down() {
    this.schema.raw(`DROP TABLE IF EXISTS ${this.tableName}`)
  }
}
