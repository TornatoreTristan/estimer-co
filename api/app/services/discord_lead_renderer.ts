import type { DiscordSettings } from '#lib/discord_config'
import {
  CONDITION_LABELS,
  CONTACT_SUBJECT_LABELS,
  DPE_LABELS,
  OUTDOOR_LABELS,
  PROPERTY_TYPE_LABELS,
  WANT_TO_SELL_LABELS,
  describeAcquisitionChannel,
  formatNumber,
} from '#services/lead_mail_renderer'
import type { LeadPayload } from '#validators/lead'

/**
 * Gabarit du message Discord — **100 % pur, aucun envoi ici**.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE MESSAGE EST UNE ALERTE, PAS UNE FICHE PROSPECT
 * ══════════════════════════════════════════════════════════════════════════
 * L'e-mail interne (`lead_mail_renderer.ts`) reste le document complet et
 * archivé. Le message Discord doit se lire en trois secondes sur un
 * téléphone : qui rappeler, pour quel bien, pour quel montant. Tout ce qui
 * n'aide pas à décider de décrocher est laissé à l'e-mail.
 *
 * Deux invariants tiennent ce fichier :
 *
 * 1. **Les libellés lisibles viennent d'ici**, à partir de codes fermés
 *    validés par `#validators/lead` — jamais d'une chaîne recopiée du front.
 *    Ils sont d'ailleurs importés du rendu e-mail : deux tables de libellés
 *    divergent toujours, et le jour où elles divergent, deux canaux décrivent
 *    le même lead différemment.
 *
 * 2. **Aucun texte libre ne peut faire sonner un téléphone.** Les seules
 *    mentions autorisées sont construites depuis la configuration
 *    (`parseDiscordMention`) et déclarées dans `allowed_mentions`. Un prospect
 *    qui saisit « @everyone » dans son message obtient du texte, pas un ping.
 */

/** Corps JSON d'un `POST` de webhook, tel qu'attendu par Discord. */
export interface DiscordWebhookBody {
  username?: string
  content?: string
  allowed_mentions: { parse: string[]; roles?: string[] }
  embeds: DiscordEmbed[]
}

interface DiscordEmbed {
  title: string
  description?: string
  color: number
  fields: DiscordEmbedField[]
  footer?: { text: string }
  timestamp?: string
}

interface DiscordEmbedField {
  name: string
  value: string
  inline?: boolean
}

/*
 * Limites de l'API Discord. Un message qui les dépasse est rejeté EN BLOC
 * (400) : la troncature n'est pas une coquetterie de mise en page, c'est ce
 * qui empêche un message de contact un peu long de faire disparaître
 * l'alerte.
 */
const FIELD_VALUE_MAX = 1_024
const TITLE_MAX = 256

/** Couleurs de la barre latérale — l'information la plus rapide à lire. */
const COLORS = {
  /** Estimation calculée sur des transactions réelles. */
  ok: 0x2e_a0_43,
  /** Contact simple, sans estimation. */
  contact: 0x2f_6f_ed,
  /** Estimation issue du repli interne, ou non calculée : à reprendre. */
  degraded: 0xd7_86_0a,
  /** L'e-mail interne n'est pas parti : le lead n'existe QUE dans ce salon. */
  alert: 0xc4_31_3a,
} as const

/** Contexte d'envoi, fourni par le service. */
export interface DiscordLeadContext {
  reference: string
  /** Issue de l'e-mail interne, telle que rendue par le service d'envoi. */
  mailStatus: 'sent' | 'dry-run' | 'failed'
  /** Horodatage ISO 8601 affiché par Discord. */
  occurredAt?: string
}

/** Tronque en signalant la coupe — un texte coupé en silence se lit de travers. */
export function truncate(value: string, max: number): string {
  const text = String(value ?? '')
  if (text.length <= max) {
    return text
  }
  return `${text.slice(0, max - 1)}…`
}

/**
 * `allowed_mentions` déduit de la mention configurée.
 *
 * Le défaut est le plus restrictif possible (`parse: []`) : sans cette
 * déclaration explicite, Discord notifie tout ce qui RESSEMBLE à une mention
 * dans le corps du message.
 */
export function buildAllowedMentions(mention: string): DiscordWebhookBody['allowed_mentions'] {
  if (mention === '@here' || mention === '@everyone') {
    return { parse: ['everyone'] }
  }

  const role = mention.match(/^<@&(\d+)>$/)
  if (role) {
    return { parse: [], roles: [role[1]] }
  }

  return { parse: [] }
}

