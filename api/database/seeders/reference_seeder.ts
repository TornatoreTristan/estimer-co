import { BaseSeeder } from '@adonisjs/lucid/seeders'
import db from '@adonisjs/lucid/services/db'
import { seedReferenceData } from '#database/seed_data/seed_reference_data'

/**
 * `node ace db:seed` — référentiels de calcul (§3.6) et références
 * départementales du repli hors DVF (§3.9).
 *
 * Ce seeder n'est **pas** un jeu de données de démonstration : sans lui,
 * `coefficients_reference` est vide et tous les coefficients d'ajustement
 * retombent à 1,00 (comportement neutre volontaire, jamais une valeur
 * inventée). Il fait donc partie du provisionnement d'un environnement, au
 * même titre que les migrations.
 */
export default class extends BaseSeeder {
  async run() {
    await seedReferenceData(db)
  }
}
