// ============================================================================
// ESTIMATION UI — câblage DOM du wizard (Google Places, toggles, soumission)
// ============================================================================
//
// Ce fichier est injecté tel quel (voir `RawScript.astro`, `<script
// is:inline>` à partir d'un import `?raw`) juste après
// `estimation-wizard.js` : il consomme les globales exposées par ce dernier
// (`createWizard`, `parseGooglePlace`, `isFieldVisible`...) sans jamais
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
 * de l'étape 3 (devis DPE / CTA Ritmodiag), à partir des seules données du
 * wizard. Fonction pure, réutilisée par `syncConditionalVisibility()` pour
 * appliquer effectivement ces règles au DOM (US-5, US-8).
 *
 * `showTerrainQuestion`/`showTerrainSize`/`showDpeRequest` sont dérivés de
 * `isFieldVisible()` (source unique de vérité, déclarée dans
 * `estimation-wizard.js` à partir de `WIZARD_STEPS[].conditionalFields`) —
 * cette fonction ne redéfinit PAS ces règles métier. Seul `showRitmodiagCta`
 * est propre à l'UI : le CTA Ritmodiag n'est pas un champ de `WizardData`
 * (rien à réinitialiser en cascade), donc aucune règle équivalente n'existe
 * côté wizard à dupliquer.
 *
 * @param {object} data `wizard.state.data`
 * @returns {{showTerrainQuestion:boolean, showTerrainSize:boolean, showDpeRequest:boolean, showRitmodiagCta:boolean}}
 */
function computeConditionalVisibility(data) {
  var d = data || {};
  return {
    showTerrainQuestion: isFieldVisible("hasTerrain", d),
    showTerrainSize: isFieldVisible("terrainSize", d),
    showDpeRequest: isFieldVisible("dpeRequest", d),
    showRitmodiagCta: d.dpeRequest === "yes",
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
 * Construit les `templateParams` EmailJS à partir du payload de soumission
 * (`wizard.serializeForSubmit()`, cf. specs §3.2). Le corps du message
 * (`message`) reproduit EXACTEMENT le gabarit de l'ancien `estimation.js` —
 * seules les variables locales deviennent des accès à `payload.*` (non-
 * régression stricte demandée sur le contenu de l'email).
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

  var message = `NOUVELLE DEMANDE D'ESTIMATION

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
- Souhaite un DPE : ${p.dpeRequest === "yes" ? "Oui" : "Non"}

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

    if (addressRecapPostalEl) addressRecapPostalEl.textContent = parsed.postalCode || "—";
    if (addressRecapCityEl) addressRecapCityEl.textContent = parsed.city || "—";
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

  function loadGoogleMapsAPI() {
    if (typeof CONFIG === "undefined" || !CONFIG.GOOGLE || !CONFIG.GOOGLE.API_KEY) {
      // Pas de clé configurée (preview, dev sans .env...) : inutile de tenter
      // le chargement, le minuteur de repli ci-dessous prendra le relais.
      return;
    }
    var script = document.createElement("script");
    script.src =
      "https://maps.googleapis.com/maps/api/js?key=" +
      CONFIG.GOOGLE.API_KEY +
      "&libraries=places&callback=initAutocomplete";
    script.async = true;
    script.defer = true;
    script.onerror = function () {
      ensureAddressManualFallback();
    };
    document.head.appendChild(script);
  }

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
  hydrateFieldsFromState();

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

  loadGoogleMapsAPI();

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

  function handleSubmit() {
    // Valide l'étape 5 ; comme c'est déjà la dernière étape, `next()` ne fait
    // qu'exécuter la validation (cf. estimation-wizard.js) sans avancer.
    var valid = wizard.next();
    if (!valid) return;

    var payload = wizard.serializeForSubmit();
    var submitBtn = document.getElementById("wizardSubmit");
    var originalHTML = submitBtn ? submitBtn.innerHTML : "";

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = "<span>Envoi en cours...</span>";
    }

    var templateParams = buildEmailTemplateParams(payload, {
      propertyTypeText: getSelectedOptionText("propertyType"),
      dpeText: getSelectedOptionText("dpe"),
      toEmail: typeof CONFIG !== "undefined" && CONFIG.EMAIL ? CONFIG.EMAIL.TO : undefined,
    });

    if (
      typeof emailjs !== "undefined" &&
      typeof CONFIG !== "undefined" &&
      CONFIG.EMAILJS &&
      CONFIG.EMAILJS.SERVICE_ID
    ) {
      emailjs
        .send(CONFIG.EMAILJS.SERVICE_ID, CONFIG.EMAILJS.TEMPLATE_ID, templateParams)
        .then(function (response) {
          console.log("Email envoye avec succes!", response.status, response.text);
        })
        .catch(function (error) {
          console.error("Erreur envoi email:", error);
        })
        .finally(function () {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalHTML;
          }
        });
    } else {
      console.error("EmailJS indisponible : envoi de l'email ignoré.");
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalHTML;
      }
    }

    // Comportement identique à l'ancien estimation.js : la persistance et la
    // redirection ne dépendent PAS de la résolution de la promesse EmailJS
    // (US-10, scénario "Échec d'envoi EmailJS" -> redirection quand même).
    persistEstimation(payload);
    wizard.clearPersistedState();
    window.location.href = "/rapport";
  }

  estimationFormEl.addEventListener("submit", function (e) {
    e.preventDefault();
    handleSubmit();
  });
}