/** Ligne d'état de l'acheminement e-mail. */
function describeMailStatus(status: DiscordLeadContext['mailStatus']): string {
  if (status === 'sent') {
    return '✅ E-mail interne transmis'
  }
  if (status === 'dry-run') {
    return '🧪 Mode dry-run — aucun e-mail envoyé'
  }
  return '🚨 **E-mail interne NON transmis** — ce message est la seule trace du lead, à traiter ici'
}

/** Caractéristiques du bien, en une ligne dense. */
function describeProperty(property: NonNullable<LeadPayload['property']>): string {
  const parts = [
    PROPERTY_TYPE_LABELS[property.propertyType] ?? property.propertyType,
    `${formatNumber(property.surface)} m²`,
  ]

  if (property.rooms !== undefined && property.rooms !== null) {
    parts.push(`${property.rooms} pièce${property.rooms > 1 ? 's' : ''}`)
  }
  if (property.dpe && property.dpe !== 'unknown') {
    parts.push(`DPE ${DPE_LABELS[property.dpe] ?? property.dpe}`)
  }
  if (property.condition) {
    parts.push(CONDITION_LABELS[property.condition] ?? property.condition)
  }
  if (property.outdoor && property.outdoor !== 'none') {
    parts.push(OUTDOOR_LABELS[property.outdoor] ?? property.outdoor)
  }
  if (property.propertyType === 'maison' && property.hasTerrain === 'yes') {
    parts.push(
      property.terrainSize ? `terrain ${formatNumber(property.terrainSize)} m²` : 'terrain'
    )
  }

  return parts.join(' · ')
}

/** Montant et fourchette, ou l'aveu qu'aucun chiffre n'a été calculé. */
function describeEstimation(estimation: LeadPayload['estimation']): string {
  if (!estimation || estimation.status === 'deferred') {
    return '**Non calculée** — API indisponible, aucun montant affiché au client.'
  }

  const moyenne = estimation.estimationMoyenne
  if (moyenne === undefined) {
    return '**Non calculée**'
  }

  let value = `**${formatNumber(moyenne)} €**`
  if (estimation.estimationMin !== undefined && estimation.estimationMax !== undefined) {
    value += `\n${formatNumber(estimation.estimationMin)} € – ${formatNumber(estimation.estimationMax)} €`
  }
  if (estimation.prixM2 !== undefined) {
    value += `\n${formatNumber(estimation.prixM2)} €/m²`
  }
  if (estimation.status === 'static-fallback') {
    /*
     * Mention non négociable, alignée sur l'e-mail interne : ce montant ne
     * vient PAS des transactions réelles. Un commercial qui le reprend au
     * téléphone en le croyant fondé sur le DVF annonce un chiffre que
     * personne n'a calculé.
     */
    value += '\n⚠️ repli interne — **pas fondé sur le DVF**, à recalculer'
  }

  return value
}

/** Chaleur du lead : propriétaire, intention de vendre, demande de DPE. */
function describeIntent(property: NonNullable<LeadPayload['property']>): string {
  const parts: string[] = []

  parts.push(`Propriétaire : ${property.isOwner === 'yes' ? 'oui' : 'non'}`)
  parts.push(
    `Vendre : ${(WANT_TO_SELL_LABELS[property.wantToSell ?? 'no'] ?? 'Non').toLowerCase()}`
  )
  if (property.dpeRequest === 'yes') {
    parts.push('**demande un DPE**')
  }

  return parts.join(' · ')
}

/** Canal + détails de campagne, tels qu'affichés dans le message. */
function describeAcquisition(acquisition: LeadPayload['acquisition']): string {
  if (!acquisition) {
    /*
     * Pas de bloc du tout : le front est plus ancien que ce champ, ou le
     * navigateur a refusé le stockage de session. À distinguer d'un « accès
     * direct », qui est une information, là où ceci est une absence.
     */
    return 'Non renseignée'
  }

  const lines = [`**${describeAcquisitionChannel(acquisition)}**`]
  const details: string[] = []

  if (acquisition.campaign) {
    details.push(`campagne ${acquisition.campaign}`)
  }
  if (acquisition.content) {
    details.push(`annonce ${acquisition.content}`)
  }
  if (acquisition.term) {
    details.push(`mot-clé ${acquisition.term}`)
  }
  if (details.length > 0) {
    lines.push(details.join(' · '))
  }

  if (acquisition.landingPage) {
    lines.push(`arrivée sur ${acquisition.landingPage}`)
  }

  return lines.join('\n')
}

/**
 * Coordonnées du prospect. Rendues seulement si `includeContact` est actif —
 * c'est le seul endroit du message qui porte des données personnelles, et
 * c'est ce qui rend l'alerte anonyme réellement anonyme.
 */
function describeContact(payload: LeadPayload): string {
  const lines = [`**${payload.name}**`, `✉️ ${payload.email}`]
  if (payload.phone) {
    lines.push(`📞 ${payload.phone}`)
  }
  return lines.join('\n')
}

