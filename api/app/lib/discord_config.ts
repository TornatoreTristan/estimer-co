/**
 * Configuration de la notification Discord des leads.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN SECOND CANAL À CÔTÉ DE L'E-MAIL
 * ══════════════════════════════════════════════════════════════════════════
 * L'e-mail interne reste la source de vérité : il porte le lead complet et il
 * est archivé dans une boîte. Discord ne le remplace pas, il le DOUBLE d'une
 * alerte immédiate — un prospect rappelé dans les dix minutes n'a pas le même
 * taux de transformation qu'un prospect rappelé le lendemain matin.
 *
 * Conséquence directe sur la conception : ce canal est ACCESSOIRE. Il ne doit
 * jamais faire échouer un dépôt de lead, jamais retarder la réponse HTTP
 * au-delà de son propre délai, et jamais empêcher le service de démarrer.
 * C'est la différence avec `mail_config.ts`, qui LÈVE en production quand la
 * configuration SMTP est incohérente : là-bas, une mauvaise configuration
 * perd des leads ; ici, elle prive seulement l'équipe d'un bip.
 *
 * Toutes les fonctions sont PURES et prennent un simple dictionnaire : elles
 * se testent sans booter l'application ni toucher au `process.env` du runner.
 */

export interface DiscordSettings {
  /** `false` dès que `DISCORD_WEBHOOK_URL` est vide ou inexploitable. */
  enabled: boolean
  /** URL du webhook. SECRET : quiconque la détient peut poster dans le salon. */
  webhookUrl: string
  timeoutMs: number
  /**
   * Les coordonnées du prospect (nom, e-mail, téléphone, adresse du bien)
   * figurent-elles dans le message ?
   *
   * `true` par défaut : une alerte « un lead est arrivé » sans savoir qui
   * rappeler oblige à rouvrir la boîte mail, ce qui annule le gain de temps
   * qui justifie ce canal. Poser `false` produit une alerte strictement
   * anonyme (type de bien, ville, montant, référence) — c'est le réglage à
   * choisir si l'on ne veut aucune donnée personnelle chez Discord.
   *
   * ATTENTION : à `true`, Discord devient un destinataire de données
   * personnelles et doit figurer dans la politique de confidentialité
   * (`src/pages/politique-de-confidentialite.astro`, section « Destinataires
   * et sous-traitants »), au même titre que Scaleway.
   */
  includeContact: boolean
  /**
   * Mention placée en tête du message, pour faire sonner un téléphone.
   * Déjà normalisée : `@here`, `@everyone` ou `<@&ID_DE_ROLE>`.
   */
  mention: string
  /** Nom d'affichage du bot dans le salon. */
  username: string
}

export type DiscordEnvSource = Record<string, string | number | boolean | undefined>

export const DISCORD_DEFAULTS = {
  /*
   * Plus court que `MAIL_TIMEOUT` (10 s) et c'est délibéré : cet appel est
   * fait pendant que le prospect regarde son écran de chargement. Un canal
   * accessoire n'a pas le droit de lui coûter dix secondes d'attente.
   */
  timeoutMs: 4_000,
  includeContact: true,
  username: 'Estimer mon bien',
} as const

export const DISCORD_TIMEOUT_MIN_MS = 500
export const DISCORD_TIMEOUT_MAX_MS = 15_000

/** Hôtes officiels des webhooks Discord (l'appli de bureau utilise les deux). */
const DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'www.discord.com',
  'discordapp.com',
  'www.discordapp.com',
  'ptb.discord.com',
  'canary.discord.com',
])

function readString(source: DiscordEnvSource, key: string): string {
  const value = source[key]
  if (value === undefined || value === null) {
    return ''
  }
  return String(value).trim()
}

/** `true`/`1`/`yes`/`on` → vrai. Absent ou vide → `fallback`. */
export function parseDiscordBoolean(
  value: string | number | boolean | undefined,
  fallback: boolean
): boolean {
  if (value === undefined || value === null || value === '') {
    return fallback
  }
  const normalized = String(value).trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
}

/** Délai borné. Une valeur illisible ou hors bornes retombe sur le défaut. */
export function parseDiscordTimeout(value: string | number | undefined): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) {
    return DISCORD_DEFAULTS.timeoutMs
  }
  if (parsed < DISCORD_TIMEOUT_MIN_MS || parsed > DISCORD_TIMEOUT_MAX_MS) {
    return DISCORD_DEFAULTS.timeoutMs
  }
  return parsed
}

/**
 * L'URL est-elle exploitable comme webhook ?
 *
 * On exige `https` (le webhook est un secret : en clair sur le réseau, il est
 * rejouable par quiconque l'a vu passer). `http` reste accepté hors
 * production, sans quoi aucun bouchon local — celui de la suite de tests
 * fonctionnels compris — ne serait possible.
 *
 * On n'exige PAS l'hôte `discord.com` : certaines équipes routent ce genre de
 * notification par une passerelle interne. Un hôte inattendu produit un
 * avertissement (cf. `inspectDiscordSettings`), pas un refus.
 */
