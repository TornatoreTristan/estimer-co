import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * Plafond de taille de corps PAR ROUTE, plus serré que le seuil global.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Ce middleware NE PROTÈGE PLUS RIEN SEUL (revue QA, critique C1).
 * ══════════════════════════════════════════════════════════════════════════
 * Middleware NOMMÉ, posé route par route (`start/routes.ts`) : il s'exécute
 * donc APRÈS `router.use([bodyparser_middleware])` (`start/kernel.ts`), qui
 * lit et parse déjà le corps pour tout le trafic routé. La vraie protection —
 * avant lecture, sur toutes les routes par défaut — est
 * `BodySizeGuardMiddleware` (`app/middleware/body_size_guard_middleware.ts`),
 * enregistré dans `server.use([...])`, donc avant même le routage. Voir
 * `app/lib/body_size_guard.ts` pour le raisonnement complet.
 *
 * Ce middleware-ci reste néanmoins utile en COMPLÉMENT sur `/v1/estimations` :
 * `BodySizeGuardMiddleware` applique un seuil générique bien plus large
 * (`DEFAULT_MAX_BODY_BYTES`, dimensionné pour couvrir `/v1/leads`) — un corps
 * de, disons, 20 Ko passerait ce garde générique. `POST /v1/estimations`
 * reste un endpoint PUBLIC et NON authentifié (§2.6, point 2) qui ne doit
 * accepter qu'un corps de quelques centaines d'octets : ce middleware
 * applique cette limite plus précise, une fois le corps déjà lu (borné, dans
 * le pire cas, à `DEFAULT_MAX_BODY_BYTES` par le garde précédent — jamais aux
 * 15 Mo de la limite globale du bodyparser).
 */
export default class MaxBodySizeMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options: { bytes: number }) {
    const contentLength = ctx.request.header('content-length')
    if (contentLength && Number(contentLength) > options.bytes) {
      return ctx.response.status(413).send({
        code: 'PAYLOAD_TOO_LARGE',
        message: `Corps de requête trop volumineux (maximum ${options.bytes} octets).`,
      })
    }
    return next()
  }
}
