import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Store `database` de @adonisjs/limiter — spec §2.6.
 *
 * Structure imposée par `rate-limiter-flexible` (via l'adaptateur AdonisJS) :
 * ne pas renommer les colonnes.
 *
 * PostgreSQL est retenu au Lot 0 : le volume actuel ne justifie pas
 * d'exploiter un Redis supplémentaire. Le passage à Redis se fera en
 * changeant `LIMITER_STORE`, sans toucher aux définitions des limiteurs.
 */
export default class extends BaseSchema {
  protected tableName = 'rate_limits'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('key', 255).notNullable().primary()
      table.integer('points', 9).notNullable().defaultTo(0)
      table.bigint('expire').unsigned()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
