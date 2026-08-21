// ============================================================================
// TRACKING — socle de mesure (lot T0 de specs/plan-taggage-conversions.md)
// ============================================================================
//
// Injecté tel quel dans le `<head>` de toutes les pages (`Tracking.astro` ->
// `RawScript.astro` -> `<script is:inline>`). Comme les autres scripts du site :
// ni bundler, ni `import`/`export`, style ES5, tout en portée globale — ce qui
// le rend chargeable dans le contexte `vm` de `scripts/test-tracking.mjs`.
//
// ---------------------------------------------------------------------------
// CE FICHIER EST LE SEUL PONT ENTRE LE SITE ET GOOGLE TAG MANAGER
// ---------------------------------------------------------------------------
// Aucune balise GTM ne doit dépendre d'un sélecteur CSS, d'un texte de bouton
// ou d'une structure HTML. Tout ce que le conteneur consomme est poussé ICI,
// explicitement, sous des noms stables (cf. le dictionnaire d'événements du
// plan de taggage, §4). La raison est concrète : un déclencheur du type
// « Clic — tous les éléments, Classes CSS contient `btn--primary` » cesse de
// fonctionner au premier changement de charte, sans erreur, sans alerte, et
// personne ne s'en aperçoit avant de constater que le coût par conversion des
// campagnes a été faux pendant trois semaines.
//
// ---------------------------------------------------------------------------
// CE FICHIER PEUT NE PAS ÊTRE LÀ — LES APPELANTS DOIVENT SE GARDER
// ---------------------------------------------------------------------------
// `Tracking.astro` ne l'injecte que si `PUBLIC_GTM_CONTAINER_ID` est renseigné
// (interrupteur unique de `src/lib/analytics.ts`). Sans conteneur, ni ce
// script, ni `window.dataLayer` n'existent — règle vérifiée par
// `scripts/test-consent-banner.mjs`.
//
// Tout appelant écrit donc `if (typeof embTrack === "function") embTrack(…)`,
// comme il teste déjà `requestLead` ou `CONFIG`. Ce n'est pas de la
// superstition défensive : un `ReferenceError` levé au milieu de
// `handleSubmit()` ne coûterait pas une mesure, il coûterait le lead.
//
// ---------------------------------------------------------------------------
// DEUX RÈGLES QUE CE FICHIER FAIT RESPECTER PAR CONSTRUCTION
// ---------------------------------------------------------------------------
// 1. **Aucune donnée personnelle en clair dans le dataLayer** (plan §2.6).
//    `CHAMPS_INTERDITS` n'est pas une convention écrite dans un document :
//    c'est un filtre à l'exécution. Le dataLayer est lisible par n'importe
//    quelle extension installée chez le visiteur ; y déposer un e-mail ou une
//    adresse postale serait une divulgation, pas une imprécision.
//
// 2. **Une mesure ne casse jamais un parcours.** Tout est enveloppé : un
//    `embTrack` qui lève ferait perdre le lead qu'il était censé compter. En
//    cas d'échec, on perd la mesure, jamais la conversion.

// ============================================================================
// 1. CONSTANTES
// ============================================================================

/**
 * Clés dont la présence dans un événement est une fuite de donnée personnelle.
 *
 * Comparaison sur la clé EXACTE, jamais en sous-chaîne : `partner_name` et
 * `cta_label` sont légitimes, `name` ne l'est pas. Les variantes françaises
 * sont listées parce que le reste du code est en français et que l'erreur
 * naturelle est d'écrire `telephone`.
 */
var CHAMPS_INTERDITS = [
  "address",
  "adresse",
  "courriel",
  "email",
  "firstname",
  "lastname",
  "mail",
  "message",
  "name",
  "nom",
  "phone",
  "prenom",
  "tel",
  "telephone",
];

/**
 * Tranches de surface, bornes hautes incluses.
 *
 * Les libellés sont volontairement ZÉRO-PRÉFIXÉS (`030-059` et non `30-59`) :
 * GA4 trie les valeurs de dimension par ordre alphabétique, et sans cela
 * « 120-199 » se placerait avant « 30-59 » dans tous les rapports. Un tri
 * illisible transforme une dimension utile en curiosité qu'on n'ouvre plus.
 */
var TRANCHES_SURFACE = [
  { max: 29, libelle: "000-029" },
  { max: 59, libelle: "030-059" },
  { max: 89, libelle: "060-089" },
  { max: 119, libelle: "090-119" },
  { max: 199, libelle: "120-199" },
];
var TRANCHE_SURFACE_HAUTE = "200+";

/** Longueur maximale d'un libellé de CTA poussé dans le dataLayer. */
var LONGUEUR_MAX_LIBELLE = 80;