export function isUsableWebhookUrl(value: string, options: { inProduction: boolean }): boolean {
  if (!value) {
    return false
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  if (url.protocol === 'https:') {
    return true
  }
  return url.protocol === 'http:' && !options.inProduction
}

/** L'URL pointe-t-elle vers un webhook Discord officiel ? */
export function isOfficialDiscordWebhook(value: string): boolean {
  try {
    const url = new URL(value)
    return DISCORD_WEBHOOK_HOSTS.has(url.hostname) && url.pathname.startsWith('/api/webhooks/')
  } catch {
    return false
  }
}

/**
 * Normalise la mention. Trois formes acceptées, tout le reste est ignoré :
 *  - `@here` / `@everyone` ;
 *  - un identifiant de rôle en chiffres (`123456789`) → `<@&123456789>` ;
 *  - la forme complète `<@&123456789>`, telle qu'on la copie depuis Discord.
 *
 * Le filtrage n'est pas cosmétique : la mention est réinjectée dans le corps
 * du message, et `allowed_mentions` est construit à partir d'elle. Accepter
 * une chaîne libre reviendrait à laisser une variable d'environnement décider
 * qui se fait notifier, et à quel volume.
 */
export function parseDiscordMention(value: string | undefined): string {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return ''
  }

  const normalized = raw.toLowerCase()
  if (normalized === '@here' || normalized === 'here') {
    return '@here'
  }
  if (normalized === '@everyone' || normalized === 'everyone') {
    return '@everyone'
  }

  const roleMatch = raw.match(/^<@&(\d{5,25})>$/) ?? raw.match(/^(\d{5,25})$/)
  if (roleMatch) {
    return `<@&${roleMatch[1]}>`
  }

  return ''
}

/** Assemble les réglages effectifs à partir d'une source d'environnement. */
export function resolveDiscordSettings(
  source: DiscordEnvSource,
  options: { inProduction: boolean }
): DiscordSettings {
  const webhookUrl = readString(source, 'DISCORD_WEBHOOK_URL')

  return {
    enabled: isUsableWebhookUrl(webhookUrl, options),
    webhookUrl,
    timeoutMs: parseDiscordTimeout(source['DISCORD_TIMEOUT'] as string | number | undefined),
    includeContact: parseDiscordBoolean(
      source['DISCORD_INCLUDE_CONTACT'],
      DISCORD_DEFAULTS.includeContact
    ),
    mention: parseDiscordMention(readString(source, 'DISCORD_MENTION')),
    username: readString(source, 'DISCORD_USERNAME') || DISCORD_DEFAULTS.username,
  }
}

/**
 * Vue publiable des réglages, pour le journal de démarrage.
 *
 * `webhookUrl` est ABSENTE du résultat, et non pas masquée : l'URL contient
 * l'identifiant ET le jeton du webhook, c'est-à-dire le droit de poster dans
 * le salon. Un journal est copié et agrégé ; y écrire ce secret reviendrait à
 * le publier. Un test vérifie que la sérialisation de cet objet ne contient
 * jamais l'URL.
 */
export function describeDiscordSettings(settings: DiscordSettings) {
  return {
    enabled: settings.enabled,
    hasWebhook: Boolean(settings.webhookUrl),
    timeoutMs: settings.timeoutMs,
    includeContact: settings.includeContact,
    hasMention: Boolean(settings.mention),
    username: settings.username,
  }
}

export interface DiscordSettingsReport {
  warnings: string[]
}

/**
 * Contrôle de cohérence — **ne produit que des avertissements**.
 *
 * Aucune erreur bloquante, à la différence de `inspectMailSettings` : une
 * notification Discord mal configurée ne perd aucun lead, elle prive
 * seulement l'équipe d'une alerte. Faire échouer le démarrage pour cela
 * transformerait un confort en point de défaillance.
 */
export function inspectDiscordSettings(
  settings: DiscordSettings,
  options: { inProduction: boolean; rawMention?: string }
): DiscordSettingsReport {
  const warnings: string[] = []

  if (settings.webhookUrl && !settings.enabled) {
    warnings.push(
      `DISCORD_WEBHOOK_URL n'est pas une URL exploitable : aucune notification ne partira. ` +
        `Attendu : l'URL https complète copiée depuis Discord ` +
        `(Paramètres du salon → Intégrations → Webhooks).`
    )
  }

  if (settings.enabled && !isOfficialDiscordWebhook(settings.webhookUrl)) {
    warnings.push(
      'DISCORD_WEBHOOK_URL ne ressemble pas à un webhook Discord (hôte ou chemin inattendu) : ' +
        'les notifications partiront quand même vers cette adresse.'
    )
  }

  const rawMention = String(options.rawMention ?? '').trim()
  if (rawMention && !settings.mention) {
    warnings.push(
      `DISCORD_MENTION="${rawMention}" n'est pas reconnu et sera ignoré. ` +
        `Valeurs acceptées : "@here", "@everyone", ou un identifiant de rôle ` +
        `("<@&123456789>" ou "123456789").`
    )
  }

  if (settings.enabled && settings.includeContact && options.inProduction) {
    /*
     * Rappel volontairement bruyant : à `true`, des données personnelles
     * partent chez un tiers établi hors Union européenne. Ce n'est pas une
     * erreur — c'est un choix qui doit être écrit dans la politique de
     * confidentialité, et personne ne relit ce fichier de son plein gré.
     */
    warnings.push(
      'DISCORD_INCLUDE_CONTACT=true : les coordonnées des prospects sont transmises à Discord. ' +
        'Ce destinataire doit figurer dans la politique de confidentialité. ' +
        'Poser DISCORD_INCLUDE_CONTACT=false pour une alerte sans donnée personnelle.'
    )
  }

  return { warnings }
}
