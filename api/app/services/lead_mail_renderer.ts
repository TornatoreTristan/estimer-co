import type { LeadPayload } from '#validators/lead'

/**
 * Gabarits des e-mails transactionnels — **100 % pur, aucun envoi ici**.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI LE RENDU EST CÔTÉ SERVEUR ET NON PLUS CÔTÉ NAVIGATEUR
 * ══════════════════════════════════════════════════════════════════════════
 * L'ancien parcours (EmailJS) construisait le corps du message dans la page,
 * puis l'envoyait tel quel au service d'e-mail. Autrement dit : n'importe qui
 * pouvait ouvrir la console, remplacer le texte par ce qu'il voulait, et
 * faire partir cet e-mail depuis notre domaine. Tant que le destinataire est
 * notre propre boîte, le dégât se limite à du bruit ; le jour où l'on ajoute
 * un accusé de réception vers l'adresse saisie par l'internaute — ce que fait
 * `renderAcknowledgementEmail` — cela devient un relais à spam signé par
 * notre domaine, et c'est la réputation d'expéditeur du domaine qui brûle.
 *
 * Ici, le front n'envoie que des DONNÉES STRUCTURÉES, validées champ par
 * champ (`#validators/lead`). Aucune chaîne fournie par le client n'atteint
 * l'e-mail sans passer par `escapeHtml` pour la version HTML, et les libellés
 * lisibles (« Appartement », « Refait a neuf ») sont produits ICI, à partir de
 * codes fermés — jamais recopiés depuis la page.
 *
 * NON-RÉGRESSION : le corps texte de l'e-mail interne d'estimation reproduit
 * caractère pour caractère le gabarit historique, mentions de mode dégradé
 * comprises. Les tests figent ce contenu ; le commercial qui traite les leads
 * n'a rien à réapprendre.
 *
 * Une seule chose s'y est ajoutée depuis : la section PROVENANCE, placée APRÈS
 * le gabarit historique et absente quand le lead n'en porte pas. Tout ce que
 * lisait un commercial hier se lit au même endroit aujourd'hui.
 */

export interface RenderedEmail {
  subject: string
  text: string
  html: string
}

/** Libellés lisibles — produits serveur, jamais transmis par le client. */
export const PROPERTY_TYPE_LABELS: Record<string, string> = {
  'appartement': 'Appartement',
  'maison': 'Maison',
  'terrain': 'Terrain',
  'local-commercial': 'Local commercial',
}

export const DPE_LABELS: Record<string, string> = {
  A: 'A',
  B: 'B',
  C: 'C',
  D: 'D',
  E: 'E',
  F: 'F',
  G: 'G',
  unknown: 'Ne sait pas',
}

export const ELEVATOR_LABELS: Record<string, string> = {
  yes: 'Oui',
  no: 'Non',
  unknown: 'Ne sait pas',
}

export const OUTDOOR_LABELS: Record<string, string> = {
  none: 'Aucun',
  balcony: 'Balcon',
  terrace: 'Terrasse',
  garden: 'Jardin privatif',
}

export const CONDITION_LABELS: Record<string, string> = {
  'to-renovate': 'A renover',
  'fair': 'Correct',
  'good': 'Bon',
  'new': 'Refait a neuf',
}

export const WANT_TO_SELL_LABELS: Record<string, string> = {
  yes: 'Oui',
  maybe: 'Peut-etre',
  no: 'Non',
}

/** Sujets du formulaire de contact (mêmes valeurs que le `<select>`). */
export const CONTACT_SUBJECT_LABELS: Record<string, string> = {
  estimation: "Demande d'estimation",
  partenariat: 'Devenir partenaire',
  information: "Demande d'information",
  autre: 'Autre',
}

/**
 * Format monétaire français. `toLocaleString` dépend des données ICU du
 * runtime (espace fine insécable ou espace normale selon la version de Node) :
 * les tests dérivent donc l'attendu de la même API plutôt que de figer un
 * caractère précis.
 */
export function formatNumber(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return ''
  }
  return Math.round(value).toLocaleString('fr-FR')
}

/**
 * Échappement HTML. Appliqué à TOUTE valeur venue du client dans la version
 * HTML — y compris au message libre, qui est le seul champ où l'internaute
 * écrit ce qu'il veut.
 */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Moteurs de recherche : un référent qui en vient est du trafic naturel. */
const SEARCH_ENGINE_HOSTS = /(^|\.)(google|bing|yahoo|qwant|duckduckgo|ecosia|lilo|brave)\./i

