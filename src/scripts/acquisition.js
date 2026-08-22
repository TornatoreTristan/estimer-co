// ============================================================================
// ACQUISITION — d'où vient le visiteur, mémorisé le temps de sa visite
// ============================================================================
//
// Mêmes contraintes de forme que `tracking.js` et `lead-api.js` : injecté tel
// quel dans le `<head>` de toutes les pages (`Acquisition.astro` ->
// `RawScript.astro` -> `<script is:inline>`). Ni bundler, ni `import`, ni
// `export` : style ES5, tout en portée globale, ce qui le rend chargeable dans
// le contexte `vm` de `scripts/test-acquisition.mjs`.
//
// ---------------------------------------------------------------------------
// POURQUOI UN MÉMO DE SESSION PLUTÔT QU'UNE LECTURE À LA SOUMISSION
// ---------------------------------------------------------------------------
// Le visiteur arrive sur `/?gclid=…` ou `/?utm_source=meta`, lit la page,
// clique « Estimer mon bien », traverse cinq étapes de formulaire, puis
// valide. À cet instant, l'URL courante est `/estimation` : les paramètres de
// campagne ont disparu depuis quatre navigations. Lire la provenance au moment
// de la soumission ne donnerait donc JAMAIS autre chose que « accès direct » —
// c'est-à-dire exactement le contraire de la vérité pour tout lead payant.
//
// D'où ce mémo, écrit à la première page vue et relu à la soumission.
//
// ---------------------------------------------------------------------------
// CE QUE CE FICHIER S'INTERDIT
// ---------------------------------------------------------------------------
// 1. **`sessionStorage`, jamais `localStorage`.** Le mémo disparaît à la
//    fermeture de l'onglet. Il sert à rattacher une demande à la visite qui
//    l'a produite, pas à reconnaître quelqu'un demain.
//
// 2. **Aucune donnée personnelle, aucun identifiant de mesure.** Des
//    paramètres de campagne, le nom d'hôte du référent, le chemin d'arrivée.
//    Pas de `ga_client_id`, pas de cookie, pas d'URL de référent complète —
//    celle-ci peut contenir une requête de recherche, donc du contenu saisi
//    par le visiteur.
//
// 3. **Ne jamais casser une page.** Tout accès au stockage est enveloppé :
//    Safari en navigation privée, une iframe cloisonnée ou un stockage
//    désactivé lèvent sur le simple fait de LIRE `sessionStorage`. On perd la
//    provenance, jamais le parcours.
//
// Périmètre :
//   - `embParseAcquisition(href, referrer, siteHost)` pure — URL -> bloc
//   - `embIsPaidTouch(bloc)`                          pure — campagne identifiée ?
//   - `embRememberAcquisition()`   IMPURE — écrit le mémo, renvoie le bloc retenu
//   - `embAcquisition()`           IMPURE — bloc à joindre au lead (ou null)

/** Clé du mémo. Préfixe `emb_` comme le reste des globales du site. */
var EMB_ACQ_KEY = "emb_acquisition";

/**
 * Paramètres d'URL retenus, et leur nom dans le contrat `POST /v1/leads`.
 *
 * `gclid` figure ici SEUL pour Google Ads : le plan de taggage (§10.1) impose
 * le balisage automatique et INTERDIT les UTM manuels sur les annonces Google,
 * parce qu'un `utm_source` posé à la main écrase l'attribution automatique.
 */
var EMB_ACQ_PARAMS = {
  utm_source: "source",
  utm_medium: "medium",
  utm_campaign: "campaign",
  utm_content: "content",
  utm_term: "term",
  utm_id: "campaignId",
  gclid: "gclid",
};

/** Longueur maximale d'une valeur retenue (miroir des bornes du validateur). */
var EMB_ACQ_MAX_LENGTH = 120;

/** Chaîne exploitable, tronquée : au-delà, c'est un paramètre fabriqué. */
function embAcqString(value) {
  if (typeof value !== "string") return "";
  var trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > EMB_ACQ_MAX_LENGTH ? trimmed.slice(0, EMB_ACQ_MAX_LENGTH) : trimmed;
}

/**
 * Construit le bloc de provenance — **fonction pure**.
 *
 * @param {string} href       URL de la page vue (avec ses paramètres)
 * @param {string} referrer   `document.referrer`, éventuellement vide
 * @param {string} siteHost   hôte du site, pour écarter la navigation interne
 * @returns {object|null} bloc `acquisition`, ou `null` si rien d'exploitable
 */
