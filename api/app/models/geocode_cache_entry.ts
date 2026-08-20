import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * Entrée du cache de géocodage — spec §3.1, §5.1.
 *
 * RGPD (§8.3) : contient des adresses. TTL 90 jours, purge automatique, à
 * inscrire au registre des traitements.
 */
export default class GeocodeCacheEntry extends BaseModel {
  static table = 'geocode_cache'
  static primaryKey = 'queryHash'
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare queryHash: string

  @column()
  declare query: string

  @column()
  declare label: string | null

  @column()
  declare codeInsee: string | null

  @column()
  declare city: string | null

  @column()
  declare postcode: string | null

  @column()
  declare longitude: number | null

  @column()
  declare latitude: number | null

  @column()
  declare score: number | null

  @column()
  declare resultType: string | null

  @column()
  declare precision: 'exact' | 'approximate' | 'city-centroid' | null

  @column()
  declare provider: string

  @column.dateTime({ autoCreate: true })
  declare fetchedAt: DateTime

  @column.dateTime()
  declare expiresAt: DateTime
}
