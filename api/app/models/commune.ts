import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * Référentiel communal INSEE — spec §5.1, §5.2.
 *
 * `has_dvf = false` pour 57, 67, 68 (Livre foncier alsacien-mosellan) et 976
 * (§1.3). C'est ce drapeau qui déclenche le repli documenté du §3.9 : jamais
 * un silence, jamais une fausse mention DVF.
 */
export default class Commune extends BaseModel {
  static table = 'communes'
  static primaryKey = 'codeInsee'
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare codeInsee: string

  @column()
  declare nom: string

  /** Minuscules sans accent : sert à la recherche floue (pg_trgm). */
  @column()
  declare nomNormalise: string

  @column()
  declare codesPostaux: string[]

  @column()
  declare codeDepartement: string

  @column()
  declare codeRegion: string

  @column()
  declare codeEpci: string | null

  @column()
  declare population: number | null

  /** Grille de densité INSEE, 1 à 7. */
  @column()
  declare densiteGrille: number | null

  @column()
  declare hasDvf: boolean

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  /*
   * `centroid` (geography) n'est volontairement pas exposé en colonne Lucid :
   * le type PostGIS ne se sérialise pas en JSON et n'a rien à faire dans un
   * modèle. Les lectures de coordonnées passent par du SQL brut qui projette
   * `ST_X`/`ST_Y` (§5.2).
   */
}
