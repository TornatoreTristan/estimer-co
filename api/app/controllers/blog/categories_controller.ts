import type { HttpContext } from '@adonisjs/core/http'

import { getBlogServices } from '#services/blog/service_registry'
import { BlogOrchestratorService } from '#services/blog/orchestrator_service'

/** `/v1/blog/categories` (E1) — source unique : `src/lib/blog.ts` de la copie de travail. */
export default class CategoriesController {
  async index(ctx: HttpContext) {
    const { git, pr } = getBlogServices()
    const orchestrator = new BlogOrchestratorService(git, pr)
    const categories = await orchestrator.listCategories()
    return ctx.response.ok({ categories })
  }
}
