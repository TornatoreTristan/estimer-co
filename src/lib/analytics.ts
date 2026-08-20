/**
 * Source unique de vérité du dispositif de mesure et de consentement.
 *
 * Tout ce qui est ici est évalué AU BUILD (variables `import.meta.env`), pas
 * dans le navigateur : ces valeurs décident si le conteneur de tags est écrit
 * dans la page, si le bandeau est rendu, et ce que la politique de
 * confidentialité affirme au visiteur. Trois questions, une seule réponse —
 * c'est précisément le but de ce fichier.
 *
 * ---------------------------------------------------------------------------
 * POURQUOI UN SEUL INTERRUPTEUR
 * ---------------------------------------------------------------------------
 * Le pire état possible pour ce site n'est pas « pas de mesure » : c'est une
 * page qui affirme au visiteur qu'aucun traceur n'est actif pendant qu'un
 * conteneur en charge, ou l'inverse — un bandeau qui réclame un consentement
 * pour des cookies qui n'existent pas. Les deux sont des manquements, pas des
 * coquilles. `TRACKING_ACTIF` est donc lu par `Analytics.astro`,
 * `ConsentBanner.astro` ET `politique-de-confidentialite.astro` : les trois ne
 * peuvent pas se contredire, quelle que soit la configuration.
 *
 * Conséquence à connaître : tant que `PUBLIC_GTM_CONTAINER_ID` est vide, le
 * bandeau ne s'affiche pas. Ce n'est pas une panne, c'est la règle ci-dessus —
 * aucun traceur n'est chargé, donc aucun consentement n'est à recueillir
 * (art. 82 de la loi Informatique et Libertés : le consentement est exigé pour
 * la lecture/écriture, pas dans l'absolu). Renseigner l'identifiant du
 * conteneur suffit à tout activer d'un coup.
 */

/**
 * Identifiant du conteneur Google Tag Manager (format `GTM-XXXXXXX`).
 * Vide = aucun script Google n'est écrit dans les pages, et pas de bandeau.
 */
export const GTM_CONTAINER_ID = (import.meta.env.PUBLIC_GTM_CONTAINER_ID || '').trim();

/**
 * Domaine servant le conteneur, sans barre finale.
 *
 * Par défaut le domaine public de Google. Renseigner ici un domaine de
 * marquage côté serveur (comme `https://sst.estimer.co`, à l'image de ce que
 * fait RITMODiag) déplace la collecte derrière un serveur que nous contrôlons :
 * moins de blocage par les navigateurs et les extensions, et surtout la
 * possibilité d'arbitrer ce qui part réellement chez Google. Cela ne change
 * rien au consentement — le signal Consent Mode reste transmis à l'identique.
 */
export const GTM_SERVER_URL = (
  import.meta.env.PUBLIC_GTM_SERVER_URL || 'https://www.googletagmanager.com'
).replace(/\/+$/, '');

/**
 * Interrupteur général. Voir l'en-tête : `Analytics`, `ConsentBanner` et la
 * politique de confidentialité s'y adossent tous les trois.
 */
export const TRACKING_ACTIF = GTM_CONTAINER_ID !== '';

/**
 * Version de la politique en matière de traceurs.
 *
 * Incrémenter ce nombre invalide TOUS les consentements déjà donnés et
 * réaffiche le bandeau à chaque visiteur (`revision` de vanilla-cookieconsent).
 * C'est l'exigence du scénario « Expiration » de `specs/cms-seo-tracking.md`
 * §B4 : un consentement porte sur des finalités précises, il ne survit donc
 * pas à leur modification.
 *
 * À incrémenter dès qu'on ajoute une finalité, un destinataire ou une
 * catégorie de traceurs — jamais pour une correction de formulation.
 */
export const CONSENT_REVISION = 1;

/**
 * Durée de conservation du choix exprimé, en jours (6 mois).
 *
 * La CNIL recommande de redemander le consentement au plus tard tous les
 * 6 mois ; la spec (§B4) plafonne à 13 mois. On retient la valeur la plus
 * protectrice, qui est aussi celle **déjà annoncée au visiteur** dans la
 * politique de confidentialité (« Preuve du choix exprimé sur les cookies :
 * 6 mois »). Changer ce nombre sans corriger la page rendrait celle-ci fausse.
 *
 * Le refus est conservé aussi longtemps que l'acceptation : ne pas mémoriser
 * un refus reviendrait à reposer la question à chaque page, ce que la CNIL
 * qualifie de pratique de lassitude.
 */
export const CONSENT_EXPIRE_JOURS = 182;
