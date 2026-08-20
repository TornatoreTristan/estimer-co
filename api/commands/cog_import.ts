import { readFile } from 'node:fs/promises'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import {
  CogImporter,
  HttpCommunesSource,
  type CommunesSource,
  type RawCommune,
} from '#services/cog_importer'

/**
 * `node ace cog:import` — référentiel communal INSEE (spec §5.1, Lot 1).
 *
 * Alimente `communes` (code INSEE, nom, codes postaux, département, région,
 * EPCI, population, centroïde) et positionne `has_dvf = false` pour les
 * départements 57, 67, 68 et 976 (§1.3).
 *
 * Exemples :
 *   node ace cog:import
 *   node ace cog:import --dry-run
 *   node ace cog:import --file=./communes.json      # hors ligne
 */
export default class CogImport extends BaseCommand {
  static commandName = 'cog:import'
  static description = 'Importe le référentiel communal INSEE (communes, centroïdes, has_dvf)'

  static options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'Simulation : aucune écriture en base' })
  declare dryRun: boolean

  @flags.string({ description: 'Fichier JSON local, au format geo.api.gouv.fr' })
  declare file: string

  @flags.string({ description: 'URL du référentiel (défaut : geo.api.gouv.fr/communes)' })
  declare url: string

  async run() {
    const source: CommunesSource = this.file
      ? { fetchAll: async () => JSON.parse(await readFile(this.file, 'utf8')) as RawCommune[] }
      : new HttpCommunesSource(this.url || undefined)

    this.logger.info(`Import du référentiel communal${this.dryRun ? ' — MODE SIMULATION' : ''} …`)

    const result = await new CogImporter(source).run({ dryRun: this.dryRun })

    this.logger.success(
      `${result.read} communes lues, ${result.upserted} enregistrées, ` +
        `${result.outOfScope} hors périmètre (COM non couvertes, §2.7), ` +
        `${result.skipped} ignorées (données incomplètes).`
    )
    this.logger.info(
      `${result.withoutDvf} communes marquées hors couverture DVF ` +
        '(Livre foncier : 57, 67, 68 — et Mayotte : 976).'
    )

    if (this.dryRun) {
      this.logger.warning('MODE SIMULATION : aucune écriture n’a été effectuée.')
    }
  }
}
