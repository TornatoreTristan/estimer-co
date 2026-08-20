/**
 * Configuration des e-mails transactionnels — Scaleway Transactional Email.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE FICHIER EXISTE PLUTÔT QU'UN SIMPLE `env.get()` DANS LE SERVICE
 * ══════════════════════════════════════════════════════════════════════════
 * Le schéma de `start/env.ts` valide chaque variable ISOLÉMENT (« est-ce un
 * nombre ? », « est-ce un hôte ? »). Il ne sait pas exprimer la seule règle
 * qui compte ici : « si le transport est `smtp`, alors host, user, password
 * et l'expéditeur sont obligatoires — et sinon, aucun ne l'est ».
 *
 * Or c'est exactement la panne la plus coûteuse : un service qui démarre,
 * répond 200 sur `POST /v1/leads`, et n'envoie rien. Le lead est perdu sans
 * qu'aucune alerte ne se déclenche, parce que du point de vue HTTP tout va
 * bien. `assertMailSettings()` transforme donc cette panne silencieuse en
 * refus de démarrage, au même titre qu'une variable manquante.
 *
 * Toutes les fonctions ci-dessous sont PURES et prennent un simple
 * dictionnaire : elles se testent sans booter l'application ni toucher au
 * `process.env` du runner.
 */

/** Transport effectif. `dry-run` n'ouvre aucune connexion SMTP. */
export type MailTransportName = 'smtp' | 'dry-run'

export interface MailSettings {
  transport: MailTransportName
  host: string
  port: number
  secure: boolean
  username: string
  password: string
  fromAddress: string
  fromName: string
  replyTo: string
  /** Boîte interne destinataire des leads. */
  to: string
  timeoutMs: number
  sendAcknowledgement: boolean
}

/** Source brute : `process.env`, ou n'importe quel dictionnaire en test. */
export type MailEnvSource = Record<string, string | number | boolean | undefined>

/**
 * Valeurs par défaut. Elles sont choisies pour qu'un environnement SANS
 * aucune variable `MAIL_*` démarre en `dry-run` : c'est le comportement sûr
 * (rien n'est envoyé, rien n'est perdu silencieusement puisque le démarrage
 * l'annonce), et c'est ce qui permet d'ajouter cette fonctionnalité sans
 * casser les déploiements existants.
 */
export const MAIL_DEFAULTS = {
  transport: 'dry-run' as MailTransportName,
  /** Endpoint SMTP de Scaleway TEM (identique dans toutes les régions). */
  host: 'smtp.tem.scw.cloud',
  /** 587 = STARTTLS. 465 impose `MAIL_SECURE=true` (TLS implicite). */
  port: 587,
  timeoutMs: 10_000,
  sendAcknowledgement: true,
} as const

/** Borne haute du timeout : au-delà, on tient une requête HTTP ouverte pour rien. */
export const MAIL_TIMEOUT_MAX_MS = 60_000
/** Borne basse : un TLS + auth SMTP ne tient pas dans moins d'une seconde. */
export const MAIL_TIMEOUT_MIN_MS = 1_000

function readString(source: MailEnvSource, key: string): string {
  const value = source[key]
  if (value === undefined || value === null) {
    return ''
  }
  return String(value).trim()
}

/**
 * `true`/`1`/`yes` → vrai. Toute autre valeur non vide → faux.
 * Une variable absente retombe sur `fallback`.
 */
export function parseMailBoolean(value: string | number | boolean | undefined, fallback: boolean) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }
  const normalized = String(value).trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
}

/**
 * Transport demandé. Une valeur inconnue retombe sur `dry-run` : ne rien
 * envoyer est toujours préférable à envoyer avec une configuration qu'on n'a
 * pas comprise. `assertMailSettings()` signalera la valeur fautive.
 */
export function parseMailTransport(value: string | undefined): MailTransportName {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  return normalized === 'smtp' ? 'smtp' : MAIL_DEFAULTS.transport
}

/**
 * Timeout borné. Une valeur illisible ou hors bornes retombe sur le défaut :
 * un `MAIL_TIMEOUT=0` mal saisi ne doit pas rendre tout envoi impossible, et
 * un `MAIL_TIMEOUT=600000` ne doit pas immobiliser une requête dix minutes.
 */
export function parseMailTimeout(value: string | number | undefined): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) {
    return MAIL_DEFAULTS.timeoutMs
  }
  if (parsed < MAIL_TIMEOUT_MIN_MS || parsed > MAIL_TIMEOUT_MAX_MS) {
    return MAIL_DEFAULTS.timeoutMs
  }
  return parsed
}

