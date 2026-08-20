import type { HttpContext } from '@adonisjs/core/http'
import { DataVersionService } from '#services/data_version_service'

/**
 * `GET /v1/meta/data-version` — spec §6.1.
 *
 * Consommé au build Astro (mention légale figée dans les pages statiques) et
 * au runtime par `/rapport`. Doit répondre 200 même base vide.
 */
export default class MetaController {
  async dataVersion({ response }: HttpContext) {
    const payload = await new DataVersionService().current()

    if (payload.datasetVersion) {
      response.header('X-Data-Version', payload.datasetVersion)
    }

    return response.ok(payload)
  }
}
