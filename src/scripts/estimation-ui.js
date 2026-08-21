// ============================================================================
// ESTIMATION UI — câblage DOM du wizard (Google Places, toggles, soumission)
// ============================================================================
//
// Ce fichier est injecté tel quel (voir `RawScript.astro`, `<script
// is:inline>` à partir d'un import `?raw`) en dernier, après
// `google-places.js`, `estimation-wizard.js` puis `estimation-api.js` : il
// consomme les globales exposées par ces derniers (`parseGooglePlace`,
// `loadGoogleMapsScript`, `parseAddressQuery`, `createWizard`,
// `isFieldVisible`, `buildEstimationApiPayload`, `requestEstimation`,
// `mapApiResultToLegacyEstimation`, `resolveEstimationStatus`...) sans jamais
// réécrire leur logique — en particulier, la conditionnalité d'affichage
// (US-5, US-8) n'est PAS redéclarée ici : `computeConditionalVisibility()`
// délègue à `isFieldVisible()` (unique source de vérité, cf.
// `estimation-wizard.js` §1bis). Comme `estimation-wizard.js`, PAS de
// `import`/`export` : tout vit dans la portée globale. Les tests de ce
// fichier (`scripts/test-estimation-ui.mjs`) chargent donc systématiquement
// `estimation-wizard.js` dans le même contexte `vm` avant lui.
//
// Le fichier est structuré en deux parties :
// 1. Des fonctions pures (ne touchent ni au DOM ni au réseau), déclarées au
//    premier niveau, testées indépendamment dans
//    `scripts/test-estimation-ui.mjs` avec la même technique `vm` que pour
//    `estimation-wizard.js`.
// 2. Le câblage DOM proprement dit, entièrement protégé par
//    `typeof document !== "undefined"` : ceci le rend sûr à exécuter dans le
//    contexte Node du script de test (rien ne s'exécute au-delà de la
//    déclaration des fonctions pures), et défensif si jamais ce script était
//    chargé sur une page sans `#estimationForm`.

// ============================================================================
// 1. FONCTIONS PURES
// ============================================================================

/**
 * Détermine la visibilité des champs conditionnels de l'étape 2 (terrain) et
 * de l'étape 3 (devis DPE / CTA RITMODiag), à partir des seules données du
 * wizard. Fonction pure, réutilisée par `syncConditionalVisibility()` pour
 * appliquer effectivement ces règles au DOM (US-5, US-8).
 *
 * `showTerrainQuestion`/`showTerrainSize`/`showDpeRequest` sont dérivés de
 * `isFieldVisible()` (source unique de vérité, déclarée dans
 * `estimation-wizard.js` à partir de `WIZARD_STEPS[].conditionalFields`) —
 * cette fonction ne redéfinit PAS ces règles métier. Seul `showRitmodiagCta`
 * est propre à l'UI : le CTA RITMODiag n'est pas un champ de `WizardData`
 * (rien à réinitialiser en cascade), donc aucune règle équivalente n'existe
 * côté wizard à dupliquer.
 *
 * @param {object} data `wizard.state.data`
 * @returns {{showTerrainQuestion:boolean, showTerrainSize:boolean, showDpeRequest:boolean, showRitmodiagCta:boolean, showFloor:boolean, showElevator:boolean, showOutdoor:boolean, showCondition:boolean, showOptionalDetails:boolean}}
 */
function computeConditionalVisibility(data) {
  var d = data || {};
  var showFloor = isFieldVisible("floor", d);
  var showElevator = isFieldVisible("hasElevator", d);
  var showOutdoor = isFieldVisible("outdoor", d);
  var showCondition = isFieldVisible("condition", d);

  return {
    showTerrainQuestion: isFieldVisible("hasTerrain", d),
    showTerrainSize: isFieldVisible("terrainSize", d),
    showDpeRequest: isFieldVisible("dpeRequest", d),
    showRitmodiagCta: d.dpeRequest === "yes",
    // Précisions facultatives de l'étape 3 : mêmes règles, même source unique
    // de vérité (`WIZARD_STEPS[].conditionalFields`). Rien n'est redéclaré ici.
    showFloor: showFloor,
    showElevator: showElevator,
    showOutdoor: showOutdoor,
    showCondition: showCondition,
    // Le conteneur (et sa phrase d'aide) disparaît si aucun de ses champs
    // n'est affiché — cas d'un terrain nu ou d'un local commercial.
    showOptionalDetails: showFloor || showElevator || showOutdoor || showCondition,
  };
}

/**
 * Champs d'étape 1 à 4 dont la `.value` DOM doit être reportée depuis
 * `wizard.state.data` après un `wizard.restore()` (US-6). N'inclut jamais
 * name/email/phone (étape 5, non persistée — cf. `getPersistableFieldNames`
 * côté estimation-wizard.js) : après un refresh, ces champs restent vides
 * par construction, il n'y a donc rien à réhydrater pour eux.
 */
var HYDRATABLE_FIELD_IDS = [
  "address",
  "postalCode",
  "city",
  "propertyType",
  "hasTerrain",
  "terrainSize",
  "surface",
  "rooms",
  "dpe",
  "dpeRequest",
  "floor",
  "hasElevator",
  "outdoor",
  "condition",
  "isOwner",
  "wantToSell",
];

/**
 * Calcule, à partir de l'état restauré (`wizard.state.data`), CE QUI doit
 * être réaffiché dans le DOM après `wizard.restore()` — fonction pure, ne
 * touche jamais au DOM elle-même. `hydrateFieldsFromState()` (câblage DOM,
 * plus bas) applique ce plan aux éléments réels.
 *
 * Corrige le bug relevé en revue QA : sans réhydratation, un refresh en
 * cours de parcours (US-6) laisse les `<input>`/`<select>` visuellement
 * vides bien que `state.data` contienne déjà les valeurs saisies — et
 * `getSelectedOptionText()` (utilisée à la soumission pour le corps de
 * l'email EmailJS) lit alors le libellé par défaut ("Sélectionnez un
 * type...") au lieu du vrai type de bien.
 *
 * §0 des specs (ne jamais nettoyer/réécrire `#address` pendant la saisie)
 * n'est pas concerné ici : on restitue la chaîne brute déjà stockée telle
 * quelle, après un rechargement complet où aucune saisie n'est en cours.
 *
 * @param {object} data `wizard.state.data`
 * @returns {{
 *   fieldValues: Record<string,string>,
 *   showRecap: boolean,
 *   showManual: boolean,
 *   recapPostal: string,
 *   recapCity: string,
 * }}
 */
function computeHydrationPlan(data) {
  var d = data || {};
  var fieldValues = {};

  HYDRATABLE_FIELD_IDS.forEach(function (id) {
    if (d[id] !== undefined) fieldValues[id] = d[id];
  });

  var hasPostalCode = !!(d.postalCode && String(d.postalCode).trim());
  var hasCity = !!(d.city && String(d.city).trim());

  // Le récapitulatif ne doit revenir que si l'adresse restaurée provient
  // bien d'une sélection Google (US-2) ; sinon, si des valeurs manuelles
  // existent, on rouvre directement le bloc éditable plutôt que de prétendre
  // à un récapitulatif "validé" qui ne l'a jamais été (US-3).
  var showRecap = d.addressSource === "autocomplete" && hasPostalCode && hasCity;
  var showManual = !showRecap && (hasPostalCode || hasCity);

  return {
    fieldValues: fieldValues,
    showRecap: showRecap,
    showManual: showManual,
    recapPostal: d.postalCode || "",
    recapCity: d.city || "",
  };
}

