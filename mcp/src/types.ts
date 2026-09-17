/**
 * Contrat REST de `/v1/blog/**` (specs/blog-automatisation-ia.md §4), tel
 * qu'implémenté par `api/app/controllers/blog/*` et
 * `api/app/services/blog/orchestrator_service.ts`. Ce fichier ne fait que
 * DÉCRIRE le contrat côté client — aucune règle métier n'y est reproduite.
 */

/** Image encodée en base64, envoyée telle quelle à l'API (C1). */
export interface ImageInput {
  /** Contenu de l'image, encodé en base64. */
  data: string
  /** Déclaratif seulement : le format réel est revérifié par signature binaire côté API. */
  mimeType: string
}

export interface FaqEntry {
  question: string
  reponse: string
}

/** Payload de `POST /v1/blog/articles` (création et mise à jour, B1/B2). */
export interface ArticleUpsertInput {
  slug?: string
  categorie: string
  title: string
  metaTitle?: string
  metaDescription?: string
  extrait?: string
  contenu: string
  image?: ImageInput
  imageAlt?: string
  imageCadrage?: number
  auteur?: string
  faq?: FaqEntry[]
  motsClesCibles?: string[]
  articlesLies?: string[]
  datePublication?: string
  ordreAffichage?: number
}

export interface JobRef {
  id: string
  status: string
}

/** Réponse 201/200 de `POST /v1/blog/articles`. */
export interface ArticleUpsertResponse {
  slug: string
  statut: string
  job: JobRef
  prUrl: string
}

/** PR GitHub associée à une branche `blog-ia/<slug>` (forme renvoyée par `PrService`). */
export interface PullRequestRef {
  number: number
  url: string
  merged?: boolean
  state?: string
  [key: string]: unknown
}

/** Frontmatter de l'article (forme libre : recopie le frontmatter Markdown) + son corps. */
export interface ArticleData {
  [key: string]: unknown
  contenu: string
}

/** Réponse de `GET /v1/blog/articles/:slug`. */
export interface GetArticleResponse {
  existsOnMain: boolean
  data?: ArticleData
  openPr?: PullRequestRef
}

/** Réponse 200 de `POST /v1/blog/articles/:slug/publish`. */
export interface PublishArticleResponse {
  slug: string
  statut: 'publie'
  job: JobRef
  prUrl: string
}

export interface AuteurSummary {
  id: string
  nom: string
  fonction: string
  photo?: string
}

/** Réponse de `GET /v1/blog/auteurs`. */
export interface ListAuteursResponse {
  auteurs: AuteurSummary[]
}

export interface AuteurLien {
  type: 'linkedin' | 'x' | 'site' | 'email'
  url: string
  texte: string
  libelle: string
}

/** Payload de `POST /v1/blog/auteurs` (D2). */
export interface AuteurCreateInput {
  id?: string
  nom: string
  fonction: string
  bio: string
  photo?: ImageInput
  liens?: AuteurLien[]
}

/** Réponse 201 de `POST /v1/blog/auteurs`. */
export interface AuteurCreateResponse {
  id: string
  job: JobRef
  prUrl: string
}

export interface CategorySummary {
  slug: string
  label: string
}

/** Réponse de `GET /v1/blog/categories`. */
export interface ListCategoriesResponse {
  categories: CategorySummary[]
}

/** États d'un `blog_job` (G2, `api/app/models/blog_job.ts`). */
export type BlogJobStatus =
  | 'pending'
  | 'validating'
  | 'failed'
  | 'pushed'
  | 'pr_open'
  | 'pr_merged'
  | 'pr_closed'

export interface ValidationIssue {
  level: 'error' | 'warning'
  file: string
  field: string
  message: string
}

/** Réponse de `GET /v1/blog/jobs/:id`. */
export interface JobStatusResponse {
  id: string
  slug: string
  action: string
  status: BlogJobStatus
  prUrl?: string
  validationErrors?: ValidationIssue[]
  validationWarnings?: ValidationIssue[]
  errorMessage?: string
  updatedAt: string
}
