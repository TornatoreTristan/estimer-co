/*
|--------------------------------------------------------------------------
| HTTP kernel file
|--------------------------------------------------------------------------
|
| The HTTP kernel file is used to register the middleware with the server
| or the router.
|
*/

import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'
import logger from '@adonisjs/core/services/logger'

import env from '#start/env'
import { trustedProxyStartupWarning } from '#lib/client_ip'

/**
 * The error handler is used to convert an exception
 * to an HTTP response.
 */
server.errorHandler(() => import('#exceptions/handler'))

/*
 * Contrôle de configuration au démarrage — §2.6.
 *
 * Un `TRUSTED_PROXY` vide en production ne casse rien de visible : le service
 * démarre, répond, et les quotas s'appliquent… à un compteur unique partagé
 * par tout le trafic, parce que toutes les connexions portent l'adresse du
 * reverse proxy. Rien ne le signalait. Voir `trustedProxyStartupWarning`.
 */
const proxyWarning = trustedProxyStartupWarning(env.get('TRUSTED_PROXY'), env.get('NODE_ENV'))
if (proxyWarning) {
  logger.warn(proxyWarning)
}

/**
 * Pile serveur : s'exécute sur toutes les requêtes, y compris celles sans
 * route correspondante.
 *
 * `client_ip_middleware` est placé en tête : l'IP résolue doit être
 * disponible pour tout ce qui suit (rate limiting, journalisation).
 */
server.use([
  () => import('#middleware/container_bindings_middleware'),
  () => import('#middleware/client_ip_middleware'),
  () => import('#middleware/force_json_response_middleware'),
  () => import('@adonisjs/cors/cors_middleware'),
])

/**
 * The router middleware stack runs middleware on all the HTTP
 * requests with a registered route.
 */
router.use([() => import('@adonisjs/core/bodyparser_middleware')])

/**
 * Middleware nommés, appliqués explicitement route par route.
 */
export const middleware = router.named({
  originGuard: () => import('#middleware/origin_guard_middleware'),
})
