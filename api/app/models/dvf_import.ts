import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * Trace d'ingestion d'UN fichier DVF (année × département) — spec §5.1, US-7.
 *
 * `rejectedCounts` porte le décompte par motif : un import qui rejette une
 * proportion anormale de lignes doit pouvoir être diagnostiqué sans relire le
 * fichier source.
 */
export default class DvfImport extends BaseModel {
  static table = 'dvf_imports'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare sourceUrl: string

  @column()
  declare annee: number

  @column()
  declare codeDepartement: string

  @column()
  declare etag: string | null

  @column()
  declare sha256: string | null

  @column()
  declare rowsRead: number

  @column()
  declare rowsKept: number

  @column()
  declare rowsInserted: number

  @column()
  declare rowsUpdated: number

  /**
   * Lignes marquées `stale_reimport` par cet import (Annexe A.2) : présentes
   * dans le périmètre département × millésime, mais non réécrites par
   * l'upsert. Un non-zéro sur un ré-import de routine signale un changement
   * de règle d'ingestion.
   */
  @column()
  declare rowsStaleMarked: number

  /** Version des règles d'ingestion appliquées — cf. `DVF_RULES_VERSION`. */
  @column()
  declare rulesVersion: number

  @column()
  declare rejectedCounts: Record<string, number>

  @column()
  declare status: 'running' | 'success' | 'failed' | 'skipped' | 'dry-run'

  @column()
  declare error: string | null

  @column()
  declare runId: number | null

  @column.dateTime({ autoCreate: true })
  declare startedAt: DateTime

  @column.dateTime()
  declare finishedAt: DateTime | null
}