/**
 * Compare deux saisies d'adresse « à l'œil humain » : casse, espaces
 * multiples et espaces de bord ignorés. Fonction pure.
 *
 * Sert à décider, quand une adresse arrive par l'URL (formulaire de la page
 * d'accueil), si elle poursuit le parcours restauré depuis sessionStorage ou
 * si elle en démarre un nouveau — auquel cas le wizard doit repartir de
 * l'étape 1 plutôt que de reprendre à l'étape où l'utilisateur s'était
 * arrêté pour un AUTRE bien.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isSameAddressInput(a, b) {
  function normalize(value) {
    return String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  }
  return normalize(a) === normalize(b);
}

/**
 * Ajoute `payload` à `database` sans muter le tableau d'origine. Utilisée par
 * `persistEstimation()` avant écriture dans `localStorage.estimationDatabase`.
 *
 * @param {Array<object>} database
 * @param {object} payload
 * @returns {Array<object>}
 */
function appendToDatabase(database, payload) {
  var next = Array.isArray(database) ? database.slice() : [];
  next.push(payload);
  return next;
}

/**
 * Bandeau d'avertissement placé en tête de l'e-mail interne quand
 * l'estimation n'a PAS été calculée par l'API (§2.4, étape 3). Le lead doit
 * être traité manuellement : la mention est explicite, en majuscules, et
 * placée avant tout le reste pour ne pas passer inaperçue.
 *
 * @param {string} estimationStatus 'ok' | 'deferred' | 'static-fallback'
 * @returns {string} bloc de texte (vide si l'estimation est nominale)
 */
function buildEmailDegradedNotice(estimationStatus) {
  if (estimationStatus === "deferred") {
    return `/!\\ ESTIMATION NON CALCULEE (API indisponible)
L'API d'estimation n'a pas repondu : aucune valeur n'a ete produite ni
affichee au client. A traiter manuellement.

`;
  }

  if (estimationStatus === "static-fallback") {
    return `/!\\ ESTIMATION NON CALCULEE (API indisponible) - MODE DEGRADE
L'API d'estimation n'a pas repondu. Le montant ci-dessous provient du calcul
de repli interne : il n'est PAS fonde sur les transactions reelles (DVF) et
a ete presente au client comme une estimation indicative. A recalculer.

`;
  }

  return "";
}

/**
 * Construit les `templateParams` EmailJS à partir du payload de soumission
 * (`wizard.serializeForSubmit(estimation)`, cf. specs §3.2). Le corps du
 * message (`message`) reproduit le gabarit de l'ancien `estimation.js` —
 * non-régression stricte du contenu — enrichi de deux ajouts du Lot 3 :
 * la mention de mode dégradé en tête (§2.4) et les précisions facultatives
 * de l'étape 3 lorsqu'elles sont renseignées.
 *
 * @param {object} payload cf. `buildSubmitPayload` dans estimation-wizard.js
 * @param {{propertyTypeText?:string, dpeText?:string, toEmail?:string}} [options]
 *   Libellés lisibles des `<select>` (texte de l'option sélectionnée), à
 *   fournir par l'appelant (DOM), et adresse de destination.
 * @returns {{from_name:string, from_email:string, phone:string, subject:string, message:string, to_email:string|undefined}}
 */