/**
 * Canal d'acquisition, en clair — **source unique pour l'e-mail ET Discord**.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN LIBELLÉ ET PAS LES PARAMÈTRES BRUTS
 * ══════════════════════════════════════════════════════════════════════════
 * « Google Ads » se lit d'un coup d'œil ;
 * `utm_source=meta&utm_medium=paid_social` demande une traduction mentale que
 * personne ne fait à 19 h. Les paramètres restent affichés en dessous, pour
 * qui veut le détail — mais la première ligne doit répondre à la seule
 * question qui change la façon de rappeler : ce lead a-t-il coûté de la
 * publicité, ou est-il arrivé tout seul ?
 *
 * La règle du plan de taggage (§10.1) est reprise telle quelle : Google Ads
 * n'envoie AUCUN UTM et se reconnaît à son seul `gclid`.
 *
 * Cette fonction vit ici, et pas dans le rendu Discord qui l'a introduite,
 * pour la même raison que les tables de libellés au-dessus : deux canaux qui
 * décrivent le même lead ne doivent jamais pouvoir le décrire différemment.
 */
export function describeAcquisitionChannel(
  acquisition: NonNullable<LeadPayload['acquisition']>
): string {
  if (acquisition.gclid) {
    return 'Google Ads'
  }

  const source = (acquisition.source ?? '').toLowerCase()
  const medium = (acquisition.medium ?? '').toLowerCase()

  if (['meta', 'facebook', 'instagram'].includes(source) || medium === 'paid_social') {
    return 'Meta Ads'
  }
  if (medium === 'email' || medium === 'e-mail' || medium === 'newsletter') {
    return source ? `E-mailing (${source})` : 'E-mailing'
  }
  if (medium === 'referral') {
    return source ? `Partenaire (${source})` : 'Partenaire'
  }
  if (['cpc', 'ppc', 'paid', 'display'].includes(medium)) {
    return source ? `Publicité (${source})` : 'Publicité'
  }
  if (source) {
    return medium ? `${source} (${medium})` : source
  }

  if (acquisition.referrer) {
    return SEARCH_ENGINE_HOSTS.test(acquisition.referrer)
      ? `Recherche naturelle (${acquisition.referrer})`
      : `Site référent (${acquisition.referrer})`
  }

  /*
   * Ni campagne, ni référent : le visiteur a tapé l'adresse, cliqué un signet,
   * ou suivi un lien depuis une application qui masque le référent. On le dit
   * comme tel plutôt que d'inventer une origine.
   */
  return 'Accès direct'
}

/**
 * Section PROVENANCE de l'e-mail interne.
 *
 * Placée EN DERNIER, après les coordonnées : elle ne change pas la façon de
 * traiter le lead, elle explique d'où il vient. Le commercial lit le bien et
 * le numéro à rappeler ; la personne qui arbitre les budgets lit cette
 * section, souvent des semaines plus tard, dans un e-mail archivé — c'est
 * précisément ce que l'alerte Discord ne sait pas faire.
 *
 * Renvoie une chaîne VIDE quand le bloc est absent : les leads déposés depuis
 * une page mise en cache avant le déploiement de la capture n'ont pas de
 * provenance, et une section « Non renseignée » sur chacun d'eux serait du
 * bruit permanent. Discord, lui, affiche l'absence — le message y est unique
 * et son gabarit fixe.
 */
export function buildAcquisitionSection(acquisition: LeadPayload['acquisition']): string {
  if (!acquisition) {
    return ''
  }

  const lines = [`- Canal : ${describeAcquisitionChannel(acquisition)}`]

  if (acquisition.campaign) {
    lines.push(`- Campagne : ${acquisition.campaign}`)
  }
  if (acquisition.campaignId) {
    lines.push(`- Identifiant de campagne : ${acquisition.campaignId}`)
  }
  if (acquisition.content) {
    lines.push(`- Annonce : ${acquisition.content}`)
  }
  if (acquisition.term) {
    lines.push(`- Mot-cle : ${acquisition.term}`)
  }
  if (acquisition.referrer) {
    lines.push(`- Site referent : ${acquisition.referrer}`)
  }
  if (acquisition.landingPage) {
    lines.push(`- Page d'arrivee : ${acquisition.landingPage}`)
  }
  if (acquisition.gclid) {
    /*
     * Conservé tel quel : c'est la clé d'import des conversions hors ligne
     * chez Google Ads (lot T5 du plan de taggage). Sans lui, un lead devenu
     * mandat ne peut pas être renvoyé à la plateforme qui l'a produit.
     */
    lines.push(`- gclid : ${acquisition.gclid}`)
  }

  return `

PROVENANCE
${lines.join('\n')}`
}

/**
 * Bandeau placé en tête de l'e-mail interne quand l'estimation n'a PAS été
 * calculée par l'API (spec estimation-donnees-reelles §2.4, étape 3).
 *
 * Le lead doit être repris à la main : la mention est explicite, en
 * majuscules, et placée AVANT tout le reste. Un commercial qui survole ses
 * e-mails ne doit pas pouvoir la manquer, sans quoi il annoncera au client un
 * chiffre que personne n'a calculé sur des transactions réelles.
 */
