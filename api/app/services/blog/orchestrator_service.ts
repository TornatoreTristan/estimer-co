import { DateTime } from 'luxon'
import { errors as vineErrors } from '@vinejs/vine'

import BlogJob, { type BlogJobAction, type ValidationIssue } from '#models/blog_job'
import { BlogAdvisoryLock } from '#services/blog/advisory_lock'
import { blogWorkdirMutex } from '#services/blog/workdir_mutex'
import { GitService } from '#services/blog/git_service'
import type { PrService } from '#services/blog/pr_service'
import { hashPayload } from '#services/blog/hash'
import { isValidSlug, slugify } from '#services/blog/slug'
import { buildAuteurJson, buildMarkdownFile, parseMarkdownFile } from '#services/blog/markdown'
import { isKnownCategory, readCategories } from '#services/blog/categories_service'
import { processImage } from '#services/blog/image_service'
import { runValidateContent } from '#services/blog/validate_service'
import type { ArticleUpsertPayload } from '#validators/blog_article'
import type { AuteurCreatePayload } from '#validators/blog_auteur'
import {
  BlogConflictError,
  BlogIdempotencyKeyReusedError,
  BlogNotFoundError,
  BlogOperationInProgressError,
  BlogValidationFailedError,
} from '#exceptions/blog_errors'

/**
 * Orchestration métier du module blog (specs/blog-automatisation-ia.md,
 * Lots 1-3) : c'est ici, et UNIQUEMENT ici, que se croisent la base
 * (idempotence, verrou), Git (copie de travail, branches) et GitHub (PR).
 *
 * Convention volontaire : `git`/`pr` sont des paramètres de CHAQUE méthode
 * publique (pas du constructeur) — les contrôleurs les obtiennent de
 * `getBlogServices()` (réel en production, remplacé en test), cette classe
 * elle-même reste sans état et sans dépendance à l'environnement.
 */
export class BlogOrchestratorService {
  constructor(
    private readonly git: GitService,
    private readonly pr: PrService
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // B1/B2/B3 — POST /v1/blog/articles
  // ────────────────────────────────────────────────────────────────────────

  async upsertArticle(input: {
    clientId: string
    idempotencyKey: string
    payload: ArticleUpsertPayload
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    const slug = input.payload.slug ?? slugify(input.payload.title)
    if (!isValidSlug(slug)) {
      throw new vineErrors.E_VALIDATION_ERROR([
        {
          field: 'slug',
          rule: 'regex',
          message: 'slug attendu en kebab-case ASCII sans accents (^[a-z0-9-]+$).',
        },
      ])
    }
    const branch = GitService.articleBranch(slug)

    return this.#runIdempotentOperation({
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      action: 'article_upsert',
      slug,
      branch,
      payloadForHash: input.payload,
      execute: (job) => this.#executeUpsertArticle(job, slug, branch, input.payload),
    })
  }

  async #executeUpsertArticle(
    job: BlogJob,
    slug: string,
    branch: string,
    payload: ArticleUpsertPayload
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    await this.git.ensureWorkdir()
    await this.git.fetchAll()

    // E2 : catégorie hors enum → 422, RIEN écrit, AUCUNE branche créée (B4).
    // Vérifié avant tout `prepareBranch` : cette étape ne modifie pas le HEAD.
    if (!(await isKnownCategory(this.git.workdir, payload.categorie))) {
      const categories = await readCategories(this.git.workdir)
      throw new vineErrors.E_VALIDATION_ERROR([
        {
          field: 'categorie',
          rule: 'enum',
          message: `catégorie inconnue — valeurs autorisées : ${categories.map((c) => c.slug).join(', ')}.`,
        },
      ])
    }