/**
 * Port SMTP. Scaleway TEM écoute sur 25, 587, 2587 (STARTTLS) et 465, 2465
 * (TLS implicite) — la variante `2xxx` existe pour les hébergeurs qui filtrent
 * les ports bas en sortie.
 */
export function parseMailPort(value: string | number | undefined): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) {
    return MAIL_DEFAULTS.port
  }
  return parsed
}

/**
 * Vérification de forme d'une adresse. Volontairement PERMISSIVE : le but
 * n'est pas de décider si une adresse existe (seul un envoi le dit), mais
 * d'attraper les erreurs de saisie grossières — valeur vide, espace, virgule
 * au lieu d'un point, `MAIL_TO=nom@` tronqué.
 */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(value.trim())
}

/** Assemble les réglages effectifs à partir d'une source d'environnement. */
export function resolveMailSettings(source: MailEnvSource): MailSettings {
  const transport = parseMailTransport(readString(source, 'MAIL_TRANSPORT'))
  const host = readString(source, 'SMTP_HOST') || MAIL_DEFAULTS.host
  const port = parseMailPort(source['SMTP_PORT'] as string | number | undefined)

  return {
    transport,
    host,
    port,
    /*
     * TLS implicite déduit du port quand la variable n'est pas posée : 465 et
     * 2465 exigent `secure: true`, sans quoi la connexion échoue par un
     * timeout obscur plutôt que par une erreur explicite.
     */
    secure: parseMailBoolean(source['SMTP_SECURE'], port === 465 || port === 2465),
    username: readString(source, 'SMTP_USERNAME'),
    password: readString(source, 'SMTP_PASSWORD'),
    fromAddress: readString(source, 'MAIL_FROM_ADDRESS'),
    fromName: readString(source, 'MAIL_FROM_NAME') || 'Estimer mon bien',
    /*
     * Sans `MAIL_REPLY_TO` explicite, on répond à l'expéditeur : c'est le
     * comportement attendu d'un e-mail transactionnel envoyé depuis un
     * domaine vérifié.
     */
    replyTo: readString(source, 'MAIL_REPLY_TO') || readString(source, 'MAIL_FROM_ADDRESS'),
    to: readString(source, 'MAIL_TO'),
    timeoutMs: parseMailTimeout(source['MAIL_TIMEOUT'] as string | number | undefined),
    sendAcknowledgement: parseMailBoolean(
      source['MAIL_SEND_ACKNOWLEDGEMENT'],
      MAIL_DEFAULTS.sendAcknowledgement
    ),
  }
}

/**
 * Masque une adresse e-mail pour la journalisation : `jean.dupont@gmail.com`
 * devient `j***t@gmail.com`.
 *
 * Une adresse e-mail est une donnée à caractère personnel. Les journaux d'un
 * service sont copiés, agrégés, conservés bien plus longtemps que la donnée
 * elle-même et lus par des gens qui n'ont aucune raison de connaître le
 * prospect : y écrire l'adresse en clair reviendrait à créer un second
 * fichier de leads, hors de tout contrôle. On conserve le domaine, seul
 * élément réellement utile pour diagnostiquer un rejet SMTP (« tous les
 * envois vers @orange.fr échouent »).
 */
export function maskEmail(value: string | null | undefined): string {
  const address = String(value ?? '').trim()
  const at = address.lastIndexOf('@')
  if (at <= 0) {
    return address ? '***' : ''
  }

  const local = address.slice(0, at)
  const domain = address.slice(at)
  if (local.length <= 2) {
    return `${local[0]}***${domain}`
  }
  return `${local[0]}***${local[local.length - 1]}${domain}`
}

/**
 * Vue publiable des réglages : tout sauf le secret.
 *
 * `SMTP_PASSWORD` (la clé API Scaleway) est délibérément ABSENT du résultat,
 * et non pas remplacé par des étoiles à partir de la vraie valeur : on ne
 * veut même pas que sa longueur transite. Un test vérifie que la sérialisation
 * de cet objet ne contient jamais le mot de passe.
 */
export function describeMailSettings(settings: MailSettings) {
  return {
    transport: settings.transport,
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    /* Chez Scaleway TEM, l'identifiant SMTP est l'ID de projet : ni secret ni
     * personnel, mais inutile en clair — on ne garde que sa présence. */
    hasCredentials: Boolean(settings.username && settings.password),
    from: settings.fromAddress,
    replyTo: settings.replyTo,
    to: settings.to,
    timeoutMs: settings.timeoutMs,
    sendAcknowledgement: settings.sendAcknowledgement,
  }
}