export function buildDegradedNotice(status: string | undefined): string {
  if (status === 'deferred') {
    return `/!\\ ESTIMATION NON CALCULEE (API indisponible)
L'API d'estimation n'a pas repondu : aucune valeur n'a ete produite ni
affichee au client. A traiter manuellement.

`
  }

  if (status === 'static-fallback') {
    return `/!\\ ESTIMATION NON CALCULEE (API indisponible) - MODE DEGRADE
L'API d'estimation n'a pas repondu. Le montant ci-dessous provient du calcul
de repli interne : il n'est PAS fonde sur les transactions reelles (DVF) et
a ete presente au client comme une estimation indicative. A recalculer.

`
  }

  return ''
}

/** Description de la provenance du chiffre, pour l'e-mail interne. */
function describeEstimationSource(estimation: LeadPayload['estimation']): string {
  const status = estimation?.status ?? 'deferred'

  if (status === 'static-fallback') {
    return 'REPLI INTERNE (hors DVF) - API indisponible'
  }
  if (status !== 'ok') {
    return 'AUCUNE - API indisponible'
  }

  let source = 'API estimer.co (transactions reelles)'
  if (estimation?.confidenceScore !== undefined) {
    source += `, confiance ${estimation.confidenceScore}/100`
  }
  if (estimation?.comparablesCount !== undefined) {
    source += `, ${estimation.comparablesCount} comparables`
  }
  return source
}

/**
 * E-mail INTERNE d'une demande d'estimation — destiné à la boîte de l'équipe.
 * Reproduit le gabarit historique (`buildEmailTemplateParams` de
 * `estimation-ui.js`, désormais supprimé) à l'identique.
 */
