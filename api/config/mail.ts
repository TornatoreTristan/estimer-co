import { defineConfig, transports } from '@adonisjs/mail'
import { JSONTransport } from '@adonisjs/mail/transports/json'
import type { InferMailers, SMTPConfig } from '@adonisjs/mail/types'

import env from '#start/env'
import { resolveMailSettings } from '#lib/mail_config'

/**
 * E-mails transactionnels — Scaleway Transactional Email (TEM), via SMTP.
 *
 * POURQUOI SMTP ET PAS L'API HTTP DE SCALEWAY : le protocole est le même
 * depuis dix ans, il est couvert par le transport `smtp` de `@adonisjs/mail`
 * (donc par Nodemailer, testé par des millions de déploiements), et changer de
 * fournisseur revient à changer quatre variables d'environnement — aucune
 * ligne de code. L'API HTTP imposerait un client maison, sa gestion d'erreurs,
 * ses retries et son suivi de version, pour un gain nul à notre volume.
 *
 * DEUX MAILERS, JAMAIS DE TROISIÈME CHEMIN :
 *  - `smtp`    : envoi réel vers Scaleway TEM ;
 *  - `dry-run` : transport JSON de `@adonisjs/mail` — le message est
 *                intégralement construit et sérialisé, mais AUCUNE connexion
 *                réseau n'est ouverte. C'est le mode par défaut, celui des
 *                environnements de développement, des previews et des tests.
 *
 * Le `dry-run` n'est PAS un bouchon de test : c'est le même code d'appel, le
 * même rendu, la même validation. Seul le dernier centimètre change. Un bug de
 * gabarit se voit donc en développement, sans compte Scaleway.
 */
const settings = resolveMailSettings({
  MAIL_TRANSPORT: env.get('MAIL_TRANSPORT'),
  SMTP_HOST: env.get('SMTP_HOST'),
  SMTP_PORT: env.get('SMTP_PORT'),
  SMTP_SECURE: env.get('SMTP_SECURE'),
  SMTP_USERNAME: env.get('SMTP_USERNAME'),
  SMTP_PASSWORD: env.get('SMTP_PASSWORD'),
  MAIL_FROM_ADDRESS: env.get('MAIL_FROM_ADDRESS'),
  MAIL_FROM_NAME: env.get('MAIL_FROM_NAME'),
  MAIL_REPLY_TO: env.get('MAIL_REPLY_TO'),
  MAIL_TO: env.get('MAIL_TO'),
  MAIL_TIMEOUT: env.get('MAIL_TIMEOUT'),
  MAIL_SEND_ACKNOWLEDGEMENT: env.get('MAIL_SEND_ACKNOWLEDGEMENT'),
})

/**
 * Timeouts Nodemailer. `SMTPConfig` de `@adonisjs/mail` ne les déclare pas,
 * mais Nodemailer les lit : sans eux, un port SMTP filtré en sortie (cas
 * classique chez un hébergeur) laisse la requête HTTP pendue jusqu'au timeout
 * TCP du noyau, soit plus de deux minutes.
 *
 * Le service applique en plus sa propre borne (`MAIL_TIMEOUT`) : celle-ci
 * protège la requête HTTP, celles-là ferment réellement la socket.
 */
type SmtpConfigWithTimeouts = SMTPConfig & {
  connectionTimeout?: number
  greetingTimeout?: number
  socketTimeout?: number
}

const smtpConfig: SmtpConfigWithTimeouts = {
  host: settings.host,
  port: settings.port,
  secure: settings.secure,
  /*
   * Scaleway TEM : `SMTP_USERNAME` est l'identifiant SMTP du projet et
   * `SMTP_PASSWORD` la clé API secrète. L'objet `auth` n'est posé que si les
   * deux sont présents — Nodemailer refuse un `auth` incomplet, alors qu'il
   * accepte parfaitement son absence (utile face à un relais local en dev).
   */
  ...(settings.username && settings.password
    ? { auth: { type: 'login' as const, user: settings.username, pass: settings.password } }
    : {}),
  connectionTimeout: settings.timeoutMs,
  greetingTimeout: settings.timeoutMs,
  socketTimeout: settings.timeoutMs,
}

const mailConfig = defineConfig({
  default: settings.transport === 'smtp' ? 'smtp' : 'dryRun',

  /*
   * Expéditeur global : posé ici plutôt que sur chaque message, pour qu'aucun
   * envoi ne puisse partir d'une adresse non vérifiée par inadvertance.
   * Scaleway TEM refuse tout `From` hors domaine vérifié.
   */
  from: settings.fromAddress
    ? { address: settings.fromAddress, name: settings.fromName }
    : undefined,
  replyTo: settings.replyTo ? { address: settings.replyTo, name: settings.fromName } : undefined,

  mailers: {
    smtp: transports.smtp(smtpConfig),
    /*
     * `transports.json()` n'existe pas dans les raccourcis de `@adonisjs/mail`
     * (seuls les transports « fournisseur » y figurent) : on instancie donc
     * directement le transport JSON, qui est bien un transport de premier
     * ordre du paquet. Il rend le message complet — en-têtes compris — sans
     * ouvrir la moindre socket.
     */
    dryRun: () => new JSONTransport(),
  },
})

export default mailConfig

declare module '@adonisjs/mail/types' {
  export interface MailersList extends InferMailers<typeof mailConfig> {}
}

/**
 * Réglages effectifs, réexportés pour le service d'envoi et le contrôle de
 * démarrage : une seule lecture de l'environnement, une seule vérité.
 * `SMTP_PASSWORD` en fait partie — ce module ne doit JAMAIS être journalisé
 * tel quel (cf. `describeMailSettings()` pour une version publiable).
 */
export { settings as mailSettings }