/**
 * Valeur de référence d'un lead d'estimation, en euros.
 *
 * ⚠️ VALEUR PROVISOIRE — À ARBITRER PAR LE MÉTIER (plan §5.2, §13.1).
 *
 * 100 n'est pas un montant observé : c'est une unité. Ce qui compte pour les
 * enchères automatiques n'est pas le montant absolu mais l'ÉCART entre deux
 * leads — un propriétaire décidé sur un bien à 600 000 € doit valoir plus
 * qu'un curieux locataire, et c'est ce rapport-là qui est correct ici.
 *
 * Le jour où le chiffre réel sera connu (prix de cession d'un lead, ou marge
 * modélisée), le remplacer ICI suffit. Mais **ne pas le faire en cours de
 * campagne** : changer l'échelle de valeur réinitialise l'apprentissage de
 * Smart Bidding, ce qui coûte plusieurs semaines de performance.
 */
var VALEUR_BASE_LEAD = 100;

/** Valeur d'un message de contact (plan §5.2). */
var VALEUR_BASE_CONTACT = 50;

/**
 * Valeur d'une candidature de partenaire.
 *
 * Elle valait zéro : un lead B2B relève d'un autre budget, et lui donner une
 * valeur apprendrait aux enchères à acheter du trafic de professionnels avec
 * l'argent destiné aux propriétaires vendeurs.
 *
 * Google Ads impose une valeur sur la catégorie retenue pour cette action —
 * « ne pas utiliser de valeur » n'y est pas proposé. On aligne donc le site sur
 * les 10 € réglés côté Ads plutôt que de laisser les deux se contredire, ce qui
 * afficherait 0 € dans les rapports en face d'un réglage annonçant 10.
 *
 * Sans conséquence sur les enchères : l'action est réglée en « secondaire »,
 * donc hors de la colonne « Conversions » et hors de l'optimisation. Et 10 €
 * face aux 50 et 100 des autres conversions garde le bon ordre de grandeur.
 */
var VALEUR_BASE_PARTENARIAT = 10;

/**
 * Coefficients de qualification (plan §5.1).
 *
 * Quatre cas et non trois : `embLeadQuality` regroupe sous `cold` le
 * propriétaire qui ne veut pas vendre ET le non-propriétaire, parce que ce
 * sont deux leads froids pour le reporting. Ils ne valent pourtant pas la même
 * chose — le premier a un bien et changera peut-être d'avis, le second n'en a
 * pas. D'où une table qui lit les deux champs bruts.
 */
var COEFFICIENT_NON_PROPRIETAIRE = 0.2;
var COEFFICIENTS_VENTE = { yes: 3, maybe: 1.5, no: 0.5 };
var COEFFICIENT_VENTE_DEFAUT = 0.5;

/**
 * Prix de bien correspondant au coefficient 1, et plafond de ce coefficient.
 *
 * Le plafond n'est pas de la prudence comptable : sans lui, un unique bien à
 * 3 M€ pèserait autant que trente leads ordinaires dans l'apprentissage des
 * enchères, qui se mettrait à courir après un profil marginal.
 */
var PRIX_BIEN_REFERENCE = 250000;
var COEFFICIENT_BIEN_MAX = 2.5;

// ============================================================================
// 2. POUSSÉE D'ÉVÉNEMENT — le contrat public
// ============================================================================

/**
 * Pousse un événement métier dans `window.dataLayer`.
 *
 * Garanties : ne lève JAMAIS, ne bloque JAMAIS, ne pousse jamais de champ vide
 * ni de champ interdit.
 *
 * Les valeurs vides sont écartées plutôt que poussées à `""` : GTM omet les
 * paramètres `undefined`, et les rapports GA4 restent exempts des lignes
 * « (not set) » qui polluent toute analyse dès qu'un paramètre est
 * conditionnel — ce qu'ils sont presque tous ici (un appartement n'a pas de
 * terrain, une estimation en repli n'a pas de score de confiance).
 *
 * @param {string} nom nom d'événement (cf. plan de taggage §4)
 * @param {Object<string, any>} [params]
 * @returns {boolean} vrai si l'événement a été poussé
 */
