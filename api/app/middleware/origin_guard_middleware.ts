import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import app from '@adonisjs/core/services/app'
import { allowedOrigins, isOriginAllowed } from '#config/origins'

/**
 * Vérification d'`Origin` en production — spec §2.6, point 3.
 *
 * Requête sans `Origin` ou dont l'`Origin` est hors liste → 403
 * `FORBIDDEN_ORIGIN`.
 *
 * Honnêteté sur ce que cela protège : **ce n'est pas une protection forte**.
 * L'en-tête `Origin` se forge en une option de cURL. Le but est d'éliminer le
 * bruit et les intégrations sauvages d'un site tiers qui embarquerait notre
 * endpoint, pas de bloquer un attaquant déterminé — ce rôle revient au rate
 * limiting (§2.6) et à l'absence totale de PII sur l'API.
 *
 * Le garde est **inactif hors production** afin de ne pas gêner les tests
 * fonctionnels, les sondes et les appels en ligne de commande pendant le
 * développement.
 */
export default class OriginGuardMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (!app.inProduction) {
      return next()
    }

    if (!isOriginAllowed(ctx.request.header('origin'), allowedOrigins())) {
      return ctx.response.forbidden({
        code: 'FORBIDDEN_ORIGIN',
        message: 'Origine non autorisée pour cette API.',
      })
    }

    return next()
  }
}
