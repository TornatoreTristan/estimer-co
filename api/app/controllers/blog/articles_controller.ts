import type { HttpContext } from '@adonisjs/core/http'

import { validateArticleUpsertPayload } from '#validators/blog_article'
import { assertIdempotencyKeyPresent } from '#validators/blog_common'
import { getBlogServices } from '#services/blog/service_registry'
import { BlogOrchestratorService } from '#services/blog/orchestrator_service'
import { isValidSlug } from '#services/blog/slug'
import { BlogNotFoundError } from '#exceptions/blog_errors'

/**
 * `/v1/blog/articles` (specs/blog-automatisation-ia.md §4, Lots 1 et 3).
 *
 * Contrôleur volontairement fin : toute la logique (Git, GitHub, validation,
 * idempotence, verrouillage) vit dans `BlogOrchestratorService`. Ce fichier
 * ne fait que valider la forme du payload et traduire le résultat en réponse
 * HTTP.
 */
export default class ArticlesController {
  async store(ctx: HttpContext) {
    const { request, response } = ctx
    assertIdempotencyKeyPresent(request.header('idempotency-key'))
    const payload = await validateArticleUpsertPayload(request.body())

    const { git, pr } = getBlogServices()
    const orchestrator = new BlogOrchestratorService(git, pr)
    const result = await orchestrator.upsertArticle({
      clientId: ctx.blogClient.id,
      idempotencyKey: request.header('idempotency-key')!,
      payload,
    })

    return response.status(result.status).send(result.body)
  }

  async show(ctx: HttpContext) {
    const { params, response } = ctx
    if (!isValidSlug(params.slug)) {
      throw new BlogNotFoundError()
    }

    const { git, pr } = getBlogServices()
    const orchestrator = new BlogOrchestratorService(git, pr)
    const result = await orchestrator.getArticle(params.slug)

    return response.ok(result)
  }

  async publish(ctx: HttpContext) {
    const { params, request, response } = ctx
    assertIdempotencyKeyPresent(request.header('idempotency-key'))

    const { git, pr } = getBlogServices()
    const orchestrator = new BlogOrchestratorService(git, pr)
    const result = await orchestrator.publishArticle({
      clientId: ctx.blogClient.id,
      idempotencyKey: request.header('idempotency-key')!,
      slug: params.slug,
    })

    return response.status(result.status).send(result.body)
  }
}
