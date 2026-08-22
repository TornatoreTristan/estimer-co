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
 * Détail du calcul, tel que l'API le produit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN TYPE STRUCTUREL ET NON `EstimationResult`
 * ══════════════════════════════════════════════════════════════════════════
 * `EstimationResult` est le contrat public de `/v1/estimations` : une trentaine
 * de champs, dont la moitié ne concerne pas un prospect. En n'exigeant ici que
 * ce que l'e-mail affiche réellement, deux choses deviennent vraies :
 * `EstimationResult` reste assignable tel quel (aucune conversion à écrire),
 * et un test de rendu se monte avec un objet de quinze lignes au lieu de cent.
 */
export interface AcknowledgementEstimation {
  value: number | null
  range: { low: number; high: number }
  confidence: { score: number }
  display: { showCentralValue: boolean; confidenceLabelFr: string }
  method: {
    kind: string
    level: string
    radiusM: number | null
    windowMonths: number
    comparablesCount: number
    medianPriceM2Raw: number | null
  }
  comparables: Array<{
    street: string
    city: string
    date: string
    surface: number
    rooms: number | null
    price: number
    pricePerSqm: number
  }>
  dataSource: {
    dvfPublicationDate: string | null
    disclaimerFr: string
    attributionFr: string
  }
}

export interface AcknowledgementDetails {
  /** Estimation RECALCULÉE côté serveur — jamais celle transmise par le front. */
  estimation?: AcknowledgementEstimation | null
  /** Identifiant de la vignette de carte attachée au message, quand il y en a une. */
  mapCid?: string | null
}

/** Montants affichables, une fois tranchée la question de leur provenance. */
interface AcknowledgementFigures {
  moyenne: number
  min?: number
  max?: number
}

/**
 * Quel chiffre montrer au prospect — et d'abord : y en a-t-il un ?
 *
 * Ordre de préférence, et il n'est pas arbitraire :
 *
 *  1. LE RECALCUL SERVEUR, quand il porte une valeur que l'API juge
 *     affichable (`display.showCentralValue`). C'est la seule source que le
 *     navigateur n'a pas pu toucher, et le cache d'estimation fait qu'elle
 *     coïncide avec ce que le prospect a vu à l'écran.
 *  2. LE PAYLOAD, à la règle historique : uniquement `status === 'ok'`. Un
 *     montant de repli interne n'est jamais rappelé dans un e-mail que le
 *     client conservera.
 *  3. RIEN. La carte « estimation en cours » prend la place, et la promesse
 *     de rappel sous 24 h ouvrées tient lieu de réponse.
 *
 * `showCentralValue` à `false` est le cas d'une confiance trop faible pour
 * qu'un chiffre central ait un sens : l'écran ne l'a pas montré, l'e-mail
 * n'a pas à le montrer non plus.
 */
