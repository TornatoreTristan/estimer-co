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

import app from '@adonisjs/core/services/app'

import env from '#start/env'
import { trustedProxyStartupWarning } from '#lib/client_ip'
import { mailSettings } from '#config/mail'
import { assertMailSettings, describeMailSettings } from '#lib/mail_config'
import { discordSettings } from '#config/discord'
import { describeDiscordSettings, inspectDiscordSettings } from '#lib/discord_config'

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

/*
 * Contrôle de la configuration e-mail — même philosophie que ci-dessus.
 *
 * `start/env.ts` valide chaque variable isolément ; il ne sait pas dire « si
 * MAIL_TRANSPORT=smtp, alors host/user/password/from sont obligatoires ». Or
 * la panne correspondante est parfaitement silencieuse : le service démarre,
 * `POST /v1/leads` répond 200, et pas un seul lead n'arrive. `assertMailSettings`
 * LÈVE en production dans ce cas — un service qui ne démarre pas est visible en
 * trente secondes, une boîte vide se remarque au bout d'une semaine.
 *
 * L'avertissement inverse (dry-run actif en production) est journalisé sans
 * bloquer : c'est un état volontaire pendant la mise en place du domaine chez
 * Scaleway, mais il ne doit pas passer inaperçu.
 */
for (const message of assertMailSettings(mailSettings, { inProduction: app.inProduction })) {
  logger.warn(message)
}
logger.info({ mail: describeMailSettings(mailSettings) }, 'Configuration e-mail chargée.')

/*
 * Notification Discord — canal ACCESSOIRE, donc jamais bloquant au démarrage.
 *
 * `inspectDiscordSettings` ne produit que des avertissements, à la différence
 * de son équivalent e-mail : une alerte Discord manquée prive l'équipe d'un
 * bip, elle ne perd aucun lead. Faire échouer le démarrage pour cela
 * transformerait un confort en point de défaillance.
 */
for (const message of inspectDiscordSettings(discordSettings, {
  inProduction: app.inProduction,
  rawMention: env.get('DISCORD_MENTION'),
}).warnings) {
  logger.warn(message)
}
if (discordSettings.enabled) {
  logger.info(
    { discord: describeDiscordSettings(discordSettings) },
    'Notification Discord des leads activée.'
  )
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
