import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import env from '#start/env'
import { parseTrustedProxies, resolveClientIp, type TrustedRange } from '#lib/client_ip'

/**
 * Résout une fois par requête l'IP cliente réelle (spec §2.6) et l'expose sur
 * le contexte HTTP sous `ctx.clientIp`.
 *
 * Centraliser ce calcul évite que chaque consommateur (rate limiting,
 * journalisation anonymisée) ne réimplémente sa propre lecture de
 * `X-Forwarded-For` — c'est exactement le genre de divergence qui finit par
 * ouvrir un contournement.
 */
export default class ClientIpMiddleware {
  /**
   * `TRUSTED_PROXY` est compilé une seule fois au chargement du module :
   * analyser des CIDR à chaque requête serait du gaspillage pur.
   */
  static #trustedProxies: TrustedRange[] | null = null

  static get trustedProxies(): TrustedRange[] {
    if (ClientIpMiddleware.#trustedProxies === null) {
      ClientIpMiddleware.#trustedProxies = parseTrustedProxies(env.get('TRUSTED_PROXY'))
    }
    return ClientIpMiddleware.#trustedProxies
  }

  /** Utilisé par les tests pour recharger la configuration. */
  static resetCache(): void {
    ClientIpMiddleware.#trustedProxies = null
  }

  async handle(ctx: HttpContext, next: NextFn) {
    ctx.clientIp = resolveClientIp({
      remoteAddress: ctx.request.request.socket.remoteAddress,
      forwardedFor: ctx.request.header('x-forwarded-for'),
      trustedProxies: ClientIpMiddleware.trustedProxies,
    })

    return next()
  }
}

declare module '@adonisjs/core/http' {
  export interface HttpContext {
    /**
     * IP cliente réelle, ou `null` si indéterminable. Ne jamais lire
     * `X-Forwarded-For` directement ailleurs dans le code.
     */
    clientIp: string | null
  }
}