function embTrack(nom, params) {
  try {
    if (typeof window === "undefined") return false;
    if (typeof nom !== "string" || nom === "") return false;

    window.dataLayer = window.dataLayer || [];

    var charge = { event: nom };

    if (params) {
      for (var cle in params) {
        if (!Object.prototype.hasOwnProperty.call(params, cle)) continue;

        if (embChampInterdit(cle)) {
          // Bruyant à dessein : c'est une erreur de développement à corriger,
          // pas un cas limite à absorber en silence.
          embAvertir(
            "paramètre « " + cle + " » écarté : donnée personnelle interdite dans le dataLayer."
          );
          continue;
        }

        var valeur = params[cle];
        if (valeur === null || valeur === undefined || valeur === "") continue;
        if (typeof valeur === "number" && !isFinite(valeur)) continue;

        // Seul objet imbriqué que le plan de taggage autorise : le bloc
        // d'empreintes des conversions améliorées. Il est vérifié champ par
        // champ plutôt que recopié tel quel — c'est le seul endroit du site où
        // une donnée dérivée d'un e-mail approche le dataLayer, et une erreur
        // de câblage y ferait passer l'adresse en clair.
        if (typeof valeur === "object") {
          var nettoye = embNettoyerUserData(cle, valeur);
          if (nettoye) charge[cle] = nettoye;
          continue;
        }

        charge[cle] = valeur;
      }
    }

    window.dataLayer.push(charge);
    return true;
  } catch (erreur) {
    // Silence volontaire : voir l'en-tête, règle 2.
    return false;
  }
}

/**
 * Valide le seul objet imbriqué autorisé dans un événement : `user_data`.
 *
 * Tout le reste est refusé — non par principe, mais parce qu'un objet accepté
 * sans contrôle est un objet dont personne ne relit le contenu, et que le
 * `lastEstimation` d'où viennent la plupart de nos paramètres contient nom,
 * e-mail, téléphone et adresse postale.
 *
 * @returns {Object|null} l'objet nettoyé, ou `null` s'il n'a rien à pousser
 */
function embNettoyerUserData(cle, valeur) {
  if (cle !== "user_data" || Array.isArray(valeur)) {
    embAvertir("objet « " + cle + " » écarté : seul « user_data » peut être imbriqué.");
    return null;
  }

  var nettoye = {};
  var retenus = 0;

  for (var sousCle in valeur) {
    if (!Object.prototype.hasOwnProperty.call(valeur, sousCle)) continue;

    var empreinte = valeur[sousCle];
    if (empreinte === null || empreinte === undefined || empreinte === "") continue;

    // Une valeur qui ne ressemble pas à une empreinte SHA-256 est, par
    // élimination, une donnée en clair. On l'écarte bruyamment.
    if (typeof empreinte !== "string" || !MOTIF_EMPREINTE.test(empreinte)) {
      embAvertir(
        "user_data." + sousCle + " écarté : ce n'est pas une empreinte SHA-256."
      );
      continue;
    }

    nettoye[sousCle] = empreinte;
    retenus++;
  }

  return retenus > 0 ? nettoye : null;
}

/** Signale une erreur de câblage. Bruyant à dessein : c'est à corriger. */
function embAvertir(message) {
  if (typeof console !== "undefined" && console.warn) {
    console.warn("[tracking] " + message);
  }
}

/** Vrai si la clé est une donnée personnelle (comparaison exacte, insensible à la casse). */
function embChampInterdit(cle) {
  var normalisee = String(cle).toLowerCase();
  for (var i = 0; i < CHAMPS_INTERDITS.length; i++) {
    if (CHAMPS_INTERDITS[i] === normalisee) return true;
  }
  return false;
}

// ============================================================================
// 3. HELPERS PURS — dérivations partagées par tous les événements
// ============================================================================

/**
 * Identifiant de lead : clé de déduplication inter-plateformes (plan §2.4).
 *
 * Le même identifiant sert de `transaction_id` Google Ads et d'`eventID` Meta,
 * et de verrou anti-double-comptage sur `/rapport/`. Il est généré côté
 * client parce que la `reference` renvoyée par l'API arrive APRÈS la
 * redirection : elle ne peut pas jouer ce rôle.
 *
 * Trois niveaux de repli, du plus au moins solide. Le dernier n'a pas la
 * qualité cryptographique des deux premiers — sans conséquence ici : on a
 * besoin d'unicité, pas d'imprévisibilité.
 */
