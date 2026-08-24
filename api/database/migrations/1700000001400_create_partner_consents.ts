import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Registre de preuve du consentement à la transmission d'un lead à un
 * partenaire — RGPD art. 7.1 (« le responsable du traitement est en mesure de
 * démontrer que la personne a donné son consentement »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CETTE TABLE EST L'EXCEPTION À « L'API NE PERSISTE AUCUNE COORDONNÉE »
 * ══════════════════════════════════════════════════════════════════════════
 * Elle l'est en connaissance de cause, et le périmètre a été taillé au plus
 * juste :
 *
 *  - **une ligne uniquement quand la case a été COCHÉE.** Un refus ne se
 *    prouve pas : le RGPD demande de démontrer un consentement, pas son
 *    absence. Constituer un fichier des personnes ayant dit non serait une
 *    collecte sans finalité — donc un manquement de plus, pas une précaution ;
 *
 *  - **aucune donnée sur le bien.** Ni adresse, ni surface, ni montant. La
 *    preuve répond à « qui a consenti, quand, à quoi » ; le bien n'en fait pas
 *    partie. Le lead lui-même continue de ne vivre que dans l'e-mail interne,
 *    et c'est de là qu'il est transmis à un partenaire ;
 *
 *  - **le texte est archivé en toutes lettres** (`consent_text`), pas
 *    référencé. Une preuve qui pointerait vers un fichier de code dirait ce
 *    que le texte est AUJOURD'HUI, pas ce que la personne a lu ce jour-là. Un
 *    déploiement suffirait à réécrire l'histoire. Même raison pour
 *    `partners` : la liste nominative est figée dans la ligne.
 *
 * `email` est stocké en clair, et ce n'est pas une négligence : la preuve doit
 * pouvoir être produite pour une personne nommée qui la réclame, ou opposée à
 * un partenaire qui prétend avoir reçu un accord. Un condensat ne permettrait
 * ni l'un ni l'autre. L'IP et le User-Agent, eux, restent sous la forme
 * anonymisée du reste du projet (`#lib/anonymize`) : ils datent et situent le
 * geste, ils n'ont pas à identifier.
 *
 * Rétention : jusqu'au retrait (`withdrawn_at`), et au plus 3 ans après le
 * recueil — même horizon que les échanges commerciaux annoncés par la
 * politique de confidentialité. Purge par la même tâche planifiée que
 * `estimations_log`.
 */
export default class extends BaseSchema {
  protected tableName = 'partner_consents'

  async up() {
    this.schema.raw(`
      CREATE TABLE ${this.tableName} (
        id                bigserial   PRIMARY KEY,

        -- Horodatage SERVEUR du recueil. C'est lui qui fait foi : une date
        -- envoyée par le navigateur se règle depuis les préférences système.
        created_at        timestamptz NOT NULL DEFAULT now(),

        -- Référence courte du lead, commune à l'e-mail interne, à l'alerte
        -- Discord et à la réponse HTTP : le seul moyen de relier une preuve à
        -- une demande sans chercher par nom ou par e-mail.
        reference         text        NOT NULL,
        lead_kind         text        NOT NULL,

        -- Qui a consenti. Le téléphone n'est pas décoratif ici : l'accord
        -- couvre explicitement le démarchage téléphonique.
        full_name         text        NOT NULL,
        email             text        NOT NULL,
        phone             text        NULL,

        -- À quoi. Texte et destinataires FIGÉS, jamais recalculés.
        consent_version   text        NOT NULL,
        consent_text      text        NOT NULL,
        partners          jsonb       NOT NULL,

        -- Contexte du geste, sous forme anonymisée (cf. estimations_log).
        ip_hmac           char(64)    NULL,
        ua_hash           char(64)    NULL,

        -- Retrait : la ligne est CONSERVÉE et datée, jamais supprimée. Elle
        -- prouve alors deux choses — que l'accord a existé, et qu'il a cessé.
        withdrawn_at      timestamptz NULL
      )
    `)

    // Répondre à « prouvez que cette personne a consenti » sans scan complet.
    this.schema.raw(
      `CREATE INDEX partner_consents_email_idx ON ${this.tableName} (lower(email), created_at DESC)`
    )
    // Retrouver la preuve d'un lead précis depuis sa référence.
    this.schema.raw(`CREATE INDEX partner_consents_reference_idx ON ${this.tableName} (reference)`)
    // Purge de rétention : `DELETE … WHERE created_at < now() - interval '3 years'`.
    this.schema.raw(`CREATE INDEX partner_consents_created_idx ON ${this.tableName} (created_at)`)
  }

  async down() {
    this.schema.raw(`DROP TABLE IF EXISTS ${this.tableName}`)
  }
}
