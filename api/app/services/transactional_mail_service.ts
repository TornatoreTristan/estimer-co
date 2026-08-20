import { randomUUID } from 'node:crypto'
import mail from '@adonisjs/mail/services/main'
import logger from '@adonisjs/core/services/logger'
import app from '@adonisjs/core/services/app'

import { mailSettings } from '#config/mail'
import { maskEmail, type MailSettings } from '#lib/mail_config'
import { renderAcknowledgementEmail, renderInternalEmail } from '#services/lead_mail_renderer'
import type { LeadPayload } from '#validators/lead'

/**
 * Envoi des e-mails transactionnels — Scaleway TEM.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE SERVICE GARANTIT
 * ══════════════════════════════════════════════════════════════════════════
 * 1. **Aucune persistance des coordonnées.** Elles traversent le processus et
 *    repartent par SMTP. Rien n'est écrit en base : ni ici, ni dans
 *    `estimations_log`, qui ne voit de toute façon jamais ce payload.
 *
 * 2. **Aucune PII en clair dans les journaux.** Les adresses sont masquées
 *    (`maskEmail`), le corps du message n'est journalisé qu'en `debug` et
 *    hors production. Un journal est copié, agrégé et conservé bien plus
 *    longtemps que la donnée : y déverser les leads reviendrait à tenir un
 *    second fichier clients hors de tout contrôle.
 *
 * 3. **Aucun secret journalisé.** La clé API Scaleway n'est lue que par
 *    `config/mail.ts`, et `describeMailSettings()` l'exclut par construction
 *    (elle n'est pas masquée : elle est absente).
 *
 * 4. **Un e-mail lent ne tient pas une requête HTTP ouverte.** `MAIL_TIMEOUT`
 *    borne chaque envoi. Sans cela, un port 587 filtré en sortie — le grand
 *    classique de l'hébergement — laisse le navigateur du prospect attendre
 *    jusqu'au timeout TCP du noyau.
 *
 * 5. **L'accusé de réception ne peut pas faire perdre un lead.** Il est
 *    envoyé APRÈS l'e-mail interne, et son échec est journalisé sans changer
 *    l'issue de la requête. L'inverse — perdre la demande parce que la boîte
 *    du prospect rebondit — serait absurde.
 */

/** Issue d'un envoi, telle que rendue au front. */
export type LeadDeliveryStatus = 'sent' | 'dry-run' | 'failed'

export interface LeadDeliveryResult {
  status: LeadDeliveryStatus
  /** L'e-mail interne (celui qui porte le lead) est-il parti ? */
  internalDelivered: boolean
  /** L'accusé de réception au prospect est-il parti ? `false` si désactivé. */
  acknowledgementDelivered: boolean
  /** Référence courte, affichable par le front et présente dans les journaux. */
  reference: string
  /** Cause d'échec, à des fins de journalisation — jamais renvoyée telle quelle. */
  failureReason?: 'timeout' | 'transport' | 'not-configured'
}

export interface LeadDeliveryContext {
  requestId: string
}

/**
 * Erreur levée quand un envoi dépasse `MAIL_TIMEOUT`. Distincte d'une erreur
 * de transport : une lenteur SMTP et un rejet d'authentification n'appellent
 * pas le même diagnostic côté exploitation.
 */
class MailTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Envoi interrompu après ${timeoutMs} ms.`)
    this.name = 'MailTimeoutError'
  }
}

/**
 * Neutralise CR/LF dans une valeur destinée à un en-tête (nom d'expéditeur).
 *
 * Nodemailer encode déjà les noms d'affichage, mais cette ligne coûte un
 * `replace` et retire toute la classe des injections d'en-tête du champ de
 * réflexion : le nom est le seul texte libre qu'on place hors du corps.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/** Borne un envoi dans le temps. L'appel sous-jacent n'est pas annulable. */
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MailTimeoutError(timeoutMs)), timeoutMs)
        /*
         * `unref` : ce minuteur ne doit jamais, à lui seul, retarder l'arrêt du
         * processus — sans quoi un redéploiement Coolify attendrait la fin du
         * délai le plus long en vol.
         */
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export class TransactionalMailService {
  private settings: MailSettings

  /**
   * Les réglages sont injectables pour que les tests puissent exercer les
   * bascules (dry-run, accusé désactivé, timeout court) sans toucher au
   * `process.env` du runner, qui est partagé par toute la campagne.
   */
  constructor(settings: MailSettings = mailSettings) {
    this.settings = settings
  }

  /**
   * Envoie l'e-mail interne, puis l'accusé de réception si celui-ci est
   * activé. Ne lève JAMAIS : l'issue est décrite par le résultat, et c'est le
   * contrôleur qui choisit le code HTTP.
   */
  async deliverLead(
    payload: LeadPayload,
    context: LeadDeliveryContext
  ): Promise<LeadDeliveryResult> {
    const reference = buildReference(context.requestId)
    const isDryRun = this.settings.transport !== 'smtp'

    if (!this.settings.to) {
      /*
       * Sans destinataire interne, l'envoi n'a aucun sens. En production, ce
       * cas est impossible : `assertMailSettings()` refuse le démarrage. Il
       * reste atteignable en développement, et doit alors être bruyant.
       */
      logger.error(
        { event: 'mail.not_configured', reference, kind: payload.kind },
        'MAIL_TO absent : la demande ne peut être transmise à personne.'
      )
      return {
        status: 'failed',
        internalDelivered: false,
        acknowledgementDelivered: false,
        reference,
        failureReason: 'not-configured',
      }
    }

    const internal = renderInternalEmail(payload)
    const startedAt = process.hrtime.bigint()

    try {
      await withTimeout(
        mail.send((message) => {
          message
            .to(this.settings.to)
            .subject(internal.subject)
            .text(internal.text)
            .html(internal.html)
            /*
             * Répondre à l'e-mail interne doit écrire au prospect : c'est le
             * geste que fait le commercial dix fois par jour. L'adresse a été
             * validée (`vine.email()`), le nom est nettoyé de ses CR/LF.
             */
            .replyTo(payload.email, sanitizeHeaderValue(payload.name))
        }),
        this.settings.timeoutMs
      )
    } catch (error) {
      this.logFailure('mail.internal_failed', error, payload, reference)
      return {
        status: 'failed',
        internalDelivered: false,
        acknowledgementDelivered: false,
        reference,
        failureReason: error instanceof MailTimeoutError ? 'timeout' : 'transport',
      }
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000

    logger.info(
      {
        event: isDryRun ? 'mail.internal_dry_run' : 'mail.internal_sent',
        reference,
        kind: payload.kind,
        transport: this.settings.transport,
        to: maskEmail(this.settings.to),
        lead: maskEmail(payload.email),
        durationMs: Math.round(durationMs),
      },
      isDryRun
        ? 'Mode dry-run : e-mail interne construit mais NON envoyé.'
        : 'E-mail interne transmis.'
    )

    /*
     * Le corps contient les coordonnées du prospect : il n'est visible qu'en
     * développement, et seulement si l'on a explicitement demandé le niveau
     * `debug`. C'est le seul endroit d'où l'on peut relire un gabarit sans
     * boîte mail.
     */
    if (isDryRun && !app.inProduction) {
      logger.debug(
        { event: 'mail.dry_run_body', reference, subject: internal.subject },
        internal.text
      )
    }

    const acknowledgementDelivered = await this.deliverAcknowledgement(payload, reference)

    return {
      status: isDryRun ? 'dry-run' : 'sent',
      internalDelivered: true,
      acknowledgementDelivered,
      reference,
    }
  }

  /**
   * Accusé de réception au prospect. Isolé dans sa propre méthode parce que
   * son échec est NON BLOQUANT : il est rattrapé ici même, et la demande reste
   * acquise.
   */
  private async deliverAcknowledgement(payload: LeadPayload, reference: string): Promise<boolean> {
    if (!this.settings.sendAcknowledgement) {
      return false
    }

    const acknowledgement = renderAcknowledgementEmail(payload)

    try {
      await withTimeout(
        mail.send((message) => {
          message
            .to(payload.email, sanitizeHeaderValue(payload.name))
            .subject(acknowledgement.subject)
            .text(acknowledgement.text)
            .html(acknowledgement.html)
        }),
        this.settings.timeoutMs
      )
    } catch (error) {
      logger.warn(
        {
          event: 'mail.acknowledgement_failed',
          reference,
          lead: maskEmail(payload.email),
          error: describeError(error),
        },
        'Accusé de réception non envoyé — la demande reste acquise.'
      )
      return false
    }

    logger.info(
      { event: 'mail.acknowledgement_sent', reference, lead: maskEmail(payload.email) },
      'Accusé de réception transmis au prospect.'
    )
    return true
  }

  private logFailure(event: string, error: unknown, payload: LeadPayload, reference: string) {
    logger.error(
      {
        event,
        reference,
        kind: payload.kind,
        transport: this.settings.transport,
        to: maskEmail(this.settings.to),
        lead: maskEmail(payload.email),
        error: describeError(error),
      },
      "Échec de l'envoi de l'e-mail interne : la demande doit être rattrapée à la main."
    )
  }
}

/**
 * Message d'erreur seul, sans trace ni objet d'origine.
 *
 * Une erreur Nodemailer porte l'intégralité des options de transport, mot de
 * passe compris : journaliser l'objet reviendrait à écrire la clé API
 * Scaleway dans les journaux le jour où l'authentification échoue —
 * c'est-à-dire précisément le jour où l'on regarde les journaux.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return 'Erreur inconnue'
}

/**
 * Référence courte et non devinable, présente à la fois dans la réponse HTTP
 * et dans les journaux : c'est ce qui permet de retrouver un lead précis sans
 * jamais chercher par nom ou par adresse e-mail.
 */
function buildReference(requestId: string | undefined): string {
  const base = requestId && requestId.length > 0 ? requestId : randomUUID()
  return base
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 12)
    .toUpperCase()
}
