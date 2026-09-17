import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/** Scopes reconnus par `BlogAuthMiddleware` (specs/blog-automatisation-ia.md §5). */
export const BLOG_SCOPES = ['articles:write', 'publish:request', 'auteurs:write'] as const
export type BlogScope = (typeof BLOG_SCOPES)[number]

/**
 * Client autorisé à appeler `/v1/blog/**` (US A1). Un jeton en clair n'est
 * jamais stocké : `tokenHash` est comparé à l'empreinte SHA-256 du jeton
 * présenté (voir `BlogAuthMiddleware`).
 */
export default class BlogApiClient extends BaseModel {
  static table = 'blog_api_clients'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare name: string

  @column()
  declare tokenHash: string

  @column()
  declare scopes: string[]

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime()
  declare revokedAt: DateTime | null

  /** Un jeton révoqué n'authentifie plus jamais (US A1 : « révocable »). */
  get isRevoked(): boolean {
    return this.revokedAt !== null
  }

  hasScope(scope: BlogScope): boolean {
    return this.scopes.includes(scope)
  }
}
