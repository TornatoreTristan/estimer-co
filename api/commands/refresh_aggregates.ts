import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import { REFRESH_AGG_CONCURRENTLY_SQL, REFRESH_AGG_SQL } from '#database/sql/agg_commune_type'

/**
 * `node ace refresh:aggregates` — spec §5.1.
 *
 * Rafraîchit `agg_commune_type`, appelée en fin d'import DVF.
 *
 * `CONCURRENTLY` évite de poser un verrou exclusif qui rendrait
 * `GET /v1/marche/:codeInsee` indisponible pendant le recalcul. Il exige
 * toutefois que la vue ait déjà été peuplée une fois : le premier
 * rafraîchissement se fait donc en mode normal, sur une vue encore vide —
 * donc instantané.
 */
export default class RefreshAggregates extends BaseCommand {
  static commandName = 'refresh:aggregates'
  static description = 'Rafraîchit la vue matérialisée agg_commune_type'

  static options: CommandOptions = { startApp: true }

  async run() {
    const populated = await db.rawQuery(
      `SELECT ispopulated FROM pg_matviews WHERE matviewname = 'agg_commune_type'`
    )

    const isPopulated = populated.rows?.[0]?.ispopulated === true
    const startedAt = Date.now()

    if (isPopulated) {
      this.logger.info('Rafraîchissement concurrent de agg_commune_type …')
      await db.rawQuery(REFRESH_AGG_CONCURRENTLY_SQL)
    } else {
      this.logger.info('Premier remplissage de agg_commune_type …')
      await db.rawQuery(REFRESH_AGG_SQL)
    }

    const count = await db.from('agg_commune_type').count('* as total').first()

    this.logger.success(
      `agg_commune_type rafraîchie : ${Number(count?.total ?? 0)} lignes ` +
        `en ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`
    )
  }
}
