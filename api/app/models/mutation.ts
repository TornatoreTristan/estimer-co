import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * Mutation DVF bâtie — spec §5.1, §5.2.
 *
 * **Ce modèle ne sert pas au chemin chaud.** Les requêtes de comparables
 * emploient des fonctions PostGIS (`ST_DWithin`, `ST_Distance`) qu'aucun ORM
 * n'exprime, et l'Annexe A.12 interdit à un modèle Lucid de franchir la
 * frontière SQL/calcul. `Mutation` est là pour le CRUD d'administration, les
 * vérifications d'ingestion et les tests.
 */
export default class Mutation extends BaseModel {
  static table = 'mutations'

  @column({ isPrimary: true })
  declare id: number

  /** sha256(id_mutation) — clé d'idempotence de l'upsert (Annexe A.1). */
  @column()
  declare dedupKey: string

  @column()
  declare idMutation: string

  @column.date()
  declare dateMutation: DateTime

  @column()
  declare natureMutation: string

  @column()
  declare valeurFonciere: number

  @column()
  declare typeLocal: 'appartement' | 'maison'

  /** Somme des surfaces des lots de même type, dépendances exclues (A.1). */
  @column()
  declare surfaceBati: number

  @column()
  declare nbPieces: number | null

  @column()
  declare surfaceTerrain: number | null

  /** Nombre de lots bâtis de même type regroupés. */
  @column()
  declare nbLocaux: number

  /** Dépendances vendues avec le bien (cave, garage, parking). */
  @column()
  declare nbDependances: number

  @column()
  declare codeInsee: string

  @column()
  declare codeDepartement: string

  /** Sans le numéro de voie — §8.3, vie privée. */
  @column()
  declare adresseVoie: string | null

  @column()
  declare codePostal: string | null

  @column()
  declare longitude: number

  @column()
  declare latitude: number

  /** Colonne générée STORED : jamais écrite par l'application. */
  @column()
  declare prixM2: number | null

  /** Annexe A.2 : marqué, jamais supprimé. */
  @column()
  declare isOutlier: boolean

  @column()
  declare exclusionReason: string | null

  @column()
  declare geolocSource: 'dvf' | 'ban' | 'parcelle' | 'commune_centroid'

  /** false ⇒ à exclure des niveaux au rayon (Annexe A.3). */
  @column()
  declare geolocFine: boolean

  @column()
  declare sourceAnnee: number

  @column.dateTime()
  declare importedAt: DateTime
}