    // D2/D3 : un auteur explicite doit être connu (sur main OU sur une
    // branche `blog-ia/auteur-<id>` ouverte) — vérifié SANS changer de
    // branche (`readFileAtRef`/`remoteBranchExists`), pour ne pas perturber
    // la préparation de la branche article ci-dessous.
    if (payload.auteur && !(await this.#isAuteurKnown(payload.auteur))) {
      throw new vineErrors.E_VALIDATION_ERROR([
        {
          field: 'auteur',
          rule: 'unknown_auteur',
          message: `auteur "${payload.auteur}" inconnu — créez-le via POST /v1/blog/auteurs.`,
        },
      ])
    }

    await this.git.prepareBranch(branch)
    const articlePath = `src/content/articles/${slug}.md`
    const existingRaw = this.git.readTextFile(articlePath)
    const existing = existingRaw ? parseMarkdownFile(existingRaw) : null

    const frontmatter: Record<string, unknown> = {
      ...existing?.data,
      slug,
      categorie: payload.categorie,
      title: payload.title,
      metaTitle: payload.metaTitle ?? existing?.data.metaTitle,
      metaDescription: payload.metaDescription ?? existing?.data.metaDescription,
      extrait: payload.extrait ?? existing?.data.extrait,
      auteur: payload.auteur ?? existing?.data.auteur,
      faq: payload.faq ?? existing?.data.faq,
      motsClesCibles: payload.motsClesCibles ?? existing?.data.motsClesCibles,
      articlesLies: payload.articlesLies ?? existing?.data.articlesLies,
      datePublication: payload.datePublication ?? existing?.data.datePublication,
      ordreAffichage: payload.ordreAffichage ?? existing?.data.ordreAffichage,
      // §4 : jamais accepté en entrée. Un nouvel article naît en brouillon ;
      // une mise à jour GARDE son statut actuel — seul `/publish` le change.
      statut: existing?.data.statut ?? 'brouillon',
    }

    if (payload.image) {
      let webp: Buffer
      try {
        const processed = await processImage(payload.image.data)
        webp = processed.buffer
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Image invalide.'
        throw new vineErrors.E_VALIDATION_ERROR([
          { field: 'image', rule: 'invalid_image', message },
        ])
      }
      this.git.writeBinaryFile(`public/images/blog/${slug}.webp`, webp)
      frontmatter.image = `/images/blog/${slug}.webp`
      frontmatter.imageAlt = payload.imageAlt
      if (payload.imageCadrage !== undefined) frontmatter.imageCadrage = payload.imageCadrage
    }

    this.git.writeTextFile(articlePath, buildMarkdownFile(frontmatter, payload.contenu))

    const fileExistedBefore = existingRaw !== null
    const httpStatus = fileExistedBefore ? 200 : 201

    const prTitle = `Article : ${payload.title}`
    const prBody = `Généré automatiquement par l'agent IA du blog.\n\nSlug : \`${slug}\`.`
    const commitMessage = `${fileExistedBefore ? 'Met à jour' : 'Crée'} l'article ${slug}`

    const { prUrl, jobStatus } = await this.#validateCommitPushAndOpenPr({
      job,
      branch,
      commitMessage,
      prTitle,
      prBody,
      // Revue QA, majeur 3 : même garde que `#executePublishArticle` — une
      // gate refusée ne doit jamais laisser la copie de travail partagée
      // (`blogWorkdirMutex`) avec le fichier/l'image déjà écrits dessus.
      onValidationFailure: () => this.git.resetWorkingTree(),
    })

    return {
      status: httpStatus,
      body: {
        slug,
        statut: frontmatter.statut,
        job: { id: job.id, status: jobStatus },
        prUrl,
      },
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // GET /v1/blog/articles/:slug
  // ────────────────────────────────────────────────────────────────────────

  async getArticle(slug: string): Promise<Record<string, unknown>> {
    if (!isValidSlug(slug)) {
      throw new BlogNotFoundError()
    }

    return blogWorkdirMutex.run(async () => {
      await this.git.ensureWorkdir()
      await this.git.prepareBranch('main')

      const articlePath = `src/content/articles/${slug}.md`
      const raw = this.git.readTextFile(articlePath)
      const branch = GitService.articleBranch(slug)
      const openPrOnBranch = await this.git.remoteBranchExists(branch)

      const result: Record<string, unknown> = { existsOnMain: raw !== null }
      if (raw !== null) {
        const parsed = parseMarkdownFile(raw)
        result.data = { ...parsed.data, contenu: parsed.body }
      }
      if (openPrOnBranch) {
        const openPr = await this.pr.findOpenPr(branch)
        if (openPr) result.openPr = openPr
      }
      return result
    })
  }

  // ────────────────────────────────────────────────────────────────────────
  // F — POST /v1/blog/articles/:slug/publish
  // ────────────────────────────────────────────────────────────────────────

  async publishArticle(input: {
    clientId: string
    idempotencyKey: string
    slug: string
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!isValidSlug(input.slug)) {
      throw new BlogNotFoundError('Article introuvable.')
    }
    const branch = GitService.articleBranch(input.slug)

    return this.#runIdempotentOperation({
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      action: 'article_publish',
      slug: input.slug,
      branch,
      payloadForHash: { action: 'publish', slug: input.slug },
      execute: (job) => this.#executePublishArticle(job, input.slug, branch),
    })
  }

  async #executePublishArticle(
    job: BlogJob,
    slug: string,
    branch: string
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    await this.git.ensureWorkdir()
    await this.git.fetchAll()
    await this.git.prepareBranch(branch)

    const articlePath = `src/content/articles/${slug}.md`
    const raw = this.git.readTextFile(articlePath)
    if (raw === null) {
      throw new BlogNotFoundError('Article introuvable.')
    }

    const parsed = parseMarkdownFile(raw)
    const frontmatter: Record<string, unknown> = {
      ...parsed.data,
      statut: 'publie',
      dateMiseAJour: DateTime.now().toISODate(),
    }
    this.git.writeTextFile(articlePath, buildMarkdownFile(frontmatter, parsed.body))

    const { prUrl, jobStatus } = await this.#validateCommitPushAndOpenPr({
      job,
      branch,
      commitMessage: `Publie l'article ${slug}`,
      prTitle: `Article : ${String(frontmatter.title ?? slug)}`,
      prBody: `Demande de publication automatique par l'agent IA du blog.\n\nSlug : \`${slug}\`.`,
      // F2 : gate refusée → le fichier revient à son état d'origine (`statut: brouillon`).
      onValidationFailure: () => this.git.resetWorkingTree(),
    })

    return {
      status: 200,
      body: { slug, statut: 'publie', job: { id: job.id, status: jobStatus }, prUrl },
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // E — GET /v1/blog/categories
  // ────────────────────────────────────────────────────────────────────────

  async listCategories(): Promise<Array<{ slug: string; label: string }>> {
    return blogWorkdirMutex.run(async () => {
      await this.git.ensureWorkdir()
      await this.git.prepareBranch('main')
      const categories = await readCategories(this.git.workdir)
      return categories.map((category) => ({ slug: category.slug, label: category.label }))
    })
  }

  // ────────────────────────────────────────────────────────────────────────
  // D — auteurs
  // ────────────────────────────────────────────────────────────────────────

  async listAuteurs(): Promise<
    Array<{ id: string; nom: string; fonction: string; photo?: string }>
  > {
    return blogWorkdirMutex.run(async () => {
      await this.git.ensureWorkdir()
      await this.git.prepareBranch('main')

      const dir = `src/content/auteurs`
      const fs = await import('node:fs')
      const path = await import('node:path')
      const fullDir = path.join(this.git.workdir, dir)
      if (!fs.existsSync(fullDir)) return []

      return fs
        .readdirSync(fullDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const id = name.slice(0, -'.json'.length)
          const fiche = JSON.parse(fs.readFileSync(path.join(fullDir, name), 'utf8')) as {
            nom: string
            fonction: string
            photo?: string
          }
          return { id, nom: fiche.nom, fonction: fiche.fonction, photo: fiche.photo }
        })
    })
  }

  async createAuteur(input: {
    clientId: string
    idempotencyKey: string
    payload: AuteurCreatePayload
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    const id = input.payload.id ?? slugify(input.payload.nom)
    if (!isValidSlug(id)) {
      throw new vineErrors.E_VALIDATION_ERROR([
        {
          field: 'id',
          rule: 'regex',
          message: 'id attendu en kebab-case ASCII sans accents (^[a-z0-9-]+$).',
        },
      ])
    }
    const branch = GitService.auteurBranch(id)

    return this.#runIdempotentOperation({
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      action: 'auteur_create',
      slug: id,
      branch,
      payloadForHash: input.payload,
      execute: (job) => this.#executeCreateAuteur(job, id, branch, input.payload),
    })
  }

  async #executeCreateAuteur(
    job: BlogJob,
    id: string,
    branch: string,
    payload: AuteurCreatePayload
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    await this.git.ensureWorkdir()
    await this.git.fetchAll()

    if (await this.#isAuteurKnown(id)) {
      throw new BlogConflictError(`Un auteur "${id}" existe déjà.`)
    }

    await this.git.prepareBranch(branch)

    const fiche: Record<string, unknown> = {
      nom: payload.nom,
      fonction: payload.fonction,
      bio: payload.bio,
      initiales: deriveInitiales(payload.nom),
      liens: payload.liens ?? [],
    }

    if (payload.photo) {
      let webp: Buffer
      try {
        const processed = await processImage(payload.photo.data)
        webp = processed.buffer
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Image invalide.'
        throw new vineErrors.E_VALIDATION_ERROR([
          { field: 'photo', rule: 'invalid_image', message },
        ])
      }
      this.git.writeBinaryFile(`public/auteurs/${id}.webp`, webp)
      fiche.photo = `/auteurs/${id}.webp`
    }

    this.git.writeTextFile(`src/content/auteurs/${id}.json`, buildAuteurJson(fiche))

    // Pas de gate ici : `scripts/validate-content.mjs` ne couvre que les
    // collections de contenu (`src/content/{regions,departements,partenaires,
    // pages,articles}`), jamais `src/content/auteurs/` — voir sa fonction
    // `readEntries`. La forme (bio ≥ 50 caractères, etc.) est déjà garantie
    // par `app/validators/blog_auteur.ts`.
    job.status = 'pushed'
    await job.save()
    await this.git.commit(`Crée l'auteur ${id}`)
    await this.git.push(branch)

    const pr = await this.#findOrCreatePr(
      branch,
      `Nouvel auteur : ${payload.nom}`,
      `Nouvelle fiche auteur \`${id}\`.`
    )
    job.status = 'pr_open'
    job.prNumber = pr.number
    job.prUrl = pr.url
    await job.save()

    return { status: 201, body: { id, job: { id: job.id, status: job.status }, prUrl: pr.url } }
  }

  // ────────────────────────────────────────────────────────────────────────
  // G — GET /v1/blog/jobs/:id
  // ────────────────────────────────────────────────────────────────────────

  /**
   * G2 : « si `pr_open`, l'état de la PR est relu sur GitHub pour détecter
   * merged/closed ». `clientId` restreint la visibilité au client qui a créé
   * le job (§4 : « un job n'est visible que par le client qui l'a créé »).
   */
  async getJob(id: string, clientId: string): Promise<Record<string, unknown>> {
    const job = await BlogJob.query().where('id', id).andWhere('clientId', clientId).first()
    if (!job) {
      throw new BlogNotFoundError()
    }

    if (job.status === 'pr_open' && job.prNumber !== null) {
      const pr = await this.pr.getPr(job.prNumber)
      if (pr.merged) {
        job.status = 'pr_merged'
        await job.save()
      } else if (pr.state === 'closed') {
        job.status = 'pr_closed'
        await job.save()
      }
    }

    return {
      id: job.id,
      slug: job.slug,
      action: job.action,
      status: job.status,
      prUrl: job.prUrl ?? undefined,
      validationErrors: job.validationErrors ?? undefined,
      validationWarnings: job.validationWarnings ?? undefined,
      errorMessage: job.errorMessage ?? undefined,
      updatedAt: job.updatedAt.toISO(),
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Helpers partagés
  // ────────────────────────────────────────────────────────────────────────

  /** Un auteur est « connu » s'il existe sur `main`, ou sur une branche `blog-ia/auteur-<id>` ouverte (D2). */
  async #isAuteurKnown(id: string): Promise<boolean> {
    const onMain = await this.git.readFileAtRef('origin/main', `src/content/auteurs/${id}.json`)
    if (onMain !== null) return true
    return this.git.remoteBranchExists(GitService.auteurBranch(id))
  }

  async #findOrCreatePr(
    branch: string,
    title: string,
    body: string
  ): Promise<{ number: number; url: string }> {
    const existing = await this.pr.findOpenPr(branch)
    if (existing) return existing
    return this.pr.createPr({ branch, base: 'main', title, body })
  }

  /**
   * Étapes communes à toute écriture d'article : validation via le script
   * réel, commit, push, ouverture/mise à jour de la PR — jamais de merge
   * (F3/A3). Centralisé ici pour que `upsertArticle` et `publishArticle`
   * n'en réécrivent pas chacun une variante.
   */
  async #validateCommitPushAndOpenPr(params: {
    job: BlogJob
    branch: string
    commitMessage: string
    prTitle: string
    prBody: string
    onValidationFailure?: () => Promise<void>
  }): Promise<{ prUrl: string; jobStatus: BlogJob['status'] }> {
    params.job.status = 'validating'
    await params.job.save()

    const report = await runValidateContent(this.git.workdir)
    if (report.errors.length > 0) {
      if (params.onValidationFailure) await params.onValidationFailure()
      throw new BlogValidationFailedError(report.errors, report.warnings)
    }

    await this.git.commit(params.commitMessage)
    params.job.status = 'pushed'
    await params.job.save()
    await this.git.push(params.branch)

    const pr = await this.#findOrCreatePr(params.branch, params.prTitle, params.prBody)
    params.job.status = 'pr_open'
    params.job.prNumber = pr.number
    params.job.prUrl = pr.url
    await params.job.save()

    return { prUrl: pr.url, jobStatus: params.job.status }
  }

  /**
   * Cadre commun d'idempotence + verrouillage (B3, G2) :
   *  1. rejeu à l'identique (même clé, même payload) → 200, réponse d'origine ;
   *  2. même clé, payload différent → 422 `idempotency_key_reused` ;
   *  3. verrou de slug déjà détenu → 409 `operation_in_progress` ;
   *  4. sinon, crée le `blog_job` et exécute `execute` sous le verrou global
   *     de la copie de travail partagée (`blogWorkdirMutex`).
   */
  async #runIdempotentOperation(params: {
    clientId: string
    idempotencyKey: string
    action: BlogJobAction
    slug: string
    branch: string
    payloadForHash: unknown
    execute: (job: BlogJob) => Promise<{ status: number; body: Record<string, unknown> }>
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    const payloadHash = hashPayload(params.payloadForHash)

    const existingJob = await BlogJob.query()
      .where('clientId', params.clientId)
      .andWhere('idempotencyKey', params.idempotencyKey)
      .first()

    if (existingJob) {
      if (existingJob.payloadHash !== payloadHash) {
        throw new BlogIdempotencyKeyReusedError()
      }
      return { status: 200, body: (existingJob.response ?? {}) as Record<string, unknown> }
    }

    const lock = new BlogAdvisoryLock()
    const acquired = await lock.tryAcquire(`blog:${params.slug}`)
    if (!acquired) {
      const inProgress = await BlogJob.query()
        .where('slug', params.slug)
        .whereIn('status', ['pending', 'validating'])
        .orderBy('createdAt', 'desc')
        .first()
      throw new BlogOperationInProgressError(inProgress?.id ?? null)
    }

    let job: BlogJob | null = null
    try {
      job = await BlogJob.create({
        clientId: params.clientId,
        idempotencyKey: params.idempotencyKey,
        action: params.action,
        slug: params.slug,
        branch: params.branch,
        status: 'pending',
        payloadHash,
      })

      const result = await blogWorkdirMutex.run(() => params.execute(job as BlogJob))
      job.response = result.body
      await job.save()
      return result
    } catch (error) {
      if (job) {
        job.status = 'failed'
        if (error instanceof BlogValidationFailedError) {
          job.validationErrors = error.body.errors as ValidationIssue[]
          job.validationWarnings = error.body.warnings as ValidationIssue[]
        } else {
          job.errorMessage = error instanceof Error ? error.message : String(error)
        }
        await job.save()
      }
      throw error
    } finally {
      await lock.release()
    }
  }
}

/** Initiales dérivées du nom (D2 : jamais fournies par l'appelant, cf. `Auteur.initiales`). */
export function deriveInitiales(nom: string): string {
  const letters = nom
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() ?? '')
  if (letters.length === 0) return '??'
  if (letters.length === 1) return letters[0].repeat(2).slice(0, 2)
  return `${letters[0]}${letters[letters.length - 1]}`
}
