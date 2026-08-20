import { BaseSchema } from '@adonisjs/lucid/schema'
import { mutationsTableSql, mutationsIndexesSql } from '#database/sql/mutations_schema'

/**
 * Table `mutations_terrain` — spec §5.1.
 *
 * « Même structure, `type_local = 'terrain'`, `surface_bati` NULL, `prix_m2`
 * calculé sur `surface_terrain`. »
 *
 * Partitionnée comme `mutations` : la structure est produite par le même
 * générateur, ce qui garantit qu'un index ajouté d'un côté l'est de l'autre.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(mutationsTableSql('mutations_terrain', { built: false }))
    for (const statement of mutationsIndexesSql('mutations_terrain', { built: false })) {
      this.schema.raw(statement)
    }

    const currentYear = new Date().getUTCFullYear()
    for (let year = 2014; year <= currentYear + 1; year += 1) {
      this.schema.raw(`SELECT ensure_annual_partition('mutations_terrain', ${year})`)
    }
  }

  async down() {
    this.schema.raw('DROP TABLE IF EXISTS mutations_terrain CASCADE')
  }
}
