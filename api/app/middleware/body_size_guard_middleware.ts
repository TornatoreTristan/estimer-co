import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

import { evaluateBodySizeGuard } from '#lib/body_size_guard'
import { BlogUnauthorizedError } from '#exceptions/blog_errors'

/**
 * Enregistré dans `server.use([...])` (`start/kernel.ts`), donc AVANT
 * `router.use([bodyparser_middleware])` : c'est ce qui garantit qu'il
 * s'exécute avant toute lecture du corps de la requête.
 *
 * Toute la logique de décision est dans `app/lib/body_size_guard.ts`
 * (fonction pure, testée sans requête HTTP) — voir son commentaire de tête
 * pour le détail complet (spec revue QA, critique C1).
 */
export default class BodySizeGuardMiddleware {
  async handle({ request, response }: HttpContext, next: NextFn) {
    const decision = evaluateBodySizeGuard({
      method: request.method(),
      pathname: request.url(),
      hasBody: request.hasBody(),
      contentLength: request.header('content-length'),
      authorizationHeader: request.header('authorization'),
    })

    switch (decision.action) {
      case 'continue':
        return next()
      case 'blog_unauthorized':
        // Même corps que `BlogAuthMiddleware` (401 { error: "unauthorized" })
        // — un appelant ne doit pas voir deux formes différentes du même 401
        // selon qu'il a été arrêté ici ou plus loin.
        throw new BlogUnauthorizedError()
      case 'reject':
        return response
          .status(decision.status)
          .send({ code: decision.code, message: decision.message })
    }
  }
}