export interface MailSettingsReport {
  /** Incohérences bloquantes en production. */
  errors: string[]
  /** Signaux à journaliser sans empêcher le démarrage. */
  warnings: string[]
}

/**
 * Contrôle de cohérence. Ne LÈVE PAS : renvoie un rapport, pour que l'appelant
 * décide quoi en faire (échec de démarrage en production, simple avertissement
 * ailleurs) et pour que les tests puissent tout vérifier d'un coup.
 *
 * @param rawTransport valeur brute de `MAIL_TRANSPORT`, pour signaler une
 *   valeur inconnue silencieusement ramenée à `dry-run`.
 */
export function inspectMailSettings(
  settings: MailSettings,
  options: { inProduction: boolean; rawTransport?: string }
): MailSettingsReport {
  const errors: string[] = []
  const warnings: string[] = []

  const rawTransport = String(options.rawTransport ?? '').trim()
  if (rawTransport && rawTransport.toLowerCase() !== 'smtp' && rawTransport !== 'dry-run') {
    warnings.push(
      `MAIL_TRANSPORT="${rawTransport}" n'est pas reconnu : le mode « dry-run » (aucun envoi) est appliqué. ` +
        `Valeurs acceptées : "smtp", "dry-run".`
    )
  }

  if (settings.transport === 'smtp') {
    if (!settings.host) {
      errors.push('SMTP_HOST est vide alors que MAIL_TRANSPORT=smtp.')
    }
    if (!settings.username) {
      errors.push(
        'SMTP_USERNAME est vide alors que MAIL_TRANSPORT=smtp ' +
          '(Scaleway TEM : identifiant SMTP du projet).'
      )
    }
    if (!settings.password) {
      errors.push(
        'SMTP_PASSWORD est vide alors que MAIL_TRANSPORT=smtp ' +
          '(Scaleway TEM : clé API secrète, à fournir par le gestionnaire de secrets).'
      )
    }
    if (!isPlausibleEmail(settings.fromAddress)) {
      errors.push(
        `MAIL_FROM_ADDRESS ("${settings.fromAddress}") n'est pas une adresse exploitable. ` +
          `Elle doit appartenir à un domaine vérifié dans Scaleway TEM, sinon tout envoi est refusé.`
      )
    }
  } else if (options.inProduction) {
    /*
     * Cas le plus dangereux du fichier : en production, `dry-run` veut dire
     * « aucun lead ne part ». Rien ne le signale côté HTTP (l'endpoint répond
     * 200), donc c'est ici, au démarrage, qu'il faut le dire fort.
     */
    warnings.push(
      'MAIL_TRANSPORT=dry-run en PRODUCTION : aucun e-mail ne sera réellement envoyé. ' +
        'Les leads sont uniquement journalisés. Poser MAIL_TRANSPORT=smtp pour activer les envois.'
    )
  }

  if (!settings.to) {
    const message =
      'MAIL_TO est vide : aucune boîte interne ne recevra les demandes de contact et d’estimation.'
    if (settings.transport === 'smtp') {
      errors.push(message)
    } else {
      warnings.push(message)
    }
  } else if (!isPlausibleEmail(settings.to)) {
    errors.push(`MAIL_TO ("${settings.to}") n'est pas une adresse exploitable.`)
  }

  if (settings.replyTo && !isPlausibleEmail(settings.replyTo)) {
    errors.push(`MAIL_REPLY_TO ("${settings.replyTo}") n'est pas une adresse exploitable.`)
  }

  return { errors, warnings }
}

/**
 * Variante « démarrage » : lève en production si la configuration est
 * incohérente. Hors production, les erreurs deviennent des avertissements —
 * un développeur doit pouvoir lancer l'API sans compte Scaleway.
 *
 * @returns les messages à journaliser (avertissements, et erreurs tolérées
 *   hors production).
 */
export function assertMailSettings(
  settings: MailSettings,
  options: { inProduction: boolean; rawTransport?: string }
): string[] {
  const { errors, warnings } = inspectMailSettings(settings, options)

  if (errors.length > 0 && options.inProduction) {
    throw new Error(
      `Configuration e-mail invalide :\n  - ${errors.join('\n  - ')}\n` +
        `Corriger les variables d'environnement du service (cf. api/DEPLOIEMENT.md).`
    )
  }

  return [...errors, ...warnings]
}