/** Message d'une demande d'estimation. */
function renderEstimationLead(
  payload: LeadPayload,
  context: DiscordLeadContext,
  settings: DiscordSettings
): DiscordEmbed {
  const property = payload.property!
  const estimation = payload.estimation
  const fields: DiscordEmbedField[] = []

  fields.push({ name: 'Bien', value: truncate(describeProperty(property), FIELD_VALUE_MAX) })

  /*
   * L'adresse exacte est une donnée personnelle (elle désigne le domicile du
   * prospect) : sans `includeContact`, on s'arrête à la commune, qui suffit à
   * juger si le lead est dans le secteur.
   */
  const location = settings.includeContact
    ? `${property.address}\n${property.postalCode} ${property.city}`
    : `${property.city} (${property.postalCode})`
  fields.push({ name: 'Localisation', value: truncate(location, FIELD_VALUE_MAX) })

  fields.push({
    name: 'Estimation',
    value: truncate(describeEstimation(estimation), FIELD_VALUE_MAX),
    inline: true,
  })

  if (estimation?.status === 'ok') {
    const reliability: string[] = []
    if (estimation.confidenceScore !== undefined) {
      reliability.push(`confiance ${estimation.confidenceScore}/100`)
    }
    if (estimation.comparablesCount !== undefined) {
      reliability.push(`${estimation.comparablesCount} comparables`)
    }
    if (reliability.length > 0) {
      fields.push({ name: 'Fiabilité', value: reliability.join(' · '), inline: true })
    }
  }

  fields.push({ name: 'Intention', value: truncate(describeIntent(property), FIELD_VALUE_MAX) })

  /*
   * Affichée quel que soit `includeContact` : la provenance ne contient
   * aucune donnée personnelle (paramètres de campagne, hôte du référent,
   * chemin d'arrivée), et c'est elle qui dit si ce lead a coûté de la
   * publicité — l'information que l'on regarde en premier le lundi matin.
   */
  fields.push({
    name: 'Provenance',
    value: truncate(describeAcquisition(payload.acquisition), FIELD_VALUE_MAX),
  })

  if (settings.includeContact) {
    fields.push({ name: 'Contact', value: truncate(describeContact(payload), FIELD_VALUE_MAX) })
  }

  if (settings.includeContact && payload.message) {
    fields.push({ name: 'Message', value: truncate(payload.message, FIELD_VALUE_MAX) })
  }

  fields.push({ name: 'Acheminement', value: describeMailStatus(context.mailStatus) })

  const degraded = estimation?.status !== 'ok'

  return {
    title: truncate("🏠 Nouvelle demande d'estimation", TITLE_MAX),
    color: context.mailStatus === 'failed' ? COLORS.alert : degraded ? COLORS.degraded : COLORS.ok,
    fields,
    footer: { text: `estimer.co · réf. ${context.reference}` },
    timestamp: context.occurredAt,
  }
}

/** Message d'un formulaire de contact. */
function renderContactLead(
  payload: LeadPayload,
  context: DiscordLeadContext,
  settings: DiscordSettings
): DiscordEmbed {
  const subjectLabel = payload.subject
    ? (CONTACT_SUBJECT_LABELS[payload.subject] ?? payload.subject)
    : 'Non précisé'

  const fields: DiscordEmbedField[] = [
    { name: 'Sujet', value: truncate(subjectLabel, 256) },
    {
      name: 'Provenance',
      value: truncate(describeAcquisition(payload.acquisition), FIELD_VALUE_MAX),
    },
  ]

  if (settings.includeContact) {
    fields.push({ name: 'Contact', value: truncate(describeContact(payload), FIELD_VALUE_MAX) })
    fields.push({
      name: 'Message',
      value: truncate(payload.message ?? '', FIELD_VALUE_MAX),
    })
  }

  fields.push({ name: 'Acheminement', value: describeMailStatus(context.mailStatus) })

  return {
    title: '✉️ Nouveau message de contact',
    color: context.mailStatus === 'failed' ? COLORS.alert : COLORS.contact,
    fields,
    footer: { text: `estimer.co · réf. ${context.reference}` },
    timestamp: context.occurredAt,
  }
}

/** Corps complet du `POST` webhook pour un lead. */
export function renderLeadNotification(
  payload: LeadPayload,
  context: DiscordLeadContext,
  settings: DiscordSettings
): DiscordWebhookBody {
  const embed =
    payload.kind === 'estimation'
      ? renderEstimationLead(payload, context, settings)
      : renderContactLead(payload, context, settings)

  return {
    username: settings.username,
    content: settings.mention,
    allowed_mentions: buildAllowedMentions(settings.mention),
    embeds: [embed],
  }
}
