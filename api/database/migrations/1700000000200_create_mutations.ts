import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  PARTITION_HELPER_SQL,
  mutationsTableSql,
  mutationsIndexesSql,
} from '#database/sql/mutations_schema'

/**
 * Table `mutations` — spec §5.1, corrigée par l'Annexe A (A.1 à A.5).
 *
 * Partitionnée par RANGE sur `date_mutation`, une partition par année.
 * Lucid ne sait pas exprimer le partitionnement : tout est écrit en SQL brut,
 * regroupé dans `database/sql/mutations_schema.ts` pour être partagé avec
 * `mutations_terrain` et testable isolément.
 *
 * Pourquoi partitionner :
 *  - la fenêtre temporelle des comparables est toujours bornée (24 à 60 mois),
 *    donc le planificateur élague les partitions hors fenêtre ;
 *  - un millésime peut être retraité sans toucher aux autres ;
 *  - les index restent d'une taille raisonnable par partition.
 */
export default class extends BaseSchema {
  async up() {
    // Fonction utilitaire de création de partition annuelle, réutilisée par
    // la commande `dvf:import` pour chaque millésime rencontré.
    this.schema.raw(PARTITION_HELPER_SQL)

    this.schema.raw(mutationsTableSql('mutations', { built: true }))
    for (const statement of mutationsIndexesSql('mutations', { built: true })) {
      this.schema.raw(statement)
    }

    /*
     * Partitions initiales.
     *
     * Le millésime « latest » de DVF couvre 5 ans glissants + l'année en
     * cours (§1.1). On provisionne large (2014 → année courante + 1) : une
     * partition vide ne coûte rien, une partition manquante fait échouer un
     * INSERT en pleine nuit.
     */
    const currentYear = new Date().getUTCFullYear()
    for (let year = 2014; year <= currentYear + 1; year += 1) {
      this.schema.raw(`SELECT ensure_annual_partition('mutations', ${year})`)
    }
  }

  async down() {
    // DROP de la table partitionnée : les partitions tombent avec elle.
    this.schema.raw('DROP TABLE IF EXISTS mutations CASCADE')
    this.schema.raw('DROP FUNCTION IF EXISTS ensure_annual_partition(text, integer)')
  }
}