function embParseAcquisition(href, referrer, siteHost) {
  var block = {};

  var url = null;
  try {
    url = new URL(String(href || ""));
  } catch (error) {
    url = null;
  }

  if (url) {
    for (var param in EMB_ACQ_PARAMS) {
      if (!Object.prototype.hasOwnProperty.call(EMB_ACQ_PARAMS, param)) continue;
      var value = embAcqString(url.searchParams.get(param));
      if (value) block[EMB_ACQ_PARAMS[param]] = value;
    }
    if (url.pathname) block.landingPage = embAcqString(url.pathname);
  }

  /*
   * Référent réduit à son NOM D'HÔTE, et seulement s'il est externe. Une
   * navigation interne (page à page sur estimer.co) n'est pas une provenance,
   * et l'URL complète d'un moteur de recherche contient la requête tapée —
   * donc du contenu saisi par le visiteur, qui n'a rien à faire dans un lead.
   */
  var referrerHost = "";
  try {
    if (referrer) referrerHost = new URL(String(referrer)).hostname;
  } catch (error) {
    referrerHost = "";
  }
  if (referrerHost && referrerHost !== String(siteHost || "")) {
    block.referrer = embAcqString(referrerHost);
  }

  // Un bloc réduit à la page d'arrivée reste utile : il dit « accès direct sur
  // telle page ». En revanche, un bloc totalement vide ne mérite pas d'exister.
  var keys = Object.keys(block);
  if (keys.length === 0) return null;
  return block;
}

/** Le bloc porte-t-il une campagne identifiée (donc payante ou balisée) ? */
function embIsPaidTouch(block) {
  if (!block) return false;
  return Boolean(block.gclid || block.source || block.campaign || block.campaignId);
}

/** Lecture défensive du mémo : le stockage peut lever à la simple lecture. */
function embReadStoredAcquisition() {
  try {
    if (typeof sessionStorage === "undefined") return null;
    var raw = sessionStorage.getItem(EMB_ACQ_KEY);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    return null;
  }
}

/** Écriture défensive du mémo. Un échec est sans conséquence sur le parcours. */
function embWriteStoredAcquisition(block) {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(EMB_ACQ_KEY, JSON.stringify(block));
  } catch (error) {
    /* Stockage indisponible : on continue sans mémo. */
  }
}

/**
 * Enregistre la provenance de la page courante — appelé à chaque chargement.
 *
 * ARBITRAGE : **la dernière campagne identifiée gagne**, et à défaut le
 * premier contact de la session est conservé.
 *
 * Autrement dit, un visiteur arrivé par recherche naturelle puis revenu par
 * une annonce dans le même onglet est attribué à l'annonce. C'est ce que
 * l'équipe attend d'une alerte de lead : savoir si ce rappel a été payé.
 * Conserver coûte que coûte le tout premier contact ferait apparaître
 * « accès direct » sur des leads réellement issus d'une campagne, et
 * fausserait la seule lecture que l'on fait de ce champ.
 *
 * @returns {object|null} le bloc retenu pour la session
 */
function embRememberAcquisition() {
  var href = "";
  var referrer = "";
  var host = "";

  try {
    href = window.location.href;
    host = window.location.hostname;
    referrer = document.referrer || "";
  } catch (error) {
    return null;
  }

  var current = embParseAcquisition(href, referrer, host);
  var stored = embReadStoredAcquisition();

  if (current && (embIsPaidTouch(current) || !stored)) {
    embWriteStoredAcquisition(current);
    return current;
  }

  return stored;
}

/** Bloc `acquisition` à joindre au lead, ou `null` s'il n'y a rien à dire. */
function embAcquisition() {
  var stored = embReadStoredAcquisition();
  if (stored) return stored;
  return embRememberAcquisition();
}

/*
 * Exécution immédiate. Le script est inline dans le `<head>` : à cet instant
 * l'URL et le référent sont disponibles, et ils ne le seront pas mieux plus
 * tard. Enveloppé, comme le reste : ce fichier n'a pas le droit d'interrompre
 * le rendu d'une page pour une question de mesure.
 */
try {
  embRememberAcquisition();
} catch (error) {
  /* Rien à faire : la provenance est un confort, pas une fonction. */
}