function renderEstimationLead(payload: LeadPayload): RenderedEmail {
  const property = payload.property!
  const estimation = payload.estimation
  const propertyTypeLabel = PROPERTY_TYPE_LABELS[property.propertyType] ?? property.propertyType
  const dpeLabel = DPE_LABELS[property.dpe] ?? property.dpe

  // Précisions facultatives : seules celles réellement renseignées, pour ne
  // pas noyer l'essentiel sous une liste de « non renseigné ».
  let optionalLines = ''
  if (property.floor !== undefined && property.floor !== null) {
    optionalLines += `\n- Etage : ${property.floor}`
  }
  if (property.hasElevator) {
    optionalLines += `\n- Ascenseur : ${ELEVATOR_LABELS[property.hasElevator]}`
  }
  if (property.outdoor) {
    optionalLines += `\n- Exterieur : ${OUTDOOR_LABELS[property.outdoor]}`
  }
  if (property.condition) {
    optionalLines += `\n- Etat general : ${CONDITION_LABELS[property.condition]}`
  }

  const terrainLines =
    property.propertyType === 'maison'
      ? `\n- Terrain : ${property.hasTerrain === 'yes' ? 'Oui' : 'Non'}` +
        (property.hasTerrain === 'yes' && property.terrainSize
          ? `\n- Surface du terrain : ${property.terrainSize} m²`
          : '')
      : ''

  const text = `${buildDegradedNotice(estimation?.status)}NOUVELLE DEMANDE D'ESTIMATION

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

INFORMATIONS DU BIEN
- Type de bien : ${propertyTypeLabel}
- Adresse : ${property.address}
- Code postal : ${property.postalCode}
- Ville : ${property.city}
- Surface : ${property.surface} m²
- Nombre de pieces : ${property.rooms ?? ''}${terrainLines}
- DPE : ${dpeLabel}
- Souhaite un DPE : ${property.dpeRequest === 'yes' ? 'Oui' : 'Non'}${optionalLines}

SITUATION DU DEMANDEUR
- Proprietaire : ${property.isOwner === 'yes' ? 'Oui' : 'Non'}
- Souhaite vendre : ${WANT_TO_SELL_LABELS[property.wantToSell ?? 'no'] ?? 'Non'}

ESTIMATION CALCULEE
- Prix au m² : ${formatNumber(estimation?.prixM2)} €
- Estimation basse : ${formatNumber(estimation?.estimationMin)} €
- Estimation moyenne : ${formatNumber(estimation?.estimationMoyenne)} €
- Estimation haute : ${formatNumber(estimation?.estimationMax)} €
- Source du calcul : ${describeEstimationSource(estimation)}

COORDONNEES DU CLIENT
- Nom : ${payload.name}
- Email : ${payload.email}
- Telephone : ${payload.phone ?? 'Non renseigné'}${buildAcquisitionSection(payload.acquisition)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

  return {
    subject: "Nouvelle demande d'estimation immobiliere",
    text,
    html: wrapHtml(text),
  }
}

/** E-mail INTERNE d'un message de contact. */
function renderContactLead(payload: LeadPayload): RenderedEmail {
  const subjectLabel = payload.subject
    ? (CONTACT_SUBJECT_LABELS[payload.subject] ?? payload.subject)
    : 'Non precise'

  const text = `NOUVEAU MESSAGE DE CONTACT

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Sujet : ${subjectLabel}

MESSAGE
${payload.message ?? ''}

COORDONNEES DU CLIENT
- Nom : ${payload.name}
- Email : ${payload.email}
- Telephone : ${payload.phone ?? 'Non renseigné'}${buildAcquisitionSection(payload.acquisition)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

  return {
    subject: `Nouveau message de contact : ${subjectLabel}`,
    text,
    html: wrapHtml(text),
  }
}

/**
 * Version HTML de l'e-mail interne : le texte, échappé, dans un `<pre>`.
 *
 * Délibérément minimal. Cet e-mail est lu par deux personnes dans leur client
 * de messagerie, pas par des prospects : lui fabriquer une mise en page à base
 * de tableaux imbriqués serait du travail à maintenir pour zéro bénéfice. Le
 * `<pre>` préserve l'alignement des sections, et le `text/plain` reste la
 * version de référence.
 */
function wrapHtml(text: string): string {
  return `<pre style="font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; white-space: pre-wrap;">${escapeHtml(
    text
  )}</pre>`
}

/** E-mail interne (équipe) correspondant au lead reçu. */
export function renderInternalEmail(payload: LeadPayload): RenderedEmail {
  return payload.kind === 'estimation' ? renderEstimationLead(payload) : renderContactLead(payload)
}

/**
 * Accusé de réception envoyé AU PROSPECT.
 *
 * Contrainte forte : il ne contient AUCUNE donnée que l'internaute n'ait pas
 * lui-même saisie, et aucun contenu libre venu du client n'est repris dans le
 * HTML sans échappement. C'est ce qui l'empêche d'être détourné en vecteur
 * d'envoi vers des tiers (cf. l'avertissement en tête de fichier).
 *
 * Le montant n'est rappelé que si l'estimation a réellement été calculée
 * (`status === 'ok'`) : répéter un chiffre issu du repli interne dans un
 * e-mail que le client gardera, alors que l'écran l'a présenté comme une
 * simple indication, reviendrait à lui donner un statut qu'il n'a pas.
 */
export function renderAcknowledgementEmail(payload: LeadPayload): RenderedEmail {
  const firstName = payload.name.split(/\s+/)[0] ?? payload.name

  if (payload.kind === 'contact') {
    const text = `Bonjour ${firstName},

Nous avons bien reçu votre message et nous vous répondrons dans les meilleurs
délais, en général sous 24 heures ouvrées.

Ceci est un accusé de réception automatique : inutile d'y répondre, nous
revenons vers vous personnellement.

— L'équipe Estimer mon bien`

    return {
      subject: 'Nous avons bien reçu votre message',
      text,
      html: paragraphsToHtml(text),
    }
  }

  const estimation = payload.estimation
  const city = payload.property?.city ?? ''
  const hasValue = estimation?.status === 'ok' && estimation.estimationMoyenne !== undefined

  const summary = hasValue
    ? `Estimation de votre bien${city ? ` à ${city}` : ''} : environ ${formatNumber(
        estimation!.estimationMoyenne
      )} €${
        estimation!.estimationMin !== undefined && estimation!.estimationMax !== undefined
          ? ` (fourchette ${formatNumber(estimation!.estimationMin)} € – ${formatNumber(
              estimation!.estimationMax
            )} €)`
          : ''
      }.`
    : `Nous finalisons l'analyse de votre bien${city ? ` à ${city}` : ''} : un conseiller vous adresse votre estimation sous 24 heures ouvrées.`

  const text = `Bonjour ${firstName},

Nous avons bien reçu votre demande d'estimation.

${summary}

Un conseiller peut vous rappeler pour affiner ce chiffre : l'état réel du
bien, ses vues, son exposition et les travaux récents ne se lisent pas dans
les données publiques.

Ceci est un accusé de réception automatique : inutile d'y répondre.

— L'équipe Estimer mon bien`

  return {
    subject: "Votre demande d'estimation",
    text,
    html: paragraphsToHtml(text),
  }
}

/** Texte -> HTML simple : un `<p>` par paragraphe, tout échappé. */
function paragraphsToHtml(text: string): string {
  const paragraphs = escapeHtml(text)
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br />')}</p>`)
    .join('\n')

  return `<div style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; font-size: 15px; line-height: 1.6; color: #1c1c1c;">\n${paragraphs}\n</div>`
}
