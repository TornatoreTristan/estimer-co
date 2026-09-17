import type { HttpContext } from '@adonisjs/core/http'

import { getBlogServices } from '#services/blog/service_registry'
import { BlogOrchestratorService } from '#services/blog/orchestrator_service'

/** `/v1/blog/jobs/:id` (G1/G2). */
export default class JobsController {
  async show(ctx: HttpContext) {
    const { git, pr } = getBlogServices()
    const orchestrator = new BlogOrchestratorService(git, pr)
    const job = await orchestrator.getJob(ctx.params.id, ctx.blogClient.id)
    return ctx.response.ok(job)
  }
}
