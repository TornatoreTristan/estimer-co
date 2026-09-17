import type { HttpContext } from '@adonisjs/core/http'

import { validateAuteurCreatePayload } from '#validators/blog_auteur'
import { assertIdempotencyKeyPresent } from '#validators/blog_common'
import { getBlogServices } from '#services/blog/service_registry'
import { BlogOrchestratorService } from '#services/blog/orchestrator_service'

/** `/v1/blog/auteurs` (D1/D2). */
export default class AuteursController {
  async index(ctx: HttpContext) {
    const { git, pr } = getBlogServices()
    const orchestrator = new BlogOrchestratorService(git, pr)
    const auteurs = await orchestrator.listAuteurs()
    return ctx.response.ok({ auteurs })
  }

  async store(ctx: HttpContext) {
    const { request, response } = ctx
    assertIdempotencyKeyPresent(request.header('idempotency-key'))
    const payload = await validateAuteurCreatePayload(request.body())

    const { git, pr } = getBlogServices()
    const orchestrator = new BlogOrchestratorService(git, pr)
    const result = await orchestrator.createAuteur({
      clientId: ctx.blogClient.id,
      idempotencyKey: request.header('idempotency-key')!,
      payload,
    })

    return response.status(result.status).send(result.body)
  }
}
