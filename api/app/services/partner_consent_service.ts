import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'

import env from '#start/env'
import { hashUserAgent, hmacIp } from '#lib/anonymize'
import { archivedConsentText, resolvePartnerConsent } from '#lib/partner_consent'
import type { LeadPayload } from '#validators/lead'

/**
 * Écriture de la preuve de consentement à la transmission partenaire.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA PREUVE EST ÉCRITE AVANT QUE LE LEAD NE PARTE
 * ══════════════════════════════════════════════════════════════════════════
 * L'ordre n'est pas indifférent. L'e-mail interne est le document depuis lequel
 * un lead est effectivement transmis à un partenaire ; il ne doit donc jamais
 * annoncer un accord dont la trace n'existe pas. On écrit d'abord, on rend le
 * verdict, et c'est ce verdict — pas le contenu du formulaire — que les deux
 * canaux de notification affichent.
 *
 * Corollaire : une écriture ratée (base indisponible) ne fait PAS échouer la
 * demande. Elle dégrade le lead en « accord non prouvé », ce qui interdit sa
 * transmission mais préserve l'estimation, le rapport et le rappel commercial.
 * Perdre une demande d'estimation parce qu'une case facultative n'a pas pu
 * être journalisée serait un mauvais échange.
 */

/** Ce qu'il est advenu de l'accord — seule source des mentions affichées. */
export type PartnerConsentOutcome =
  /** Aucun bloc reçu : formulaire de contact, ou page antérieure au déploiement. */
  | { state: 'absent' }
  /** Case décochée. Refus exprimé, rien à écrire. */
  | { state: 'declined' }
  /** Version inconnue du registre : impossible de savoir à quoi la personne a consenti. */
  | { state: 'unverifiable'; version: string }
  /** Écriture refusée par la base. L'accord existe, la preuve non. */
  | { state: 'not-stored'; version: string }
  /** Preuve écrite. C'est le SEUL état qui autorise une transmission. */
  | { state: 'recorded'; version: string; partners: string[] }

export interface PartnerConsentContext {
  /** Référence courte du lead, identique à celle de l'e-mail et de Discord. */
  reference: string
  clientIp?: string | null
  userAgent?: string | null
}

export class PartnerConsentService {
  /**
   * Enregistre l'accord s'il y en a un, et décrit ce qui s'est passé.
   *
   * Ne lève jamais : chaque sortie d'échec a son état, et l'appelant n'a
   * qu'une décision à prendre — transmettre ou non — à partir de `state`.
   */
  async record(
    payload: LeadPayload,
    context: PartnerConsentContext
  ): Promise<PartnerConsentOutcome> {
    const consent = payload.partnerConsent

    if (!consent) {
      return { state: 'absent' }
    }

    /*
     * Refus exprimé : on s'arrête ici, et surtout on n'écrit RIEN. Tenir la
     * liste des personnes ayant refusé serait une collecte sans finalité — cf.
     * l'en-tête de la migration `create_partner_consents`.
     */
    if (!consent.granted) {
      return { state: 'declined' }
    }

    const registered = resolvePartnerConsent(consent.version)
    if (!registered) {
      /*
       * Version absente du registre : le texte présenté est inconnu du
       * serveur, donc inarchivable. Écrire une preuve « à peu près » serait
       * pire que ne rien écrire — elle attesterait d'un accord à un texte que
       * personne n'a pu vérifier.
       */
      logger.warn(
        {
          event: 'partner_consent.unknown_version',
          reference: context.reference,
          version: consent.version,
        },
        'Accord partenaire reçu pour une version inconnue : aucune preuve écrite.'
      )
      return { state: 'unverifiable', version: consent.version }
    }

    try {
      await db.rawQuery(
        `INSERT INTO partner_consents (
           reference, lead_kind, full_name, email, phone,
           consent_version, consent_text, partners, ip_hmac, ua_hash
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          context.reference,
          payload.kind,
          payload.name,
          payload.email,
          payload.phone ?? null,
          registered.version,
          archivedConsentText(registered),
          JSON.stringify(registered.partenaires),
          hmacIp(context.clientIp ?? null, env.get('IP_HASH_SALT')),
          hashUserAgent(context.userAgent ?? null),
        ]
      )
    } catch (error) {
      logger.error(
        { err: error, event: 'partner_consent.write_failed', reference: context.reference },
        'Preuve de consentement partenaire non écrite : ce lead ne doit pas être transmis.'
      )
      return { state: 'not-stored', version: registered.version }
    }

    logger.info(
      {
        event: 'partner_consent.recorded',
        reference: context.reference,
        version: registered.version,
      },
      'Consentement partenaire enregistré.'
    )

    return {
      state: 'recorded',
      version: registered.version,
      partners: registered.partenaires,
    }
  }
}

/**
 * Un lead ne peut être transmis à un partenaire que si la preuve existe.
 *
 * Fonction d'une ligne, exportée quand même : c'est la règle métier de tout ce
 * dossier, et elle doit être écrite UNE fois. Les deux gabarits de notification
 * l'appellent au lieu de rejouer chacun leur propre condition — deux
 * conditions recopiées finissent toujours par diverger, et le jour où elles
 * divergent, un canal autorise ce que l'autre interdit.
 */
export function isTransferable(outcome: PartnerConsentOutcome): boolean {
  return outcome.state === 'recorded'
}
