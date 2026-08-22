import { randomUUID } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'

import { validateLeadPayload } from '#validators/lead'
import { TransactionalMailService } from '#services/transactional_mail_service'
import { DiscordNotifierService } from '#services/discord_notifier_service'

/**
 * `POST /v1/leads` — flux transactionnel (coordonnées + contexte).
 *
 * | Code | Cas |
 * |------|-----|
 * | 200  | e-mail transmis, **ou** mode dry-run, **ou** message écarté (robot) |
 * | 403  | Origin absente ou hors liste (garde d'`Origin`, production) |
 * | 422  | payload invalide ou champ non déclaré |
 * | 429  | quota dépassé (`Retry-After`) |
 * | 502  | l'e-mail n'a pas pu être remis — le front invite à écrire en direct |
 * | 500  | erreur inattendue — jamais de trace |
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN ENDPOINT SÉPARÉ DE `/v1/estimations`
 * ══════════════════════════════════════════════════════════════════════════
 * Parce que les deux contrats sont opposés et doivent le rester :
 * `/v1/estimations` refuse toute donnée personnelle (§2.6, point 1) et
 * journalise ses appels dans `estimations_log` ; `/v1/leads` reçoit des
 * coordonnées et n'écrit RIEN nulle part. Fusionner les deux, ne serait-ce
 * qu'avec des champs optionnels, ferait entrer les coordonnées dans le
 * périmètre du calcul, donc dans son cache et sa journalisation — exactement
 * ce que la minimisation RGPD interdit.
 *
 * Le 502 est délibérément distinct du 500 : il dit au front « ta demande
 * était valide, c'est notre acheminement qui a échoué », ce qui lui permet
 * d'afficher l'adresse de contact directe plutôt qu'un « réessayez » qui
 * échouera pareil.
 */
export default class LeadsController {
  async store(ctx: HttpContext) {
    const { request, response } = ctx

    const payload = await validateLeadPayload(request.body())

    /*
     * Piège à robots. Un champ invisible pour un humain, rempli par les
     * automates : on répond 200 sans rien envoyer. Un 4xx serait une leçon
     * gratuite offerte au robot, qui reviendrait en évitant le champ.
     */
    if (payload.website) {
      logger.info(
        { event: 'lead.discarded_honeypot', kind: payload.kind },
        'Soumission écartée : piège à robots rempli.'
      )
      return response.ok({ status: 'received', reference: null })
    }

    const requestId = request.id() ?? randomUUID()
    const result = await new TransactionalMailService().deliverLead(payload, { requestId })

    /*
     * Alerte Discord — canal ACCESSOIRE, doublant l'e-mail interne pour que
     * l'équipe rappelle en minutes plutôt qu'en heures.
     *
     * Placée AVANT le branchement sur l'échec, et c'est le point important :
     * quand l'e-mail n'est pas parti, ce message devient la seule trace du
     * lead. L'inverse — ne notifier qu'en cas de succès — priverait l'équipe
     * de l'alerte exactement dans le cas où elle est vitale.
     *
     * `notifyLead` ne lève jamais et son résultat n'est volontairement pas
     * consulté : aucune panne de Discord ne doit changer le code HTTP rendu
     * au prospect. Désactivé (webhook non configuré), l'appel retourne
     * immédiatement sans toucher au réseau.
     */
    await new DiscordNotifierService().notifyLead(payload, {
      reference: result.reference,
      mailStatus: result.status,
    })

    if (result.status === 'failed') {
      /*
       * 502 : la demande était bonne, l'acheminement a échoué. Le message est
       * affichable tel quel et donne une porte de sortie immédiate — sans
       * quoi le prospect repart en pensant avoir été enregistré.
       */
      return response.status(502).send({
        code: 'MAIL_UNAVAILABLE',
        message:
          "Votre demande n'a pas pu être transmise. Réessayez dans quelques instants ou écrivez-nous directement.",
        reference: result.reference,
      })
    }

    return response.ok({
      status: result.status === 'dry-run' ? 'dry-run' : 'sent',
      reference: result.reference,
      acknowledgement: result.acknowledgementDelivered,
    })
  }
}