function resolveFigures(
  payload: LeadPayload,
  result: AcknowledgementEstimation | null | undefined
): AcknowledgementFigures | null {
  if (result && result.value !== null && result.display.showCentralValue) {
    return { moyenne: result.value, min: result.range.low, max: result.range.high }
  }

  const estimation = payload.estimation
  if (estimation?.status === 'ok' && estimation.estimationMoyenne !== undefined) {
    return {
      moyenne: estimation.estimationMoyenne,
      min: estimation.estimationMin,
      max: estimation.estimationMax,
    }
  }

  return null
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
 *
 * `details` porte ce que le PAYLOAD NE PEUT PAS PORTER : le détail du calcul
 * recalculé côté serveur (méthode, confiance, ventes comparables) et la
 * vignette de carte. Voir `AcknowledgementDetails`. Absent, l'e-mail reste
 * exactement celui d'avant — c'est le cas de repli quand le recalcul échoue.
 */
export function renderAcknowledgementEmail(
  payload: LeadPayload,
  details: AcknowledgementDetails = {}
): RenderedEmail {
  const firstName = payload.name.split(/\s+/)[0] ?? payload.name

  if (payload.kind === 'contact') {
    const text = `Bonjour ${firstName},

Nous avons bien reçu votre message et nous vous répondrons dans les meilleurs
délais, en général sous 24 heures ouvrées.

Ceci est un accusé de réception automatique : inutile d'y répondre, nous
revenons vers vous personnellement.

— L'équipe Estimer mon bien`

    const subject = 'Nous avons bien reçu votre message'

    return {
      subject,
      text,
      html: renderEmailShell({
        subject,
        preheader: 'Votre message est bien arrivé, réponse sous 24 heures ouvrées.',
        content: [
          emailHeading('Message bien reçu'),
          emailParagraph(`Bonjour ${escapeHtml(firstName)},`),
          emailParagraph(
            'Nous avons bien reçu votre message. Un membre de l’équipe vous répond personnellement dans les meilleurs délais, en général sous <strong>24 heures ouvrées</strong>.'
          ),
          emailNote(
            'Ceci est un accusé de réception automatique : inutile d’y répondre, nous revenons vers vous.'
          ),
        ].join('\n'),
      }),
    }
  }

  const city = payload.property?.city ?? ''
  const figures = resolveFigures(payload, details.estimation)
  const hasValue = figures !== null

  const summary = hasValue
    ? `Estimation de votre bien${city ? ` à ${city}` : ''} : environ ${formatNumber(
        figures.moyenne
      )} €${
        figures.min !== undefined && figures.max !== undefined
          ? ` (fourchette ${formatNumber(figures.min)} € – ${formatNumber(figures.max)} €)`
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

  const subject = "Votre demande d'estimation"

  return {
    subject,
    text,
    html: renderEmailShell({
      subject,
      preheader: hasValue
        ? `Votre bien${city ? ` à ${city}` : ''} est estimé à environ ${formatNumber(figures.moyenne)} €.`
        : 'Nous finalisons l’analyse de votre bien, retour sous 24 heures ouvrées.',
      content: [
        emailHeading('Votre estimation'),
        emailParagraph(`Bonjour ${escapeHtml(firstName)},`),
        emailParagraph('Nous avons bien reçu votre demande d’estimation. Voici où elle en est.'),
        hasValue
          ? emailEstimationCard(figures, city)
          : emailPendingCard(
              `Nous finalisons l’analyse de votre bien${city ? ` à ${escapeHtml(city)}` : ''} : un conseiller vous adresse votre estimation sous 24 heures ouvrées.`
            ),
        emailMap(details.mapCid, payload),
        emailPropertyRecap(payload),
        emailConfidence(details.estimation),
        emailMethod(details.estimation),
        emailComparables(details.estimation),
        emailParagraph(
          'Un conseiller peut vous rappeler pour affiner ce chiffre : l’état réel du bien, ses vues, son exposition et les travaux récents ne se lisent pas dans les données publiques.'
        ),
        emailButton(`${SITE_URL}/contact/`, 'Être rappelé par un conseiller'),
        emailNote('Ceci est un accusé de réception automatique : inutile d’y répondre.'),
        emailLegal(details.estimation),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * GABARIT HTML DES E-MAILS ENVOYÉS AU PROSPECT
 * ═══════════════════════════════════════════════════════════════════════════
 * Contrairement à l'e-mail interne — volontairement resté en `<pre>` — celui-ci
 * est lu par un prospect qui ne nous connaît pas encore : sa mise en page est
 * le premier contact avec la marque.
 *
 * Trois contraintes commandent tout ce qui suit, et expliquent le code daté
 * qu'on n'écrirait nulle part ailleurs :
 *
 *   1. TABLEAUX ET STYLES EN LIGNE. Outlook (moteur Word) ignore `flex`,
 *      `grid` et une bonne partie de `<style>` ; Gmail supprime purement et
 *      simplement les balises `<style>` de certains messages transférés. Un
 *      gabarit à base de `<table>` et d'attributs `style="…"` est le seul qui
 *      s'affiche pareil partout.
 *   2. PAS D'IMAGE. Le logo est reconstruit en HTML (aplat sombre + mot).
 *      Les images distantes sont bloquées par défaut chez la majorité des
 *      destinataires : un en-tête qui repose sur une image est un en-tête vide
 *      une fois sur deux, et un pixel de suivi de moins vaut mieux ici.
 *   3. ÉCHAPPEMENT INCHANGÉ. Toute donnée venue du client passe par
 *      `escapeHtml`. La mise en forme n'ouvre aucune faille que le `<pre>`
 *      fermait (cf. l'avertissement en tête de fichier).
 *
 * La version `text/plain` reste la référence : elle n'a pas bougé, et un client
 * qui n'affiche que le texte lit exactement le même message.
 */

/** Palette reprise du design system du site (`src/styles/global.css`). */
const BRAND = {
  ink: '#1d0c1b',
  inkSoft: '#6e4869',
  faint: '#9e849b',
  page: '#f0ebe5',
  paper: '#ffffff',
  border: '#e4dbd1',
  accent: '#ff6e34',
  accentSoft: '#fff1eb',
} as const

const SITE_URL = 'https://estimer.co'

/**
 * Même police que le site (`BaseLayout.astro`), même repli.
 *
 * Apple Mail, iOS Mail et Thunderbird chargent la fonte distante et rendent
 * donc du Geist ; Gmail et Outlook l'ignorent et retombent sur la pile système,
 * qui reste une grotesque sans empattement d'allure proche. La déclaration ne
 * peut pas garantir Geist partout — aucun gabarit d'e-mail ne le peut — mais
 * elle l'obtient là où c'est possible, au lieu de nulle part.
 *
 * GUILLEMETS SIMPLES, IMPÉRATIVEMENT : cette pile est interpolée dans des
 * attributs `style="…"` délimités par des guillemets doubles. Un `"Geist"` y
 * refermerait l'attribut au milieu de la déclaration, et TOUTE la mise en forme
 * de la balise sauterait — police comprise, silencieusement.
 */
const FONT_STACK =
  "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

const GEIST_HREF = 'https://fonts.googleapis.com/css2?family=Geist:wght@300..700&display=swap'

/** Titre de section. */
function emailHeading(label: string): string {
  return `<h1 style="margin: 0 0 20px; font-family: ${FONT_STACK}; font-size: 26px; line-height: 1.2; font-weight: 700; letter-spacing: -0.02em; color: ${BRAND.ink};">${label}</h1>`
}

/**
 * Paragraphe courant. Reçoit du HTML déjà composé : les rares balises qu'il
 * contient (`<strong>`) sont écrites ICI, et toute valeur venue du client est
 * passée à `escapeHtml` par l'appelant avant d'arriver.
 */
function emailParagraph(content: string): string {
  return `<p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 15px; line-height: 1.65; color: ${BRAND.ink};">${content}</p>`
}

/** Mention de bas de message, en retrait typographique. */
function emailNote(content: string): string {
  return `<p style="margin: 24px 0 0; font-family: ${FONT_STACK}; font-size: 13px; line-height: 1.6; color: ${BRAND.inkSoft};">${content}</p>`
}

/**
 * Le chiffre, mis en avant.
 *
 * Appelé uniquement quand un montant est affichable : la règle qui interdit de
 * rappeler un montant issu du repli interne (voir l'en-tête de
 * `renderAcknowledgementEmail`) est tranchée par `resolveFigures`, pas ici.
 */
function emailEstimationCard(figures: AcknowledgementFigures, city: string): string {
  const hasRange = figures.min !== undefined && figures.max !== undefined

  const range = hasRange
    ? `<p style="margin: 10px 0 0; font-family: ${FONT_STACK}; font-size: 14px; line-height: 1.5; color: ${BRAND.inkSoft};">Fourchette : ${formatNumber(figures.min)} € – ${formatNumber(figures.max)} €</p>`
    : ''

  const label = `Estimation de votre bien${city ? ` à ${escapeHtml(city)}` : ''}`

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 4px 0 28px; border-collapse: collapse;">
  <tr>
    <td width="4" bgcolor="${BRAND.accent}" style="width: 4px; line-height: 1px; font-size: 0;">&nbsp;</td>
    <td bgcolor="${BRAND.accentSoft}" style="padding: 22px 24px;">
      <p style="margin: 0 0 6px; font-family: ${FONT_STACK}; font-size: 12px; line-height: 1.4; letter-spacing: 0.06em; text-transform: uppercase; color: ${BRAND.inkSoft};">${label}</p>
      <p style="margin: 0; font-family: ${FONT_STACK}; font-size: 32px; line-height: 1.15; font-weight: 700; letter-spacing: -0.02em; color: ${BRAND.ink};">${formatNumber(figures.moyenne)} €</p>
      ${range}
    </td>
  </tr>
</table>`
}

/** Même emplacement que le chiffre, quand il n'y a pas encore de chiffre. */
function emailPendingCard(message: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 4px 0 28px; border-collapse: collapse;">
  <tr>
    <td width="4" bgcolor="${BRAND.accent}" style="width: 4px; line-height: 1px; font-size: 0;">&nbsp;</td>
    <td bgcolor="${BRAND.accentSoft}" style="padding: 22px 24px;">
      <p style="margin: 0 0 6px; font-family: ${FONT_STACK}; font-size: 12px; line-height: 1.4; letter-spacing: 0.06em; text-transform: uppercase; color: ${BRAND.inkSoft};">Estimation en cours</p>
      <p style="margin: 0; font-family: ${FONT_STACK}; font-size: 15px; line-height: 1.6; color: ${BRAND.ink};">${message}</p>
    </td>
  </tr>
</table>`
}

/**
 * Rappel du bien tel que le prospect l'a décrit.
 *
 * Aucune donnée nouvelle : uniquement ce qu'il a saisi lui-même, pour qu'il
 * vérifie d'un coup d'œil que l'estimation porte sur le bon bien — et repère
 * une surface mal tapée avant d'en tirer une conclusion.
 */
function emailPropertyRecap(payload: LeadPayload): string {
  const property = payload.property
  if (!property) {
    return ''
  }

  const rows: Array<[string, string]> = [
    ['Type de bien', PROPERTY_TYPE_LABELS[property.propertyType] ?? property.propertyType],
    ['Surface', `${property.surface} m²`],
  ]

  if (property.rooms) {
    rows.push(['Pièces', String(property.rooms)])
  }
  rows.push(['Localisation', `${property.postalCode} ${property.city}`])

  const cells = rows
    .map(
      ([label, value], index) => `
  <tr>
    <td style="padding: ${index === 0 ? '0' : '10px'} 0 10px; border-bottom: 1px solid ${BRAND.border}; font-family: ${FONT_STACK}; font-size: 14px; line-height: 1.5; color: ${BRAND.inkSoft};">${label}</td>
    <td align="right" style="padding: ${index === 0 ? '0' : '10px'} 0 10px; border-bottom: 1px solid ${BRAND.border}; font-family: ${FONT_STACK}; font-size: 14px; line-height: 1.5; font-weight: 600; color: ${BRAND.ink};">${escapeHtml(value)}</td>
  </tr>`
    )
    .join('')

  return `<p style="margin: 0 0 12px; font-family: ${FONT_STACK}; font-size: 12px; line-height: 1.4; letter-spacing: 0.06em; text-transform: uppercase; color: ${BRAND.faint};">Le bien estimé</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 28px; border-collapse: collapse;">${cells}
</table>`
}

/**
 * Vignette de carte, attachée au message sous `cid`.
 *
 * `width` en ATTRIBUT autant qu'en style : Outlook ignore le `max-width` CSS
 * et afficherait l'image à sa taille intrinsèque — ici le double, puisqu'elle
 * est tirée en `scale=2` — en crevant la colonne de 600 px.
 *
 * `alt` est renseigné parce que l'image est bloquée par défaut chez beaucoup
 * de destinataires : ce texte est alors tout ce qu'ils lisent à cet endroit.
 */
function emailMap(cid: string | null | undefined, payload: LeadPayload): string {
  if (!cid) {
    return ''
  }

  const city = payload.property?.city ?? ''
  const alt = `Carte du secteur${city ? ` de ${escapeHtml(city)}` : ''}`

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 28px; border-collapse: collapse;">
  <tr>
    <td style="padding: 0; line-height: 0;">
      <img src="cid:${cid}" width="536" alt="${alt}" style="display: block; width: 100%; max-width: 536px; height: auto; border: 1px solid ${BRAND.border};" />
    </td>
  </tr>
  <tr>
    <td style="padding: 8px 0 0; font-family: ${FONT_STACK}; font-size: 12px; line-height: 1.5; color: ${BRAND.faint};">Secteur du bien estimé.</td>
  </tr>
</table>`
}

/**
 * Score de confiance, en barre.
 *
 * Le chiffre nu (« 82/100 ») ne dit rien à un particulier ; la barre situe
 * immédiatement le niveau, et le libellé français produit par l'API
 * (`display.confidenceLabelFr`) le nomme. On n'invente pas ce libellé ici :
 * l'écran et l'e-mail doivent qualifier la même estimation avec le même mot.
 */
function emailConfidence(result: AcknowledgementEstimation | null | undefined): string {
  if (!result) {
    return ''
  }

  const score = Math.max(0, Math.min(100, Math.round(result.confidence.score)))
  const label = result.display.confidenceLabelFr

  return `<p style="margin: 0 0 12px; font-family: ${FONT_STACK}; font-size: 12px; line-height: 1.4; letter-spacing: 0.06em; text-transform: uppercase; color: ${BRAND.faint};">Indice de confiance</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 8px; border-collapse: collapse;">
  <tr>
    <td width="${score}%" bgcolor="${BRAND.accent}" style="width: ${score}%; height: 8px; line-height: 8px; font-size: 0;">&nbsp;</td>
    <td width="${100 - score}%" bgcolor="${BRAND.border}" style="width: ${100 - score}%; height: 8px; line-height: 8px; font-size: 0;">&nbsp;</td>
  </tr>
</table>
<p style="margin: 0 0 28px; font-family: ${FONT_STACK}; font-size: 14px; line-height: 1.5; color: ${BRAND.ink};"><strong>${score}/100</strong> — ${escapeHtml(label)}</p>`
}

/** Libellés des niveaux de la cascade de recherche (§3.2), côté client. */
const METHOD_LEVEL_LABELS: Record<string, string> = {
  'strict': 'le voisinage immédiat',
  'relaxed': 'le quartier',
  'city': 'la commune',
  'city-wide': 'la commune',
  'department': 'le département',
}

/**
 * « Comment ce chiffre a été calculé ».
 *
 * C'est la section qui transforme un nombre en argument : un prospect qui voit
 * sur quoi repose l'estimation rappelle pour en discuter, celui qui reçoit un
 * chiffre sans origine le classe avec les publicités. Tout vient du bloc
 * `method` de l'API — aucune de ces phrases n'est décorative.
 */
function emailMethod(result: AcknowledgementEstimation | null | undefined): string {
  if (!result || result.method.kind === 'not-supported') {
    return ''
  }

  const method = result.method
  const rows: Array<[string, string]> = []

  if (method.comparablesCount > 0) {
    rows.push(['Ventes analysées', `${method.comparablesCount} transactions réelles`])
  }

  const perimeter = method.radiusM
    ? `${formatNumber(method.radiusM)} m autour du bien`
    : (METHOD_LEVEL_LABELS[method.level] ?? 'le secteur')
  rows.push(['Périmètre', perimeter])
  rows.push(['Période', `${method.windowMonths} derniers mois`])

  if (method.medianPriceM2Raw) {
    rows.push(['Prix médian du secteur', `${formatNumber(method.medianPriceM2Raw)} € / m²`])
  }
  if (result.dataSource.dvfPublicationDate) {
    rows.push([
      'Données',
      `DVF, publication ${escapeHtml(formatMonth(result.dataSource.dvfPublicationDate))}`,
    ])
  }

  return `<p style="margin: 0 0 12px; font-family: ${FONT_STACK}; font-size: 12px; line-height: 1.4; letter-spacing: 0.06em; text-transform: uppercase; color: ${BRAND.faint};">Comment ce chiffre est calculé</p>
<p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 15px; line-height: 1.65; color: ${BRAND.ink};">Nous partons du prix au m² constaté sur les ventes réelles enregistrées autour de votre bien, puis nous l’ajustons à ses caractéristiques : surface, étage, extérieur, état et DPE.</p>
${detailTable(rows)}`
}

/**
 * Les ventes similaires retenues.
 *
 * Limitées à cinq : au-delà, la colonne de 600 px devient un tableau de
 * données que personne ne lit sur un téléphone, et le lien vers le rapport
 * complet fait mieux le travail. Les données sont déjà anonymisées par l'API
 * (rue sans numéro, mois sans jour) — on ne les ré-anonymise pas ici, mais on
 * ne les enrichit pas non plus.
 */
function emailComparables(result: AcknowledgementEstimation | null | undefined): string {
  const comparables = result?.comparables ?? []
  if (comparables.length === 0) {
    return ''
  }

  const rows = comparables
    .slice(0, 5)
    .map((comparable, index) => {
      const where = `${comparable.street}, ${comparable.city}`
      const what = [
        `${formatNumber(comparable.surface)} m²`,
        comparable.rooms ? `${comparable.rooms} pièces` : null,
        formatMonth(comparable.date),
      ]
        .filter(Boolean)
        .join(' · ')

      return `
  <tr>
    <td style="padding: ${index === 0 ? '0' : '12px'} 0 12px; border-bottom: 1px solid ${BRAND.border}; font-family: ${FONT_STACK}; font-size: 14px; line-height: 1.5; color: ${BRAND.ink};">
      <span style="font-weight: 600;">${escapeHtml(where)}</span><br />
      <span style="font-size: 13px; color: ${BRAND.inkSoft};">${escapeHtml(what)}</span>
    </td>
    <td align="right" style="padding: ${index === 0 ? '0' : '12px'} 0 12px; border-bottom: 1px solid ${BRAND.border}; font-family: ${FONT_STACK}; font-size: 14px; line-height: 1.5; color: ${BRAND.ink}; white-space: nowrap;">
      <span style="font-weight: 600;">${formatNumber(comparable.price)} €</span><br />
      <span style="font-size: 13px; color: ${BRAND.inkSoft};">${formatNumber(comparable.pricePerSqm)} € / m²</span>
    </td>
  </tr>`
    })
    .join('')

  return `<p style="margin: 0 0 12px; font-family: ${FONT_STACK}; font-size: 12px; line-height: 1.4; letter-spacing: 0.06em; text-transform: uppercase; color: ${BRAND.faint};">Ventes similaires dans le secteur</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 28px; border-collapse: collapse;">${rows}
</table>`
}

/**
 * Avertissement légal du §8.1 — obligatoire partout où un prix est affiché,
 * e-mail compris, et servi par l'API pour qu'une révision juridique ne
 * demande pas un redéploiement.
 */
function emailLegal(result: AcknowledgementEstimation | null | undefined): string {
  if (!result) {
    return ''
  }

  const parts = [result.dataSource.disclaimerFr, result.dataSource.attributionFr].filter(Boolean)

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 28px 0 0; border-collapse: collapse;">
  <tr>
    <td style="padding: 16px 0 0; border-top: 1px solid ${BRAND.border};">
${parts
  .map(
    (part) =>
      `      <p style="margin: 0 0 8px; font-family: ${FONT_STACK}; font-size: 11px; line-height: 1.55; color: ${BRAND.faint};">${escapeHtml(part)}</p>`
  )
  .join('\n')}
    </td>
  </tr>
</table>`
}

/** Tableau libellé / valeur, à filets — même grammaire que le récapitulatif. */
function detailTable(rows: Array<[string, string]>): string {
  const cells = rows
    .map(
      ([label, value], index) => `
  <tr>
    <td style="padding: ${index === 0 ? '0' : '10px'} 0 10px; border-bottom: 1px solid ${BRAND.border}; font-family: ${FONT_STACK}; font-size: 14px; line-height: 1.5; color: ${BRAND.inkSoft};">${label}</td>
    <td align="right" style="padding: ${index === 0 ? '0' : '10px'} 0 10px; border-bottom: 1px solid ${BRAND.border}; font-family: ${FONT_STACK}; font-size: 14px; line-height: 1.5; font-weight: 600; color: ${BRAND.ink};">${value}</td>
  </tr>`
    )
    .join('')

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 28px; border-collapse: collapse;">${cells}
</table>`
}

/**
 * « 2024-06 » -> « juin 2024 ».
 *
 * Table de mois en dur plutôt que `toLocaleString` : le jour n'existe pas dans
 * la donnée (§8.3 anonymise au mois), et construire une `Date` pour la
 * reformater ferait rentrer un fuseau horaire dans une valeur qui n'en a pas —
 * « 2024-01 » vire à « décembre 2023 » à l'ouest de Greenwich.
 */
const MONTHS_FR = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
]

export function formatMonth(value: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(value ?? '')
  if (!match) {
    return value ?? ''
  }

  const month = MONTHS_FR[Number(match[2]) - 1]
  return month ? `${month} ${match[1]}` : match[1]
}

/** Bouton d'action — un tableau, parce qu'Outlook n'habille pas un `<a>`. */
function emailButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 4px 0 8px; border-collapse: collapse;">
  <tr>
    <td bgcolor="${BRAND.ink}" style="padding: 14px 26px;">
      <a href="${href}" style="display: inline-block; font-family: ${FONT_STACK}; font-size: 15px; font-weight: 600; line-height: 1; color: ${BRAND.paper}; text-decoration: none;">${label}</a>
    </td>
  </tr>
</table>`
}

/**
 * Enveloppe commune : en-tête de marque, contenu, pied de page.
 *
 * Le `preheader` est la ligne d'aperçu affichée par les boîtes de réception à
 * côté de l'objet. Sans lui, elles y recopient le premier texte trouvé —
 * « Bonjour Marie, » — et gaspillent la seule ligne qui décide de l'ouverture.
 * Il est masqué dans le corps du message par la combinaison habituelle
 * (hauteur nulle + `display: none`), qu'aucun client ne rend visible.
 */
function renderEmailShell(options: {
  subject: string
  preheader: string
  content: string
}): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light only" />
<meta name="supported-color-schemes" content="light only" />
<title>${escapeHtml(options.subject)}</title>
<link rel="stylesheet" href="${GEIST_HREF}" />
<!--[if !mso]><!-->
<style>
  @import url('${GEIST_HREF}');
</style>
<!--<![endif]-->
</head>
<body style="margin: 0; padding: 0; width: 100%; background-color: ${BRAND.page};">
<div style="display: none; max-height: 0; overflow: hidden; opacity: 0; mso-hide: all;">${options.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.page}" style="background-color: ${BRAND.page}; border-collapse: collapse;">
  <tr>
    <td align="center" style="padding: 32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; max-width: 100%; border-collapse: collapse; background-color: ${BRAND.paper}; border: 1px solid ${BRAND.border};">
        <tr>
          <td bgcolor="${BRAND.ink}" style="padding: 22px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;">
              <tr>
                <td width="28" style="width: 28px; line-height: 0;">
                  <img src="${SITE_URL}/icon-192.png" width="28" height="28" alt="" style="display: block; width: 28px; height: 28px; border: 0;" />
                </td>
                <td style="padding-left: 12px; font-family: ${FONT_STACK}; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; color: ${BRAND.paper};">Estimer mon bien</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding: 36px 32px 32px;">
${options.content}
          </td>
        </tr>
        <tr>
          <td bgcolor="${BRAND.page}" style="padding: 20px 32px; border-top: 1px solid ${BRAND.border};">
            <p style="margin: 0 0 6px; font-family: ${FONT_STACK}; font-size: 12px; line-height: 1.6; color: ${BRAND.inkSoft};">Estimer mon bien — estimation immobilière fondée sur les transactions réelles.</p>
            <p style="margin: 0; font-family: ${FONT_STACK}; font-size: 12px; line-height: 1.6; color: ${BRAND.faint};">
              <a href="${SITE_URL}/" style="color: ${BRAND.inkSoft}; text-decoration: underline;">estimer.co</a>
              &nbsp;·&nbsp;
              <a href="${SITE_URL}/politique-de-confidentialite/" style="color: ${BRAND.inkSoft}; text-decoration: underline;">Confidentialité</a>
              &nbsp;·&nbsp;
              <a href="${SITE_URL}/mentions-legales/" style="color: ${BRAND.inkSoft}; text-decoration: underline;">Mentions légales</a>
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`
}
