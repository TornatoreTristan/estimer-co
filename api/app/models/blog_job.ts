import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export const BLOG_JOB_ACTIONS = ['article_upsert', 'article_publish', 'auteur_create'] as const
export type BlogJobAction = (typeof BLOG_JOB_ACTIONS)[number]

/**
 * États d'un `blog_job` (G2 §3) :
 *  - `pending`     : job créé, verrou de slug obtenu, écriture pas encore lancée ;
 *  - `validating`  : `scripts/validate-content.mjs --json` en cours/terminé ;
 *  - `failed`      : validation en échec (voir `validationErrors`) ou erreur
 *                     inattendue (voir `errorMessage`) — rien n'a été poussé ;
 *  - `pushed`      : commit poussé sur la branche `blog-ia/<slug>` ;
 *  - `pr_open`     : PR ouverte ou mise à jour sur GitHub ;
 *  - `pr_merged` / `pr_closed` : relevés a posteriori sur `GET /jobs/:id`
 *     (G2 : « si pr_open, l'état de la PR est relu sur GitHub »).
 */
export const BLOG_JOB_STATUSES = [
  'pending',
  'validating',
  'failed',
  'pushed',
  'pr_open',
  'pr_merged',
  'pr_closed',
] as const
export type BlogJobStatus = (typeof BLOG_JOB_STATUSES)[number]

export interface ValidationIssue {
  level: 'error' | 'warning'
  file: string
  field: string
  message: string
}

/**
 * Une opération d'écriture Git demandée par l'IA (specs/blog-automatisation-ia.md
 * §5). `idempotencyKey` + `payloadHash` portent l'idempotence (B3) ; `response`
 * rejoue le corps HTTP d'origine tel quel sur un retry.
 */
export default class BlogJob extends BaseModel {
  static table = 'blog_jobs'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare clientId: string

  @column()
  declare idempotencyKey: string

  @column()
  declare action: BlogJobAction

  @column()
  declare slug: string

  @column()
  declare branch: string

  @column()
  declare status: BlogJobStatus

  @column()
  declare prNumber: number | null

  @column()
  declare prUrl: string | null

  @column()
  declare payloadHash: string

  // `prepare` sérialise explicitement en JSON avant l'écriture (colonnes
  // `jsonb`) : la lecture n'a pas besoin de son pendant `consume`, le driver
  // `pg` parse déjà lui-même les colonnes jsonb en objets JS.
  @column({
    prepare: (value: Record<string, unknown> | null) =>
      value === null ? null : JSON.stringify(value),
  })
  declare response: Record<string, unknown> | null

  @column({
    prepare: (value: ValidationIssue[] | null) => (value === null ? null : JSON.stringify(value)),
  })
  declare validationErrors: ValidationIssue[] | null

  @column({
    prepare: (value: ValidationIssue[] | null) => (value === null ? null : JSON.stringify(value)),
  })
  declare validationWarnings: ValidationIssue[] | null

  @column()
  declare errorMessage: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
