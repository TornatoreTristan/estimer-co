import logger from '@adonisjs/core/services/logger'

import { discordSettings } from '#config/discord'
import type { DiscordSettings } from '#lib/discord_config'
import { maskEmail } from '#lib/mail_config'
import { renderLeadNotification, type DiscordLeadContext } from '#services/discord_lead_renderer'
import type { LeadPayload } from '#validators/lead'

/**
 * Notification Discord d'un nouveau lead — webhook entrant.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE SERVICE N'A PAS LE DROIT DE FAIRE ÉCHOUER UN LEAD
 * ══════════════════════════════════════════════════════════════════════════
 * C'est sa seule règle non négociable, et elle explique toute sa forme :
 *
 *  - `notifyLead` ne LÈVE JAMAIS. Toute erreur — réseau, DNS, 404 d'un
 *    webhook supprimé, 429 — est journalisée et convertie en résultat. Le
 *    contrôleur ne consulte même pas ce résultat pour choisir son code HTTP ;
 *  - l'appel est BORNÉ dans le temps (`DISCORD_TIMEOUT`, 4 s par défaut).
 *    Cet appel se produit pendant que le prospect regarde un écran de
 *    chargement : un salon Discord injoignable ne doit pas lui coûter
 *    l'attente d'un timeout TCP ;
 *  - le canal est DÉSACTIVÉ par défaut (webhook vide). Un déploiement
 *    existant ne change pas de comportement tant qu'on ne l'a pas configuré.
 *
 * Il est en revanche appelé même quand l'e-mail interne a ÉCHOUÉ, et c'est
 * délibéré : c'est précisément le cas où l'alerte a le plus de valeur, parce
 * qu'elle devient la seule trace d'un lead qui n'est arrivé dans aucune boîte.
 * Le message le dit explicitement (cf. `describeMailStatus`).
 *
 * SECRET : `settings.webhookUrl` porte le jeton du webhook. Il n'est
 * journalisé nulle part, y compris en cas d'échec — les erreurs `fetch` sont
 * réduites à leur message (`describeError`), jamais à l'objet d'origine qui
 * contient l'URL appelée.
 */

export type DiscordNotifyStatus = 'sent' | 'disabled' | 'failed'

export interface DiscordNotifyResult {
  status: DiscordNotifyStatus
  /** Cause d'échec, à des fins d'exploitation — jamais renvoyée au front. */
  failureReason?: 'timeout' | 'network' | 'rejected'
  /** Code HTTP renvoyé par Discord, quand il y en a eu un. */
  httpStatus?: number
}

/** Signature minimale de `fetch`, pour pouvoir injecter un bouchon en test. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export class DiscordNotifierService {
  private settings: DiscordSettings
  private fetchImpl: FetchLike

  constructor(
    settings: DiscordSettings = discordSettings,
    fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)
  ) {
    this.settings = settings
    this.fetchImpl = fetchImpl
  }

  /**
   * Poste l'alerte dans le salon. Ne lève jamais ; l'issue est décrite par le
   * résultat, que l'appelant est libre d'ignorer.
   */
  async notifyLead(
    payload: LeadPayload,
    context: Omit<DiscordLeadContext, 'occurredAt'>
  ): Promise<DiscordNotifyResult> {
    if (!this.settings.enabled) {
      return { status: 'disabled' }
    }

    const body = renderLeadNotification(
      payload,
      { ...context, occurredAt: new Date().toISOString() },
      this.settings
    )

    let response: Response
    try {
      response = await this.fetchImpl(this.settings.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        /*
         * `AbortSignal.timeout` ferme réellement la socket, là où un
         * `Promise.race` laisserait la requête vivre en arrière-plan. Sur un
         * canal accessoire, laisser filer des connexions est le début d'une
         * fuite de descripteurs.
         */
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      })
    } catch (error) {
      const timedOut = isAbortError(error)
      logger.warn(
        {
          event: 'discord.notify_failed',
          reference: context.reference,
          kind: payload.kind,
          lead: maskEmail(payload.email),
          reason: timedOut ? 'timeout' : 'network',
          error: describeError(error),
        },
        "Notification Discord non transmise — le lead n'est pas affecté."
      )
      return { status: 'failed', failureReason: timedOut ? 'timeout' : 'network' }
    }

    if (!response.ok) {
      /*
       * Les deux cas courants méritent d'être lisibles dans le journal :
       *  - 404 : le webhook a été supprimé côté Discord. Aucune alerte
       *    n'arrivera plus jamais, et rien d'autre ne le signalerait ;
       *  - 429 : quota du webhook (5 messages/2 s). On ne rejoue pas — une
       *    alerte en retard vaut mieux qu'une file d'attente à tenir.
       */
      logger.warn(
        {
          event: 'discord.notify_rejected',
          reference: context.reference,
          kind: payload.kind,
          httpStatus: response.status,
          retryAfter: response.headers?.get?.('retry-after') ?? undefined,
        },
        response.status === 404
          ? 'Webhook Discord introuvable (404) : il a probablement été supprimé du salon.'
          : 'Discord a refusé la notification.'
      )
      return { status: 'failed', failureReason: 'rejected', httpStatus: response.status }
    }

    logger.info(
      {
        event: 'discord.notify_sent',
        reference: context.reference,
        kind: payload.kind,
        mailStatus: context.mailStatus,
      },
      'Notification Discord transmise.'
    )
    return { status: 'sent', httpStatus: response.status }
  }
}

/** Un dépassement de `AbortSignal.timeout` remonte en `TimeoutError`. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/**
 * Message d'erreur seul, sans objet d'origine : une erreur `fetch` porte la
 * requête, donc l'URL du webhook, donc son jeton. La journaliser telle quelle
 * reviendrait à publier le secret le jour de la panne — c'est-à-dire
 * précisément le jour où l'on relit les journaux.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return 'Erreur inconnue'
}