function buildEmailTemplateParams(payload, options) {
  var opts = options || {};
  var p = payload || {};
  var propertyTypeText = opts.propertyTypeText || p.propertyType;
  var dpeText = opts.dpeText || p.dpe;
  var estimation = p.estimation || {};
  var estimationStatus = p.estimationStatus || "ok";

  // Précisions facultatives : uniquement celles réellement renseignées, pour
  // ne pas allonger l'e-mail avec une liste de « non renseigné ».
  var optionalLines = "";
  if (p.floor !== undefined && p.floor !== null && String(p.floor) !== "") {
    optionalLines += `
- Etage : ${p.floor}`;
  }
  if (p.hasElevator) {
    optionalLines += `
- Ascenseur : ${
      p.hasElevator === "yes" ? "Oui" : p.hasElevator === "no" ? "Non" : "Ne sait pas"
    }`;
  }
  if (p.outdoor) {
    optionalLines += `
- Exterieur : ${
      p.outdoor === "balcony"
        ? "Balcon"
        : p.outdoor === "terrace"
        ? "Terrasse"
        : p.outdoor === "garden"
        ? "Jardin privatif"
        : "Aucun"
    }`;
  }
  if (p.condition) {
    optionalLines += `
- Etat general : ${
      p.condition === "to-renovate"
        ? "A renover"
        : p.condition === "fair"
        ? "Correct"
        : p.condition === "good"
        ? "Bon"
        : p.condition === "new"
        ? "Refait a neuf"
        : p.condition
    }`;
  }

  var message = `${buildEmailDegradedNotice(estimationStatus)}NOUVELLE DEMANDE D'ESTIMATION

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

INFORMATIONS DU BIEN
- Type de bien : ${propertyTypeText}
- Adresse : ${p.address}
- Code postal : ${p.postalCode}
- Ville : ${p.city}
- Surface : ${p.surface} m²
- Nombre de pieces : ${p.rooms}${
    p.propertyType === "maison"
      ? `
- Terrain : ${p.hasTerrain === "yes" ? "Oui" : "Non"}${
          p.hasTerrain === "yes" && p.terrainSize
            ? `
- Surface du terrain : ${p.terrainSize} m²`
            : ""
        }`
      : ""
  }
- DPE : ${dpeText}
- Souhaite un DPE : ${p.dpeRequest === "yes" ? "Oui" : "Non"}${optionalLines}

SITUATION DU DEMANDEUR
- Proprietaire : ${p.isOwner === "yes" ? "Oui" : "Non"}
- Souhaite vendre : ${
    p.wantToSell === "yes" ? "Oui" : p.wantToSell === "maybe" ? "Peut-etre" : "Non"
  }

ESTIMATION CALCULEE
- Prix au m² : ${estimation.prixM2 != null ? estimation.prixM2.toLocaleString("fr-FR") : ""} €
- Estimation basse : ${estimation.estimationMin != null ? estimation.estimationMin.toLocaleString("fr-FR") : ""} €
- Estimation moyenne : ${estimation.estimationMoyenne != null ? estimation.estimationMoyenne.toLocaleString("fr-FR") : ""} €
- Estimation haute : ${estimation.estimationMax != null ? estimation.estimationMax.toLocaleString("fr-FR") : ""} €
- Source du calcul : ${
    estimationStatus === "ok"
      ? "API estimer.co (transactions reelles)" +
        (estimation.confidence && estimation.confidence.score != null
          ? ", confiance " + estimation.confidence.score + "/100"
          : "") +
        (estimation.method && estimation.method.comparablesCount != null
          ? ", " + estimation.method.comparablesCount + " comparables"
          : "")
      : estimationStatus === "static-fallback"
      ? "REPLI INTERNE (hors DVF) - API indisponible"
      : "AUCUNE - API indisponible"
  }

COORDONNEES DU CLIENT
- Nom : ${p.name}
- Email : ${p.email}
- Telephone : ${p.phone}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  return {
    from_name: p.name,
    from_email: p.email,
    phone: p.phone,
    subject: "Nouvelle demande d'estimation immobiliere",
    message: message,
    to_email: opts.toEmail,
  };
}

/** Texte affiché de l'option actuellement sélectionnée d'un <select>, "" si absent. */
function getSelectedOptionText(id) {
  if (typeof document === "undefined") return "";
  var select = document.getElementById(id);
  if (!select || typeof select.selectedIndex !== "number") return "";
  var option = select.options[select.selectedIndex];
  return option ? option.text : "";
}

// ============================================================================
// 2. CÂBLAGE DOM — protégé, ne s'exécute que si #estimationForm existe
// ============================================================================

var estimationFormEl =
  typeof document !== "undefined" ? document.getElementById("estimationForm") : null;

if (estimationFormEl) {
  // --------------------------------------------------------------------
  // EmailJS — initialisation défensive (un bloqueur de pub peut empêcher le
  // CDN de charger ; on ne veut pas qu'une ReferenceError sur `emailjs` casse
  // tout le reste du wizard).
  // --------------------------------------------------------------------
  if (typeof emailjs !== "undefined" && typeof CONFIG !== "undefined" && CONFIG.EMAILJS) {
    emailjs.init(CONFIG.EMAILJS.PUBLIC_KEY);
  }

  var wizard = createWizard(estimationFormEl);

  // ====================================================================
  // MESURE DU TUNNEL — specs/plan-taggage-conversions.md §4.2
  // ====================================================================
  //
  // `tracking.js` n'est injecté que si un conteneur de tags est configuré
  // (cf. `Tracking.astro`) : tout passe donc par les relais ci-dessous, qui
  // sont inertes en son absence. Les appeler sans garde ferait lever une
  // `ReferenceError` au milieu d'une soumission — soit un lead perdu pour une
  // mesure manquante, l'exact inverse du but recherché.
  //
  // LE WIZARD N'EST PAS TOUCHÉ. Il ignore l'API (cf. son en-tête) ; il ignore
  // tout autant la mesure. C'est la couche d'affichage, qui possède déjà le
  // DOM et l'orchestration, qui observe — et `scripts/test-estimation-wizard.mjs`
  // reste valable sans modification.

  var mesureChargee = typeof embTrack === "function";

  function mesurer(nom, params) {
    if (mesureChargee) embTrack(nom, params);
  }

  function departementDe(codePostal) {
    return mesureChargee ? embDepartement(codePostal) : "";
  }

  function trancheSurface(surface) {
    return mesureChargee ? embSurfaceBucket(surface) : "";
  }

  function qualiteLead(isOwner, wantToSell) {
    return mesureChargee ? embLeadQuality(isOwner, wantToSell) : "";
  }

  function nouvelIdentifiantLead() {
    return mesureChargee ? embLeadId() : "";
  }

  /** Clé lisible d'une étape (`address`, `property`…), "" si inconnue. */
  function cleEtape(id) {
    if (typeof WIZARD_STEPS === "undefined") return "";
    for (var i = 0; i < WIZARD_STEPS.length; i++) {
      if (WIZARD_STEPS[i].id === id) return WIZARD_STEPS[i].key;
    }
    return "";
  }

  // `mesureActive` reste faux pendant toute la séquence d'initialisation
  // (restauration + pré-remplissage depuis l'URL), qui peut appeler `next()`
  // et `goToStep()` plusieurs fois. Sans ce verrou, un visiteur arrivant de
  // l'accueil produirait deux ou trois `estimation_step_view` avant même
  // d'avoir vu quoi que ce soit — un entonnoir qui compte des étapes que
  // personne n'a franchies ne mesure plus rien.
  var mesureActive = false;
  var etapeSuivie = 0;
  var adresseSuivie = false;
  var leadId = "";
  var debutSoumission = 0;

  function suivreEtape() {
    if (!mesureActive) return;

    var etape = wizard.state.currentStep;
    if (etape === etapeSuivie) return;

    var precedente = etapeSuivie;
    etapeSuivie = etape;

    // L'étape 1 ne se franchit qu'une fois l'adresse validée : la quitter
    // vers l'avant, c'est exactement l'instant où elle l'est. Mesurer ici
    // plutôt que dans le rappel `place_changed` de Google couvre d'un seul
    // point les deux chemins — suggestion retenue ET saisie manuelle.
    if (!adresseSuivie && precedente === 1 && etape > 1) {
      adresseSuivie = true;
      mesurer("estimation_address_selected", {
        address_source: wizard.state.data.addressSource || "manual",
        postal_code: wizard.state.data.postalCode,
        city: wizard.state.data.city,
        departement_code: departementDe(wizard.state.data.postalCode),
      });
    }

    var direction;
    if (precedente === 0) direction = etape > 1 ? "restore" : "forward";
    else direction = etape > precedente ? "forward" : "backward";

    mesurer("estimation_step_view", {
      step_number: etape,
      step_key: cleEtape(etape),
      step_direction: direction,
    });
  }

  // Observation par enveloppe des quatre méthodes qui déplacent l'étape
  // affichée, plutôt qu'un appel après chacun de leurs six sites d'appel.
  // Ce n'est pas de l'élégance : un site d'appel ajouté plus tard et oublié
  // creuserait un trou dans l'entonnoir, et un trou dans un entonnoir ne se
  // voit pas — on lit simplement de mauvais taux d'abandon pendant des mois.
  ["next", "prev", "goToStep", "setErrors"].forEach(function (nom) {
    var original = wizard[nom];
    wizard[nom] = function () {
      var resultat = original.apply(wizard, arguments);

      // `next()` ne renvoie `false` que sur un échec de validation : c'est le
      // seul point du wizard où l'on sait qu'un champ a bloqué le visiteur.
      if (nom === "next" && resultat === false) {
        var champs = Object.keys(wizard.state.errors || {});
        mesurer("estimation_step_error", {
          step_number: wizard.state.currentStep,
          step_key: cleEtape(wizard.state.currentStep),
          // Des NOMS de champs, jamais leur contenu ni les messages affichés.
          error_fields: champs.join("|"),
          error_count: champs.length,
        });
      }

      suivreEtape();
      return resultat;
    };
  });

  // --------------------------------------------------------------------
  // Références DOM (déclarées avant tout câblage : `hydrateFieldsFromState`
  // et les fonctions ci-dessous en ont besoin dès l'initialisation).
  // --------------------------------------------------------------------
  var addressInputEl = document.getElementById("address");
  var postalCodeInputEl = document.getElementById("postalCode");
  var cityInputEl = document.getElementById("city");
  var addressRecapEl = document.getElementById("addressRecap");
  var addressRecapPostalEl = document.getElementById("addressRecapPostal");
  var addressRecapCityEl = document.getElementById("addressRecapCity");
  var addressRecapEditEl = document.getElementById("addressRecapEdit");
  var addressManualEl = document.getElementById("addressManual");

  var hasTerrainGroupEl = document.getElementById("hasTerrainGroup");
  var terrainSizeGroupEl = document.getElementById("terrainSizeGroup");
  var dpeRequestGroupEl = document.getElementById("dpeRequestGroup");
  var ritmodiagLinkEl = document.getElementById("ritmodiagLink");

  var optionalDetailsGroupEl = document.getElementById("optionalDetailsGroup");
  var floorGroupEl = document.getElementById("floorGroup");
  var hasElevatorGroupEl = document.getElementById("hasElevatorGroup");
  var outdoorGroupEl = document.getElementById("outdoorGroup");
  var conditionGroupEl = document.getElementById("conditionGroup");

  var submitStatusEl = document.getElementById("wizardSubmitStatus");
  var submitStatusTextEl = document.getElementById("wizardSubmitStatusText");
  var wizardAlertEl = document.querySelector(".wizard-alert");

  var prevBtn = document.getElementById("wizardPrev");
  var nextBtn = document.getElementById("wizardNext");

  // --------------------------------------------------------------------
  // Étape 1 — adresse : autocomplete, récapitulatif, repli manuel (US-2/US-3)
  // --------------------------------------------------------------------
  function applyParsedAddress(parsed) {
    wizard.updateField("postalCode", parsed.postalCode);
    wizard.updateField("city", parsed.city);
    wizard.updateField("placeId", parsed.placeId);
    wizard.updateField("addressSource", "autocomplete");

    if (postalCodeInputEl) postalCodeInputEl.value = parsed.postalCode;
    if (cityInputEl) cityInputEl.value = parsed.city;

    if (addressRecapPostalEl) {
      addressRecapPostalEl.textContent = parsed.postalCode || "Non renseigné";
    }
    if (addressRecapCityEl) addressRecapCityEl.textContent = parsed.city || "Non renseignée";
    if (addressRecapEl) addressRecapEl.hidden = false;
    if (addressManualEl) addressManualEl.hidden = true;
  }

  /** Révèle le bloc CP/ville manuel, sauf si une adresse valide est déjà affichée dans le récapitulatif. */
  function ensureAddressManualFallback() {
    if (!addressManualEl) return;
    if (addressRecapEl && !addressRecapEl.hidden) return;
    addressManualEl.hidden = false;
  }

  // Widget Google Places (US-2) — déclaré dans ce même bloc (et non au
  // premier niveau du fichier) pour rester dans la portée de `wizard` et des
  // helpers ci-dessus, tout en étant explicitement republié sur `window`
  // juste en dessous : c'est ce nom global que Google appelle via le
  // paramètre `callback=initAutocomplete` de l'URL du script (cf.
  // `loadGoogleMapsAPI` plus bas).
  var googleMapsReady = false;
  var autocompleteInstance = null;

  function initAutocomplete() {
    googleMapsReady = true;

    if (!addressInputEl || typeof google === "undefined" || !google.maps || !google.maps.places) {
      return;
    }

    autocompleteInstance = new google.maps.places.Autocomplete(addressInputEl, {
      types: ["address"],
      componentRestrictions: { country: "fr" },
    });

    autocompleteInstance.addListener("place_changed", function () {
      var place = autocompleteInstance.getPlace();
      var parsed = parseGooglePlace(place);

      if (!parsed) {
        // US-3 : pas de address_components exploitables -> repli manuel.
        ensureAddressManualFallback();
        return;
      }

      applyParsedAddress(parsed);
    });
  }

  window.initAutocomplete = initAutocomplete;

  // --------------------------------------------------------------------
  // Champs conditionnels — étape 2 (terrain) et étape 3 (devis DPE) — US-5/US-8
  // --------------------------------------------------------------------
  function syncConditionalVisibility() {
    var visibility = computeConditionalVisibility(wizard.state.data);

    if (hasTerrainGroupEl) hasTerrainGroupEl.hidden = !visibility.showTerrainQuestion;
    if (terrainSizeGroupEl) terrainSizeGroupEl.hidden = !visibility.showTerrainSize;
    if (dpeRequestGroupEl) dpeRequestGroupEl.hidden = !visibility.showDpeRequest;
    if (ritmodiagLinkEl) ritmodiagLinkEl.hidden = !visibility.showRitmodiagCta;

    // Miroir DOM des champs masqués (le wizard a déjà réinitialisé la donnée
    // via applyConditionalResets ; on aligne le <select>/<input> visible).
    var hasTerrainSelect = document.getElementById("hasTerrain");
    if (hasTerrainSelect && !visibility.showTerrainQuestion) hasTerrainSelect.value = "";

    var terrainSizeInput = document.getElementById("terrainSize");
    if (terrainSizeInput && !visibility.showTerrainSize) terrainSizeInput.value = "";

    var dpeRequestSelect = document.getElementById("dpeRequest");
    if (dpeRequestSelect && !visibility.showDpeRequest) dpeRequestSelect.value = "";

    // Précisions facultatives de l'étape 3 (§7.1).
    if (floorGroupEl) floorGroupEl.hidden = !visibility.showFloor;
    if (hasElevatorGroupEl) hasElevatorGroupEl.hidden = !visibility.showElevator;
    if (outdoorGroupEl) outdoorGroupEl.hidden = !visibility.showOutdoor;
    if (conditionGroupEl) conditionGroupEl.hidden = !visibility.showCondition;
    if (optionalDetailsGroupEl) {
      optionalDetailsGroupEl.hidden = !visibility.showOptionalDetails;
    }

    ["floor", "hasElevator", "outdoor", "condition"].forEach(function (id) {
      var visibleKey = {
        floor: "showFloor",
        hasElevator: "showElevator",
        outdoor: "showOutdoor",
        condition: "showCondition",
      }[id];
      var el = document.getElementById(id);
      if (el && !visibility[visibleKey]) el.value = "";
    });
  }

  // --------------------------------------------------------------------
  // Réhydratation DOM après restore() (US-6, correctif QA) — DOM-dépendant :
  // applique le `computeHydrationPlan()` pur ci-dessus aux éléments réels.
  // --------------------------------------------------------------------
  function hydrateFieldsFromState() {
    var plan = computeHydrationPlan(wizard.state.data);

    Object.keys(plan.fieldValues).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = plan.fieldValues[id];
    });

    if (plan.showRecap) {
      if (addressRecapPostalEl) addressRecapPostalEl.textContent = plan.recapPostal;
      if (addressRecapCityEl) addressRecapCityEl.textContent = plan.recapCity;
      if (addressRecapEl) addressRecapEl.hidden = false;
      if (addressManualEl) addressManualEl.hidden = true;
    } else if (plan.showManual) {
      if (addressManualEl) addressManualEl.hidden = false;
    }

    syncConditionalVisibility();
  }

  // --------------------------------------------------------------------
  // Séquence d'initialisation : restaure l'état AVANT tout câblage de
  // listener, puis réhydrate immédiatement le DOM (correctif QA — sans quoi
  // un refresh en cours de parcours affiche des champs vides malgré un
  // `state.data` déjà rempli, et corrompt le libellé envoyé par email via
  // `getSelectedOptionText`).
  // --------------------------------------------------------------------
  wizard.restore();

  // --------------------------------------------------------------------
  // Pré-remplissage depuis l'URL — le formulaire d'adresse du hero de la page
  // d'accueil pointe sur `/estimation/?address=...&postalCode=...&city=...`
  // (cf. `home-address.js`). Ces valeurs priment sur l'état restauré : elles
  // traduisent une intention explicite et immédiate de l'utilisateur, là où
  // sessionStorage ne restitue qu'un parcours interrompu.
  // --------------------------------------------------------------------
  var addressPrefill =
    typeof parseAddressQuery === "function" && typeof window !== "undefined"
      ? parseAddressQuery(window.location.search)
      : null;
  var prefillStartsNewAddress = false;

  if (addressPrefill) {
    prefillStartsNewAddress = !isSameAddressInput(
      addressPrefill.address,
      wizard.state.data.address
    );
    wizard.updateField("address", addressPrefill.address);
    wizard.updateField("postalCode", addressPrefill.postalCode);
    wizard.updateField("city", addressPrefill.city);
    wizard.updateField("placeId", ""); // non transmis par l'URL (debug/QA uniquement).
    wizard.updateField("addressSource", addressPrefill.addressSource);
  }

  hydrateFieldsFromState();

  if (addressPrefill) {
    // Adresse différente de celle du parcours restauré : c'est un nouveau
    // bien, on repart de l'étape 1 plutôt que de rouvrir l'étape 4 d'un
    // parcours qui portait sur autre chose.
    if (prefillStartsNewAddress) wizard.goToStep(1);

    if (wizard.state.currentStep === 1) {
      if (wizard.validateStep(1, wizard.state.data).valid) {
        // Adresse issue d'une suggestion Google : code postal et ville sont
        // connus, l'étape 1 n'a plus rien à demander. `next()` la valide,
        // ouvre l'étape 2, met à jour maxStepReached, persiste et pose le
        // focus sur le titre de la nouvelle étape.
        wizard.next();
      } else {
        // Adresse saisie librement sur l'accueil (pas de suggestion, ou
        // Google indisponible) : on ouvre tout de suite le bloc CP/ville
        // plutôt que d'attendre un `blur` sur un champ que l'utilisateur n'a
        // aucune raison de venir toucher.
        ensureAddressManualFallback();
      }
    }

    // L'URL a joué son rôle : on la nettoie pour qu'un rafraîchissement
    // ultérieur ne réécrase pas une adresse corrigée entre-temps.
    if (window.history && typeof window.history.replaceState === "function") {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }

  // --------------------------------------------------------------------
  // Ouverture de la mesure — l'état d'arrivée est enfin stabilisé
  // --------------------------------------------------------------------
  //
  // `estimation_start` marque l'entrée dans le tunnel, et `suivreEtape()` qui
  // suit émet le premier `estimation_step_view` sur l'étape RÉELLEMENT
  // affichée : la 2 pour qui arrive de l'accueil avec une adresse complète, la
  // 1 pour une visite directe, la n-ième pour un parcours restauré.
  (function ouvrirLaMesure() {
    var entree;
    if (addressPrefill) entree = "home_hero";
    else if (wizard.state.currentStep > 1) entree = "restored";
    else if (estimationVientDuSite()) entree = "cta";
    else entree = "direct";

    mesureActive = true;

    mesurer("estimation_start", {
      entry_point: entree,
      has_address_prefill: Boolean(addressPrefill),
    });

    suivreEtape();
  })();

  /**
   * Vrai si le visiteur arrive d'une autre page du site.
   *
   * On ne cherche pas à savoir QUEL bouton a été cliqué — c'est le rôle de
   * `cta_click`, qui porte l'identifiant exact de l'emplacement. Ici on ne
   * sépare que deux populations : celle qui a navigué et celle qui atterrit
   * directement (annonce, favori, lien partagé).
   */
  function estimationVientDuSite() {
    if (typeof document === "undefined" || !document.referrer) return false;
    try {
      return new URL(document.referrer).origin === window.location.origin;
    } catch (erreur) {
      return false;
    }
  }

  // --------------------------------------------------------------------
  // Câblage des listeners — étape 1 (adresse)
  // --------------------------------------------------------------------
  if (addressInputEl) {
    addressInputEl.addEventListener("input", function () {
      wizard.updateField("address", addressInputEl.value);
    });

    // US-3 : aucune suggestion sélectionnée -> repli manuel dès qu'on quitte le champ.
    addressInputEl.addEventListener("blur", function () {
      ensureAddressManualFallback();
    });

    // §6.7 : ne jamais soumettre le formulaire depuis #address (le widget
    // Google gère lui-même les flèches/Entrée/Échap sur ses suggestions).
    addressInputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
      }
    });
  }

  if (postalCodeInputEl) {
    postalCodeInputEl.addEventListener("input", function () {
      wizard.updateField("postalCode", postalCodeInputEl.value);
    });
  }

  if (cityInputEl) {
    cityInputEl.addEventListener("input", function () {
      wizard.updateField("city", cityInputEl.value);
    });
  }

  if (addressRecapEditEl) {
    addressRecapEditEl.addEventListener("click", function () {
      wizard.updateField("postalCode", "");
      wizard.updateField("city", "");
      wizard.updateField("placeId", "");
      wizard.updateField("addressSource", "manual");
      if (postalCodeInputEl) postalCodeInputEl.value = "";
      if (cityInputEl) cityInputEl.value = "";
      if (addressRecapEl) addressRecapEl.hidden = true;
      if (addressManualEl) addressManualEl.hidden = false;
      if (postalCodeInputEl) postalCodeInputEl.focus();
    });
  }

  // §4 : robustesse si Google Maps ne charge pas (bloqueur, clé absente,
  // réseau) — repli manuel automatique après ~3s plutôt que de bloquer
  // l'utilisateur avec un "Suivant" inactif.
  setTimeout(function () {
    if (!googleMapsReady) {
      ensureAddressManualFallback();
    }
  }, 3000);

  // Pas de clé configurée (preview, dev sans .env, build sans la variable
  // d'environnement) : `loadGoogleMapsScript` renvoie false sans rien tenter.
  // On bascule ALORS TOUT DE SUITE sur le bloc CP/ville manuel — attendre les
  // 3 s du minuteur ci-dessus laisserait l'utilisateur devant un champ
  // d'adresse qui ne proposera jamais la moindre suggestion, sans lui dire
  // qu'il doit compléter code postal et ville lui-même.
  if (!loadGoogleMapsScript("initAutocomplete", ensureAddressManualFallback)) {
    ensureAddressManualFallback();
  }

  // --------------------------------------------------------------------
  // Champs simples — synchronisation DOM -> wizard.updateField
  // --------------------------------------------------------------------
  var simpleFieldIds = [
    "propertyType",
    "hasTerrain",
    "terrainSize",
    "surface",
    "rooms",
    "dpe",
    "dpeRequest",
    "floor",
    "hasElevator",
    "outdoor",
    "condition",
    "isOwner",
    "wantToSell",
    "name",
    "email",
    "phone",
  ];

  simpleFieldIds.forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    var eventName = el.tagName === "SELECT" ? "change" : "input";
    el.addEventListener(eventName, function () {
      wizard.updateField(id, el.value);
      syncConditionalVisibility();
    });
  });

  // --------------------------------------------------------------------
  // Navigation — US-1
  // --------------------------------------------------------------------
  if (prevBtn) {
    prevBtn.addEventListener("click", function () {
      wizard.prev();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", function () {
      wizard.next();
    });
  }

  // --------------------------------------------------------------------
  // Navigation clavier — US-7 : Entrée avance (ou soumet à la dernière
  // étape) depuis n'importe quel champ SAUF #address (préventDefault y est
  // déjà géré ci-dessus, sans avancer automatiquement).
  // --------------------------------------------------------------------
  estimationFormEl.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var target = e.target;
    if (!target || target.id === "address") return; // déjà géré par le listener dédié.

    if (target.tagName === "INPUT" || target.tagName === "SELECT") {
      e.preventDefault();
      if (wizard.state.currentStep === wizard.state.totalSteps) {
        if (typeof estimationFormEl.requestSubmit === "function") {
          estimationFormEl.requestSubmit();
        } else {
          handleSubmit();
        }
      } else {
        wizard.next();
      }
    }
  });

  // --------------------------------------------------------------------
  // Soumission finale — US-10 (non-régression stricte du payload/email)
  // --------------------------------------------------------------------
  function persistEstimation(payload) {
    var database = [];
    try {
      database = JSON.parse(localStorage.getItem("estimationDatabase") || "[]");
    } catch (error) {
      database = [];
    }
    database = appendToDatabase(database, payload);
    try {
      localStorage.setItem("estimationDatabase", JSON.stringify(database));
      localStorage.setItem("lastEstimation", JSON.stringify(payload));
    } catch (error) {
      console.error("Impossible d'enregistrer l'estimation en local :", error);
    }
  }

  // --------------------------------------------------------------------
  // Écran de soumission (§7.1) : l'appel API a lieu pendant l'envoi. Le
  // bouton reste désactivé tant que l'API n'a pas répondu, avec un message de
  // progression indéterminé et un second message au bout de 2,5 s.
  // --------------------------------------------------------------------
  var submitStatusTimer = null;

  function showSubmitStatus(message) {
    if (!submitStatusEl) return;
    if (submitStatusTextEl) submitStatusTextEl.textContent = message;
    submitStatusEl.hidden = false;
  }

  function hideSubmitStatus() {
    if (submitStatusTimer !== null) {
      clearTimeout(submitStatusTimer);
      submitStatusTimer = null;
    }
    if (submitStatusEl) submitStatusEl.hidden = true;
  }

  /** Message d'alerte libre dans la bannière `role="alert"` du wizard. */
  function showWizardAlert(message) {
    if (!wizardAlertEl) return;
    wizardAlertEl.hidden = false;
    wizardAlertEl.textContent = message;
  }

  function setSubmitBusy(submitBtn, busy, originalHTML) {
    if (!submitBtn) return;
    submitBtn.disabled = busy;
    if (busy) {
      submitBtn.innerHTML = "<span>Envoi en cours...</span>";
      submitBtn.setAttribute("aria-busy", "true");
    } else {
      submitBtn.innerHTML = originalHTML;
      // Retiré plutôt que mis à "false" : `aria-busy` absent est l'état neutre,
      // et le bouton doit repartir exactement comme au chargement.
      submitBtn.removeAttribute("aria-busy");
    }
  }

  /**
   * Libellé de repos du bouton d'envoi, capturé une fois pour toutes AVANT la
   * première soumission. `handleSubmit` travaille avec un `originalHTML` local,
   * inaccessible depuis un gestionnaire global : c'est cette copie que le
   * retour bfcache (plus bas) restaure.
   */
  var submitIdleHTML = (function () {
    var btn = document.getElementById("wizardSubmit");
    return btn ? btn.innerHTML : "";
  })();

  /**
   * Drapeau « soumission en vol » (correctif QA B4).
   *
   * `submitBtn.disabled` NE SUFFIT PAS : `form.requestSubmit()` sans
   * soumetteur — ce que fait la navigation clavier US-7 sur Entrée à la
   * dernière étape — déclenche l'événement `submit` sans consulter l'état
   * `disabled` d'un quelconque bouton. Depuis que la soumission est
   * asynchrone (appel API : jusqu'à ~13,5 s avec le retry), deux appuis sur
   * Entrée produisaient donc deux `POST /v1/estimations`, deux envois EmailJS
   * (lead dupliqué côté commercial), deux persistances et deux redirections.
   *
   * Le drapeau est posé APRÈS la validation (une soumission invalide n'est
   * pas « en vol ») et relâché sur TOUS les chemins qui laissent
   * l'utilisateur sur le formulaire (422, 429, exception inattendue). Il
   * reste volontairement à `true` sur les chemins qui redirigent vers
   * `/rapport/` : la navigation n'étant pas instantanée, le relâcher
   * rouvrirait précisément la fenêtre de double soumission qu'on ferme ici.
   */
  var submitInFlight = false;

  /** Rend la main à l'utilisateur : bouton réactivé ET drapeau relâché. */
  function releaseSubmit(submitBtn, originalHTML) {
    submitInFlight = false;
    setSubmitBusy(submitBtn, false, originalHTML);
  }

  /**
   * Soumission finale. La SEULE partie asynchrone est l'appel à l'API : une
   * fois la réponse connue, la suite (EmailJS non bloquant, persistance,
   * redirection) reproduit à l'identique l'ordre de l'existant — US-10 de
   * `specs/estimation-wizard.md`. Le wizard, lui, reste entièrement
   * synchrone : il ne connaît pas l'API.
   */
  function handleSubmit() {
    // Garde de double soumission (B4) : AVANT toute autre chose, y compris la
    // validation — rejouer `wizard.next()` pendant un appel en vol
    // déplacerait le focus sans raison.
    if (submitInFlight) return;

    // Valide l'étape 5 ; comme c'est déjà la dernière étape, `next()` ne fait
    // qu'exécuter la validation (cf. estimation-wizard.js) sans avancer.
    var valid = wizard.next();
    if (!valid) return;

    // Identifiant du lead — clé de déduplication inter-plateformes (plan §2.4).
    // Il est frappé ICI, au moment où la soumission devient certaine, puis
    // voyage dans le payload persisté jusqu'à `/rapport/`, qui s'en sert pour
    // n'émettre la conversion qu'une fois. La `reference` renvoyée par l'API
    // ne pourrait pas jouer ce rôle : elle arrive après la redirection.
    leadId = nouvelIdentifiantLead();
    debutSoumission = new Date().getTime();

    mesurer("estimation_submit", {
      lead_id: leadId,
      property_type: wizard.state.data.propertyType,
      surface_bucket: trancheSurface(wizard.state.data.surface),
      rooms: parseInt(wizard.state.data.rooms, 10),
      dpe: wizard.state.data.dpe,
      postal_code: wizard.state.data.postalCode,
      departement_code: departementDe(wizard.state.data.postalCode),
      is_owner: wizard.state.data.isOwner,
      want_to_sell: wizard.state.data.wantToSell,
      lead_quality: qualiteLead(wizard.state.data.isOwner, wizard.state.data.wantToSell),
    });

    var submitBtn = document.getElementById("wizardSubmit");
    var originalHTML = submitBtn ? submitBtn.innerHTML : "";

    submitInFlight = true;
    setSubmitBusy(submitBtn, true, originalHTML);
    if (wizardAlertEl) wizardAlertEl.hidden = true;
    showSubmitStatus("Analyse des transactions réelles autour de votre bien…");
    submitStatusTimer = setTimeout(function () {
      showSubmitStatus("Nous consultons les ventes des 24 derniers mois.");
    }, 2500);

    var apiPayload = buildEstimationApiPayload(wizard.state.data);
    var apiConfig = typeof CONFIG !== "undefined" && CONFIG.API ? CONFIG.API : {};

    try {
      requestEstimation(apiPayload, { baseUrl: apiConfig.BASE_URL }, function (response) {
        hideSubmitStatus();
        try {
          finalizeSubmit(response, submitBtn, originalHTML);
        } catch (error) {
          // `requestEstimation` avale les exceptions de son callback : sans ce
          // filet, une erreur imprévue ici laisserait `submitInFlight` à
          // `true` et le formulaire définitivement inutilisable.
          console.error("Erreur pendant la finalisation de la soumission :", error);
          mesurer("estimation_failed", { lead_id: leadId, failure_type: "unexpected" });
          releaseSubmit(submitBtn, originalHTML);
          showWizardAlert(
            "Une erreur inattendue est survenue. Vous pouvez réessayer votre demande."
          );
        }
      });
    } catch (error) {
      // `requestEstimation` ne rejette jamais et ne devrait pas lever, mais
      // une soumission bloquée à vie coûterait un lead : on relâche.
      console.error("Erreur pendant l'appel d'estimation :", error);
      mesurer("estimation_failed", { lead_id: leadId, failure_type: "unexpected" });
      hideSubmitStatus();
      releaseSubmit(submitBtn, originalHTML);
      showWizardAlert(
        "Une erreur inattendue est survenue. Vous pouvez réessayer votre demande."
      );
    }
  }

  /**
   * Suite de la soumission, une fois l'API retournée. Trois issues :
   *  - `invalid` (422 / adresse introuvable) : retour au champ fautif, aucune
   *    estimation produite, aucun lead envoyé — une donnée invalide ne doit
   *    pas générer de chiffre ;
   *  - `rate-limited` (429) : message explicite, bouton réactivé, pas de
   *    redirection ni de nouvelle tentative (US-8) ;
   *  - tout le reste : on poursuit le parcours normal, avec un statut
   *    `ok` / `static-fallback` / `deferred`.
   */
  function finalizeSubmit(response, submitBtn, originalHTML) {
    if (response.status === "invalid") {
      mesurer("estimation_failed", {
        lead_id: leadId,
        failure_type: "validation",
        http_status: response.httpStatus,
      });
      // L'utilisateur reste sur le formulaire pour corriger : on lui rend la
      // main (bouton ET drapeau de double soumission).
      releaseSubmit(submitBtn, originalHTML);
      // `setErrors` repositionne sur l'étape du premier champ fautif, affiche
      // le message sous le champ et pose le focus — sans table de
      // correspondance ici.
      var hasFieldErrors = wizard.setErrors(response.errors || {});
      if (response.addressUnresolved) {
        wizard.goToStep(1);
        ensureAddressManualFallback();
      }
      if (!hasFieldErrors) {
        showWizardAlert(
          response.message || "Certaines informations doivent être corrigées."
        );
      }
      return;
    }

    if (response.status === "rate-limited") {
      mesurer("estimation_failed", {
        lead_id: leadId,
        failure_type: "rate_limited",
        http_status: response.httpStatus,
      });
      // Pas de retry (US-8) : l'utilisateur réessaiera lui-même, il faut donc
      // que le drapeau soit relâché — sinon plus aucune soumission possible.
      releaseSubmit(submitBtn, originalHTML);
      showWizardAlert(
        response.message ||
          "Trop de demandes depuis votre connexion. Réessayez dans quelques instants."
      );
      return;
    }

    var estimationStatus = resolveEstimationStatus(response, apiConfigForStatus());
    var estimation = null;

    if (estimationStatus === "ok") {
      estimation = mapApiResultToLegacyEstimation(response.result);
    } else if (estimationStatus === "static-fallback") {
      // DÉCISION CLIENT : un prix est toujours affiché. Le calcul de repli
      // reste `calculerEstimation()`, inchangé — et la page comme le PDF
      // afficheront un bandeau permanent, sans aucune mention DVF/DGFiP.
      var data = wizard.state.data;
      estimation = calculerEstimation(
        data.city,
        parseFloat(data.surface),
        parseInt(data.rooms, 10),
        data.propertyType,
        data.dpe
      );
    }

    mesurer("estimation_api_result", {
      lead_id: leadId,
      estimation_status: estimationStatus,
      confidence_score:
        estimation && estimation.confidence ? estimation.confidence.score : undefined,
      comparables_count:
        estimation && estimation.method ? estimation.method.comparablesCount : undefined,
      latency_ms: debutSoumission ? new Date().getTime() - debutSoumission : undefined,
    });

    var payload = wizard.serializeForSubmit(estimation);
    payload.estimationStatus = estimationStatus;
    // Voyage jusqu'à `/rapport/` par `localStorage.lastEstimation`, où il sert
    // à la fois de `transaction_id` de la conversion et de verrou contre le
    // double comptage. `buildEstimationLeadPayload` construit son corps HTTP
    // champ par champ : ce `lead_id` supplémentaire n'atteint jamais l'API,
    // dont la validation est en liste blanche stricte.
    payload.lead_id = leadId;

    sendLead(payload, submitBtn, originalHTML);

    // Comportement identique à l'ancien estimation.js : la persistance et la
    // redirection ne dépendent PAS de la résolution de l'envoi du lead
    // (US-10, scénario "Échec d'envoi EmailJS" -> redirection quand même).
    //
    // `submitInFlight` reste à `true` sur ce chemin : le lead est parti et on
    // quitte la page. Le relâcher (comme le fait `setSubmitBusy` sur le
    // bouton, une fois la promesse EmailJS résolue) autoriserait une seconde
    // soumission pendant le temps de la navigation — soit un lead dupliqué.
    persistEstimation(payload);
    wizard.clearPersistedState();
    // Barre finale obligatoire : `trailingSlash: 'always'` (astro.config.mjs).
    window.location.href = "/rapport/";
  }

  /**
   * Transmission du lead — API transactionnelle d'abord, EmailJS en repli.
   *
   * ══════════════════════════════════════════════════════════════════════
   * UN SEUL ENVOI, JAMAIS DEUX
   * ══════════════════════════════════════════════════════════════════════
   * L'e-mail part désormais de notre API (`POST /v1/leads`, Scaleway TEM) :
   * le gabarit est rendu côté serveur, aucun identifiant d'envoi ne vit dans
   * la page. EmailJS n'est conservé que comme repli LEGACY, et seulement
   * lorsque `shouldUseLegacyFallback()` établit qu'aucun e-mail n'est parti —
   * API non configurée, requête jamais émise, ou refus explicite du serveur.
   *
   * Sur un timeout, un 422 ou un 429, on ne rejoue RIEN : mieux vaut un lead
   * à rattraper qu'un prospect rappelé deux fois par deux conseillers, ou un
   * quota contourné par une porte de service.
   *
   * L'appel est NON BLOQUANT vis-à-vis de la redirection, exactement comme
   * l'était `emailjs.send()` : `finalizeSubmit` enchaîne sur la persistance
   * et la navigation sans attendre cette promesse.
   */
  function sendLead(payload, submitBtn, originalHTML) {
    /*
     * `requestLead` n'est pas chargé sur toutes les pages (le module est
     * indépendant) : sans cette garde, une page qui oublierait le script
     * casserait toute la soumission au lieu de perdre l'e-mail.
     */
    if (typeof requestLead !== "function" || typeof buildEstimationLeadPayload !== "function") {
      console.error("lead-api.js absent : repli sur EmailJS.");
      sendLeadWithEmailJs(payload, submitBtn, originalHTML);
      return;
    }

    var apiConfig = apiConfigForStatus();

    requestLead(
      buildEstimationLeadPayload(payload),
      { baseUrl: apiConfig.BASE_URL },
      function (response) {
        if (response.status === "ok") {
          // `dry-run` : l'API a tout construit sans ouvrir de connexion SMTP
          // (domaine pas encore vérifié chez Scaleway, par exemple). Le
          // parcours est nominal, mais aucun e-mail n'existe : on le dit.
          if (response.mode === "dry-run") {
            console.warn(
              "Lead accepté en mode dry-run : aucun e-mail n'a été envoyé (réf. " +
                response.reference +
                ")."
            );
          }
          setSubmitBusy(submitBtn, false, originalHTML);
          return;
        }

        if (shouldUseLegacyFallback(response)) {
          console.warn(
            "API transactionnelle indisponible (" +
              (response.reason || "inconnu") +
              ") : repli EmailJS."
          );
          sendLeadWithEmailJs(payload, submitBtn, originalHTML);
          return;
        }

        // Aucun repli possible sans risque de doublon : le lead reste dans
        // `localStorage` (cf. `persistEstimation`), donc rattrapable.
        console.error(
          "Lead non transmis :",
          response.reason,
          response.httpStatus,
          response.message
        );
        setSubmitBusy(submitBtn, false, originalHTML);
      }
    );
  }

  /**
   * Repli LEGACY par EmailJS. Conservé tant que `PUBLIC_API_URL` n'est pas
   * déployé partout — un formulaire qui ne produit aucun lead est pire qu'un
   * formulaire qui en produit par l'ancien chemin.
   *
   * À SUPPRIMER une fois l'API en production sur tous les environnements
   * (avec `PUBLIC_EMAILJS_*` et le script CDN de `estimation.astro`).
   */
  function sendLeadWithEmailJs(payload, submitBtn, originalHTML) {
    if (
      typeof emailjs === "undefined" ||
      typeof CONFIG === "undefined" ||
      !CONFIG.EMAILJS ||
      !CONFIG.EMAILJS.SERVICE_ID
    ) {
      console.error("EmailJS indisponible : envoi de l'email ignoré.");
      setSubmitBusy(submitBtn, false, originalHTML);
      return;
    }

    var templateParams = buildEmailTemplateParams(payload, {
      propertyTypeText: getSelectedOptionText("propertyType"),
      dpeText: getSelectedOptionText("dpe"),
      toEmail: CONFIG.EMAIL ? CONFIG.EMAIL.TO : undefined,
    });

    emailjs
      .send(CONFIG.EMAILJS.SERVICE_ID, CONFIG.EMAILJS.TEMPLATE_ID, templateParams)
      .then(function (emailResponse) {
        console.log("Email envoye avec succes!", emailResponse.status, emailResponse.text);
      })
      .catch(function (error) {
        console.error("Erreur envoi email:", error);
      })
      .finally(function () {
        setSubmitBusy(submitBtn, false, originalHTML);
      });
  }

  /** `CONFIG.API` défensif (la clé peut manquer sur une preview sans .env). */
  function apiConfigForStatus() {
    return typeof CONFIG !== "undefined" && CONFIG.API ? CONFIG.API : {};
  }

  estimationFormEl.addEventListener("submit", function (e) {
    e.preventDefault();
    handleSubmit();
  });

  // --------------------------------------------------------------------
  // Retour arrière depuis /rapport/ (bfcache) — pendant obligatoire de B4.
  //
  // `finalizeSubmit` laisse volontairement `submitInFlight` à `true` sur les
  // chemins qui redirigent (cf. son commentaire) : c'est ce qui empêche une
  // seconde soumission pendant le temps de la navigation. Mais un clic sur
  // « Précédent » depuis /rapport/ ne recharge PAS la page : le navigateur la
  // restaure depuis le bfcache avec ses closures intactes, drapeau compris.
  // Le formulaire réapparaît alors parfaitement vivant... et ne fait plus
  // rien, sans le moindre message — un lead perdu en silence, sur un geste
  // aussi banal que revenir corriger une saisie après avoir vu son
  // estimation.
  //
  // `e.persisted` est ce qui distingue cette restauration d'un `pageshow` de
  // chargement ordinaire (émis après CHAQUE navigation, y compris celle qui
  // vient de partir) : relâcher le drapeau sans ce test rouvrirait très
  // exactement la fenêtre de double soumission que B4 a fermée.
  // --------------------------------------------------------------------
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pageshow", function (e) {
      if (!e || !e.persisted) return;

      submitInFlight = false;

      // L'état visuel doit suivre le drapeau. Au gel de la page, la promesse
      // EmailJS pouvait être encore en vol : le bouton est alors resté sur
      // « Envoi en cours... », `disabled` et `aria-busy`. Le restaurer tel
      // quel remplacerait un blocage silencieux par un affichage mensonger.
      setSubmitBusy(document.getElementById("wizardSubmit"), false, submitIdleHTML);

      // Même raisonnement pour le message de progression et son minuteur de
      // 2,5 s, tous deux susceptibles de survivre au gel : ils annonceraient
      // une analyse en cours sur un formulaire au repos.
      hideSubmitStatus();
    });
  }
}
