import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * Trace d'UNE exécution de commande d'ingestion — Annexe A.8.
 *
 * `progression` liste les départements déjà traités : c'est ce qui rendra
 * `--resume` possible sans transaction géante.
 */
export default class IngestionRun extends BaseModel {
  static table = 'ingestion_runs'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare source: string

  @column()
  declare millesime: number | null

  @column()
  declare fichierUrl: string | null

  @column()
  declare checksumSha256: string | null

  @column()
  declare statut: 'running' | 'success' | 'failed' | 'partial' | 'dry-run'

  @column()
  declare rowsRead: number

  @column()
  declare rowsInserted: number

  @column()
  declare rowsUpdated: number

  @column()
  declare rowsRejected: number

  /** Total des lignes marquées `stale_reimport` sur l'exécution (A.2). */
  @column()
  declare rowsStaleMarked: number

  @column()
  declare rejets: Record<string, number>

  @column()
  declare progression: { planned?: string[]; done?: string[] }

  @column()
  declare datasetVersion: string | null

  @column()
  declare error: string | null

  @column.dateTime({ autoCreate: true })
  declare startedAt: DateTime

  @column.dateTime()
  declare finishedAt: DateTime | null
}
