import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * Millésime courant des données — Annexe A.8.
 *
 * Source unique des mentions légales du §8.1 et clé de cache globale. La date
 * affichée par le front provient TOUJOURS d'ici (US-9 : « jamais d'une valeur
 * écrite en dur »).
 */
export default class DatasetVersion extends BaseModel {
  static table = 'dataset_versions'

  @column({ isPrimary: true })
  declare id: number

  /** Ex. « dvf-2025-10 ». */
  @column()
  declare datasetVersion: string

  @column.dateTime()
  declare publishedAt: DateTime | null

  /** Sérialisé tel quel dans le DTO : nom, URL, licence, millésime. */
  @column()
  declare sources: Array<Record<string, unknown>>

  /** Un seul millésime courant, garanti par un index unique partiel. */
  @column()
  declare isCurrent: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