function embLeadId() {
  try {
    var crypto = typeof window !== "undefined" ? window.crypto : null;

    if (crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    if (crypto && typeof crypto.getRandomValues === "function") {
      var octets = new Uint8Array(16);
      crypto.getRandomValues(octets);
      // Version 4, variante RFC 4122.
      octets[6] = (octets[6] & 0x0f) | 0x40;
      octets[8] = (octets[8] & 0x3f) | 0x80;
      var hex = "";
      for (var i = 0; i < octets.length; i++) {
        hex += (octets[i] + 0x100).toString(16).slice(1);
        if (i === 3 || i === 5 || i === 7 || i === 9) hex += "-";
      }
      return hex;
    }
  } catch (erreur) {
    /* on tombe sur le repli ci-dessous */
  }

  return (
    "lead-" +
    new Date().getTime().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

/**
 * Tranche de surface habitable, en m².
 *
 * Regrouper plutôt que d'envoyer la valeur brute : une dimension GA4 à
 * plusieurs centaines de valeurs distinctes se solde par des lignes
 * « (other) » dans les rapports, et n'apprend rien de plus qu'une tranche.
 *
 * @param {string|number} surface
 * @returns {string} libellé de tranche, ou "" si la valeur est inexploitable
 */
function embSurfaceBucket(surface) {
  var valeur =
    typeof surface === "number"
      ? surface
      : parseFloat(String(surface === null || surface === undefined ? "" : surface).replace(",", "."));

  if (!isFinite(valeur) || valeur <= 0) return "";

  for (var i = 0; i < TRANCHES_SURFACE.length; i++) {
    if (valeur <= TRANCHES_SURFACE[i].max) return TRANCHES_SURFACE[i].libelle;
  }
  return TRANCHE_SURFACE_HAUTE;
}

/**
 * Code département depuis un code postal français.
 *
 * C'est ce code — et non le code postal — qui est enregistré comme dimension
 * GA4 : 101 valeurs s'analysent, ~6 300 non. Il donne aussi directement le
 * grain des ajustements d'enchères géographiques dans Ads.
 *
 * Trois familles à traiter, et aucune n'est un cas d'école : la Corse (un
 * département numérique, deux codes officiels), l'outre-mer (trois chiffres),
 * et les collectivités du 98. Le reste est le préfixe à deux chiffres.
 *
 * @param {string|number} codePostal
 * @returns {string} `75`, `2A`, `2B`, `974`… ou "" si le code est invalide
 */
function embDepartement(codePostal) {
  var brut = String(codePostal === null || codePostal === undefined ? "" : codePostal).trim();
  if (!/^\d{5}$/.test(brut)) return "";

  var prefixe2 = brut.slice(0, 2);
  var prefixe3 = brut.slice(0, 3);

  // Corse : 20000-20199 en Corse-du-Sud (2A), au-delà en Haute-Corse (2B).
  if (prefixe2 === "20") {
    return Number(prefixe3) <= 201 ? "2A" : "2B";
  }

  // Outre-mer (971-978) et collectivités du Pacifique (986-988) : trois
  // chiffres, comme le `codeInsee` des collections de contenu.
  if (prefixe2 === "97" || prefixe2 === "98") return prefixe3;

  return prefixe2;
}

/**
 * Qualification du lead (plan §5.1).
 *
 * Deux champs déjà collectés à l'étape 4 du tunnel suffisent à séparer un
 * propriétaire prêt à vendre d'un curieux. C'est la donnée qui rend possible
 * les enchères à la valeur : sans elle, Smart Bidding traite les deux à
 * l'identique et dépense autant pour l'un que pour l'autre.
 *
 * @param {string} isOwner   'yes' | 'no'
 * @param {string} wantToSell 'yes' | 'maybe' | 'no'
 * @returns {string} 'hot' | 'warm' | 'cold'
 */
function embLeadQuality(isOwner, wantToSell) {
  var proprietaire = String(isOwner || "").toLowerCase();
  var vendre = String(wantToSell || "").toLowerCase();

  if (proprietaire !== "yes") return "cold";
  if (vendre === "yes") return "hot";
  if (vendre === "maybe") return "warm";
  return "cold";
}

/**
 * Valeur monétaire d'un lead d'estimation, en euros (plan §5.2).
 *
 *     valeur = VALEUR_BASE_LEAD × coefficient_qualité × coefficient_bien
 *
 * Envoyer `value: 1` partout reviendrait à dire à Smart Bidding que tous les
 * leads se valent, et donc à dépenser autant pour un curieux que pour un
 * vendeur décidé. C'est le seul calcul de ce fichier qui a un effet direct sur
 * le budget publicitaire.
 *
 * @param {string} isOwner    'yes' | 'no'
 * @param {string} wantToSell 'yes' | 'maybe' | 'no'
 * @param {number|string} [valeurBien] estimation moyenne du bien, en euros
 * @returns {number} valeur arrondie au centime
 */
function embLeadValue(isOwner, wantToSell, valeurBien) {
  var proprietaire = String(isOwner || "").toLowerCase() === "yes";

  var coefficientQualite;
  if (!proprietaire) {
    coefficientQualite = COEFFICIENT_NON_PROPRIETAIRE;
  } else {
    var vendre = String(wantToSell || "").toLowerCase();
    coefficientQualite = Object.prototype.hasOwnProperty.call(COEFFICIENTS_VENTE, vendre)
      ? COEFFICIENTS_VENTE[vendre]
      : COEFFICIENT_VENTE_DEFAUT;
  }

  // Pas d'estimation exploitable (repli statique, calcul différé) : le
  // coefficient neutre. Extrapoler un prix pour ne pas laisser la case vide
  // reviendrait à apprendre aux enchères une valeur qu'on a inventée.
  var prix =
    typeof valeurBien === "number" ? valeurBien : parseFloat(String(valeurBien || ""));
  var coefficientBien = 1;
  if (isFinite(prix) && prix > 0) {
    coefficientBien = Math.min(COEFFICIENT_BIEN_MAX, prix / PRIX_BIEN_REFERENCE);
  }

  return Math.round(VALEUR_BASE_LEAD * coefficientQualite * coefficientBien * 100) / 100;
}

/**
 * Valeur monétaire d'un message de contact, en euros (plan §5.2).
 *
 * Une candidature de partenaire vaut nettement moins qu'une demande
 * d'estimation : c'est un lead B2B, qui relève d'un autre budget et d'autres
 * campagnes. Ce qui l'empêche de peser sur les enchères n'est pas sa valeur
 * mais son statut de conversion « secondaire » côté Google Ads (plan §7.1) —
 * hors de la colonne « Conversions », hors de l'optimisation.
 *
 * @param {string} sujet code du sujet (`estimation`, `partenariat`…)
 * @returns {number}
 */
function embContactValue(sujet) {
  return String(sujet || "").toLowerCase() === "partenariat"
    ? VALEUR_BASE_PARTENARIAT
    : VALEUR_BASE_CONTACT;
}

// ============================================================================
// 3bis. CONVERSIONS AMÉLIORÉES — empreintes des coordonnées (lot T3)
// ============================================================================
//
// Les conversions améliorées rattachent une conversion à un clic publicitaire
// même quand le cookie a disparu — prévention du pistage d'Apple, navigation
// d'un appareil à l'autre. Elles sont aussi le prérequis technique d'un futur
// import de conversions hors ligne.
//
// ---------------------------------------------------------------------------
// POURQUOI ON HACHE ICI, ET PAS CHEZ GOOGLE
// ---------------------------------------------------------------------------
// Google accepte les coordonnées en clair et les hache lui-même dans le
// navigateur. Ce serait plus simple, et ce serait un mauvais choix : l'adresse
// e-mail transiterait alors par `window.dataLayer`, que n'importe quelle
// extension installée chez le visiteur peut lire. On envoie donc une empreinte
// SHA-256, que Google accepte tout aussi bien.
//
// Une empreinte reste une donnée personnelle au sens du RGPD : elle identifie
// indirectement la personne, c'est même sa raison d'être. Le hachage ne
// dispense de rien — ni du consentement (`ad_user_data`, exigé par la balise),
// ni de la mention dans la politique de confidentialité. Il évite seulement
// que la donnée soit lisible en clair par un tiers sur le poste du visiteur.
//
// ---------------------------------------------------------------------------
// CE QUI NE DOIT JAMAIS ARRIVER
// ---------------------------------------------------------------------------
// Qu'un échec de hachage coûte la conversion. `embUserData` ne rejette jamais,
// et abandonne au bout de `DELAI_MAX_HACHAGE` : une conversion sans empreinte
// vaut infiniment mieux qu'une conversion perdue, ou qu'une page bloquée sur
// une promesse qui ne se résout pas. C'est aussi ce qui protège les contextes
// où `crypto.subtle` n'existe pas — page servie en HTTP, navigateur ancien.

/** Forme d'une empreinte SHA-256 en hexadécimal minuscule. */
var MOTIF_EMPREINTE = /^[0-9a-f]{64}$/;

/**
 * Abandon du hachage, en millisecondes.
 *
 * Un SHA-256 sur une chaîne courte se compte en microsecondes ; ce délai n'est
 * pas dimensionné pour le calcul mais pour l'imprévu — une implémentation qui
 * ne rend jamais la main bloquerait le `contact_lead`, donc l'accusé de
 * réception affiché au visiteur.
 */
var DELAI_MAX_HACHAGE = 500;

// ============================================================================
// 3ter. ATTENDRE QUE LE CONSENTEMENT SOIT CONNU
// ============================================================================
//
// ---------------------------------------------------------------------------
// LE PROBLÈME, CONSTATÉ EN MODE APERÇU
// ---------------------------------------------------------------------------
// Sur `/rapport/`, l'ordre réel des événements était celui-ci :
//
//     Valeur par défaut du consentement   (tout à `denied`)
//     report_view
//     generate_lead          <- la conversion part ICI
//     consent_update         <- le choix mémorisé n'arrive qu'APRÈS
//
// `ConsentBanner.astro` charge sa bibliothèque par `import()` dynamique, donc
// sur un tour de boucle ultérieur, pendant que `rapport-report.js` s'exécute
// immédiatement. La conversion partait donc systématiquement sous le défaut
// `denied`, y compris chez un visiteur qui avait accepté des mois plus tôt.
//
// Deux conséquences, aucune visible sans passer par le mode Aperçu :
//   - les balises tierces (Meta) étaient bloquées à CHAQUE conversion, donc
//     jamais déclenchées ;
//   - les balises Google partaient en mode « denied », sans cookie : la
//     conversion remonte, mais son attribution est dégradée.
//
// ---------------------------------------------------------------------------
// POURQUOI UN DÉLAI PLUTÔT QU'UNE ATTENTE FRANCHE
// ---------------------------------------------------------------------------
// Un visiteur qui n'a jamais tranché ne produira JAMAIS de `consent_update` :
// le bandeau attend son clic. Attendre indéfiniment lui coûterait sa
// conversion. On attend donc le signal, ou `DELAI_MAX_CONSENTEMENT`, au
// premier des deux — et au pire on retombe sur le comportement d'avant.

/** Attente maximale du signal de consentement, en millisecondes. */
var DELAI_MAX_CONSENTEMENT = 2000;

/** Intervalle de scrutation du dataLayer. */
var PAS_SCRUTATION_CONSENTEMENT = 50;

/** Vrai si un `consent_update` figure déjà dans le dataLayer. */
function embConsentementConnu() {
  try {
    var file = (typeof window !== "undefined" && window.dataLayer) || [];
    for (var i = 0; i < file.length; i++) {
      if (file[i] && file[i].event === "consent_update") return true;
    }
  } catch (erreur) {
    /* dataLayer illisible : on considère l'état inconnu */
  }
  return false;
}

/**
 * Rend la main dès que le consentement est connu, ou au bout de
 * `DELAI_MAX_CONSENTEMENT`.
 *
 * Scrutation plutôt qu'interception de `dataLayer.push` : Google Tag Manager
 * remplace lui-même cette méthode par la sienne, et s'insérer dans cette
 * chaîne pour une simple lecture reviendrait à risquer de casser toute la
 * mesure pour économiser quelques millisecondes.
 *
 * @returns {Promise<boolean>} vrai si le signal est arrivé, faux si l'on a
 *   renoncé à l'attendre. Ne rejette jamais.
 */
function embAttendreConsentement() {
  return new Promise(function (resolve) {
    if (embConsentementConnu()) return resolve(true);
    if (typeof setTimeout !== "function") return resolve(false);

    var ecoule = 0;
    var minuteur = setInterval(function () {
      ecoule += PAS_SCRUTATION_CONSENTEMENT;
      if (embConsentementConnu()) {
        clearInterval(minuteur);
        resolve(true);
      } else if (ecoule >= DELAI_MAX_CONSENTEMENT) {
        clearInterval(minuteur);
        resolve(false);
      }
    }, PAS_SCRUTATION_CONSENTEMENT);
  });
}

/**
 * Empreinte SHA-256 hexadécimale d'une valeur déjà normalisée.
 *
 * @param {string} valeur
 * @returns {Promise<string>} l'empreinte, ou "" si le calcul est impossible.
 *   Ne rejette jamais.
 */
function embHash(valeur) {
  try {
    var texte = String(valeur === null || valeur === undefined ? "" : valeur);
    if (!texte) return Promise.resolve("");

    var crypto = typeof window !== "undefined" ? window.crypto : null;
    // `crypto.subtle` n'existe que dans un contexte sécurisé (HTTPS, ou
    // localhost). En HTTP, on renvoie "" plutôt que de lever.
    if (!crypto || !crypto.subtle || typeof crypto.subtle.digest !== "function") {
      return Promise.resolve("");
    }
    if (typeof TextEncoder !== "function") return Promise.resolve("");

    var octets = new TextEncoder().encode(texte);

    return Promise.resolve(crypto.subtle.digest("SHA-256", octets)).then(
      function (empreinte) {
        var vue = new Uint8Array(empreinte);
        var hex = "";
        for (var i = 0; i < vue.length; i++) {
          hex += (vue[i] + 0x100).toString(16).slice(1);
        }
        return hex;
      },
      function () {
        return "";
      }
    );
  } catch (erreur) {
    return Promise.resolve("");
  }
}

/**
 * Normalisation Google d'une adresse e-mail : espaces retirés, minuscules.
 *
 * On s'en tient là. Le retrait des points dans les adresses `gmail.com`, que
 * Google documente pour Customer Match, n'est PAS demandé pour les conversions
 * améliorées — l'appliquer produirait une empreinte différente de celle que
 * Google calcule de son côté, donc aucun rapprochement.
 */
function embNormaliserEmail(valeur) {
  var texte = String(valeur === null || valeur === undefined ? "" : valeur).trim().toLowerCase();
  return texte.indexOf("@") > 0 ? texte : "";
}

/**
 * Normalisation d'un numéro de téléphone au format E.164 (`+33612345678`).
 *
 * Google exige ce format, indicatif pays compris. Un `06 12 34 56 78` envoyé
 * tel quel produit une empreinte que rien ne rapprochera jamais — l'échec est
 * silencieux, d'où cette conversion explicite. Le site ne s'adresse qu'à la
 * France (`componentRestrictions: { country: "fr" }` côté Google Places), le
 * `+33` est donc le défaut correct pour un numéro national.
 */
function embNormaliserTelephone(valeur) {
  var brut = String(valeur === null || valeur === undefined ? "" : valeur).trim();
  if (!brut) return "";

  var international = brut.charAt(0) === "+";
  var chiffres = brut.replace(/\D/g, "");
  if (!chiffres) return "";

  if (international) return "+" + chiffres;
  // Préfixe international composé (00 33 …).
  if (chiffres.indexOf("00") === 0) return "+" + chiffres.slice(2);
  // Numéro national français : 0X XX XX XX XX -> +33 X XX XX XX XX.
  if (chiffres.length === 10 && chiffres.charAt(0) === "0") return "+33" + chiffres.slice(1);
  // Déjà sans le 0 initial, indicatif inclus.
  if (chiffres.length === 11 && chiffres.indexOf("33") === 0) return "+" + chiffres;

  // Tout le reste est inexploitable : mieux vaut ne rien envoyer qu'envoyer
  // une empreinte qui ne correspondra à rien.
  return "";
}

/**
 * Bloc `user_data` des conversions améliorées.
 *
 * @param {string} email
 * @param {string} telephone
 * @returns {Promise<Object>} objet d'empreintes, éventuellement vide.
 *   Ne rejette jamais, et rend toujours la main sous `DELAI_MAX_HACHAGE`.
 */
function embUserData(email, telephone) {
  var abandon = new Promise(function (resolve) {
    if (typeof setTimeout === "function") setTimeout(function () { resolve({}); }, DELAI_MAX_HACHAGE);
  });

  var calcul = Promise.all([
    embHash(embNormaliserEmail(email)),
    embHash(embNormaliserTelephone(telephone)),
  ]).then(
    function (empreintes) {
      var donnees = {};
      // Garde-fou de forme, et pas de la coquetterie : si une valeur en clair
      // arrivait ici par erreur de câblage, elle ne ressemblerait pas à une
      // empreinte et serait écartée avant d'atteindre le dataLayer.
      if (MOTIF_EMPREINTE.test(empreintes[0])) donnees.sha256_email_address = empreintes[0];
      if (MOTIF_EMPREINTE.test(empreintes[1])) donnees.sha256_phone_number = empreintes[1];
      return donnees;
    },
    function () {
      return {};
    }
  );

  return Promise.race([calcul, abandon]);
}

/**
 * Type de page, pour qualifier les clics sortants.
 *
 * Un attribut `data-page-type` posé dans le HTML l'emporte toujours : les
 * pages région/département et les fiches partenaires du CMS (cf.
 * `specs/cms-seo-tracking.md`, lots 1 et 2) n'existent pas encore, et le jour
 * où elles arriveront, elles déclareront leur type plutôt que de faire grossir
 * la table ci-dessous.
 *
 * @param {string} [chemin] défaut : `location.pathname`
 * @returns {string}
 */
function embPageType(chemin) {
  var url = chemin;
  if (url === undefined || url === null) {
    url = typeof window !== "undefined" && window.location ? window.location.pathname : "";
  }

  // `trailingSlash: 'always'` (astro.config.mjs) : on normalise des deux côtés
  // plutôt que d'en dépendre.
  var normalise = String(url).replace(/\/+$/, "");
  if (normalise === "") return "accueil";

  var segments = normalise.split("/").filter(function (segment) {
    return segment !== "";
  });

  var racine = segments[0];

  if (racine === "partenaires") {
    return segments.length > 1 ? "partenaire_detail" : "partenaires_index";
  }
  if (racine === "estimation") return "estimation";
  if (racine === "rapport") return "rapport";
  if (racine === "carte") return "carte";
  if (racine === "contact") return "contact";
  if (racine === "pages") return "page_libre";

  return "autre";
}

// ============================================================================
// 4. OUTILS DOM — minimum vital, sans dépendance
// ============================================================================

/**
 * Remonte depuis `element` le premier ancêtre (lui compris) portant `attribut`.
 *
 * `Element.closest()` ferait l'affaire, mais on remonte à la main parce que la
 * cible d'un clic peut être un nœud texte ou un `<svg>` — dont les
 * implémentations anciennes n'exposent ni `closest` ni `matches`. Un CTA qui
 * n'est pas compté parce que le visiteur a cliqué pile sur l'icône est
 * exactement le genre de trou qu'on ne détecte jamais.
 */
function embAncetreAvec(element, attribut) {
  var noeud = element;
  while (noeud) {
    if (typeof noeud.getAttribute === "function") {
      var valeur = noeud.getAttribute(attribut);
      if (valeur !== null && valeur !== undefined) return noeud;
    }
    noeud = noeud.parentNode;
  }
  return null;
}

/** Valeur d'attribut nettoyée, "" si absente. */
function embAttribut(element, nom) {
  if (!element || typeof element.getAttribute !== "function") return "";
  var valeur = element.getAttribute(nom);
  return valeur === null || valeur === undefined ? "" : String(valeur).trim();
}

/** Libellé lisible d'un élément cliquable, borné en longueur. */
function embLibelle(element) {
  var explicite = embAttribut(element, "data-cta-label");
  if (explicite) return explicite.slice(0, LONGUEUR_MAX_LIBELLE);

  var texte = element && element.textContent ? String(element.textContent) : "";
  texte = texte.replace(/\s+/g, " ").trim();
  return texte.slice(0, LONGUEUR_MAX_LIBELLE);
}

/** Chemin de la page courante, barre finale retirée pour l'homogénéité des rapports. */
function embCheminCourant() {
  if (typeof window === "undefined" || !window.location) return "";
  var chemin = String(window.location.pathname || "");
  return chemin !== "/" ? chemin.replace(/\/+$/, "") : "/";
}

// ============================================================================
// 5. DÉLÉGATION DES CLICS — un seul écouteur pour tout le site
// ============================================================================
//
// Un écouteur unique posé sur `document`, plutôt qu'un écouteur par bouton :
// les CTA sont répartis sur six pages et deux composants partagés, et la barre
// collée est injectée après le chargement. Une délégation couvre tout, y
// compris ce qui n'existe pas encore au moment où le script s'exécute.
//
// CE QUI EST INTERDIT ICI, ET POURQUOI
// Pas de `preventDefault()`, pas de `setTimeout` avant la navigation, aucune
// attente d'accusé de réception. Un lien partenaire doit s'ouvrir exactement
// comme si ce fichier n'existait pas (contrat de `specs/cms-seo-tracking.md`
// §6). Retarder une navigation de 300 ms « pour être sûr que le tag est parti »
// est un compromis qu'on refuse : c'est le visiteur qui paierait la mesure.

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener(
    "click",
    function (evenement) {
      try {
        var cible = evenement && evenement.target;
        if (!cible) return;

        var partenaire = embAncetreAvec(cible, "data-partner-slug");
        if (partenaire) {
          embSuivreClicPartenaire(partenaire);
          return;
        }

        var cta = embAncetreAvec(cible, "data-cta");
        if (cta) embSuivreClicCta(cta);
      } catch (erreur) {
        /* voir l'en-tête, règle 2 */
      }
    },
    // Capture : l'événement est observé avant qu'un gestionnaire de la page ne
    // puisse l'arrêter par `stopPropagation()`. Passif : cet écouteur
    // n'appellera jamais `preventDefault()`, autant le déclarer au navigateur.
    { capture: true, passive: true }
  );
}

/** Clic sur un lien partenaire sortant (plan §4.4). */
function embSuivreClicPartenaire(element) {
  var position = parseInt(embAttribut(element, "data-partner-position"), 10);
  var conteneurType = embAncetreAvec(element, "data-page-type");

  embTrack("partner_click_out", {
    partner_slug: embAttribut(element, "data-partner-slug"),
    partner_name: embAttribut(element, "data-partner-name"),
    partner_category: embAttribut(element, "data-partner-category"),
    page_type: conteneurType
      ? embAttribut(conteneurType, "data-page-type")
      : embPageType(),
    page_path: embCheminCourant(),
    link_url: embAttribut(element, "href"),
    position: isFinite(position) && position > 0 ? position : undefined,
  });
}

/** Clic sur un appel à l'action interne (plan §4.4). */
function embSuivreClicCta(element) {
  embTrack("cta_click", {
    cta_id: embAttribut(element, "data-cta"),
    cta_label: embLibelle(element),
    cta_destination: embAttribut(element, "href"),
    page_path: embCheminCourant(),
  });
}
