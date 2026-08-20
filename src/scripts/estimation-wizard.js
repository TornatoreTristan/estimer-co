// ============================================================================
// ESTIMATION WIZARD — état, validation, géocodage, persistance, calcul
// ============================================================================
//
// Ce fichier est injecté tel quel dans la page (voir `RawScript.astro`, qui
// fait `<script is:inline set:html={code} />` à partir d'un import `?raw`).
// Il n'y a ni bundler ni résolution de modules ES : PAS de `import`/`export`.
// Toutes les déclarations de premier niveau vivent donc dans la portée
// globale du script (comme `estimation.js` aujourd'hui). On utilise `var`
// pour les données de premier niveau et `function` pour les fonctions, afin
// qu'elles soient accessibles depuis `window` — et, côté outillage, depuis le
// script de vérification `scripts/test-estimation-wizard.mjs` qui exécute ce
// fichier dans un contexte `vm` Node pour tester les fonctions pures.
//
// Périmètre : state du wizard, validation par étape, persistance
// sessionStorage (RGPD), calcul d'estimation. Le parsing Google Places
// (`parseGooglePlace`) est parti dans `google-places.js`, partagé avec le
// formulaire d'adresse de la page d'accueil. Le câblage au DOM
// concret (ajout des event listeners sur les boutons, initialisation du
// widget Google Places, minuterie de repli) reste au frontend-dev — voir les
// notes d'intégration en bas de fichier.
//
// -----------------------------------------------------------------------
// Typedefs (documentation — cf. specs/estimation-wizard.md §3 et §4)
// -----------------------------------------------------------------------
//
// @typedef {Object} WizardData
// @property {string} address        valeur brute de #address (jamais réécrite, cf. §0)
// @property {string} postalCode
// @property {string} city
// @property {string} placeId        optionnel, debug/QA
// @property {'autocomplete'|'manual'|''} addressSource
// @property {string} propertyType   '' | 'appartement' | 'maison' | 'terrain' | 'local-commercial'
// @property {string} hasTerrain     '' | 'yes' | 'no'
// @property {string} terrainSize    string brute, jamais parsée avant la soumission
// @property {string} surface        string brute, parsée en Number à la soumission
// @property {string} rooms
// @property {string} dpe            '' | 'A'..'G' | 'unknown'
// @property {string} dpeRequest     '' | 'yes' | 'no'
// @property {string} floor          '' | entier en string (appartement, facultatif)
// @property {string} hasElevator    '' | 'yes' | 'no' | 'unknown' (appartement, facultatif)
// @property {string} outdoor        '' | 'none' | 'balcony' | 'terrace' | 'garden' (facultatif)
// @property {string} condition      '' | 'to-renovate' | 'fair' | 'good' | 'new' (facultatif)
// @property {string} isOwner        '' | 'yes' | 'no'
// @property {string} wantToSell     '' | 'yes' | 'no' | 'maybe'
// @property {string} name
// @property {string} email
// @property {string} phone
//
// @typedef {Object} WizardState
// @property {number} currentStep
// @property {number} totalSteps
// @property {number} maxStepReached
// @property {WizardData} data
// @property {Record<string,string>} errors
// @property {Record<string,boolean>} touched
//
// @typedef {Object} WizardController
// @property {WizardState} state
// @property {(step:number)=>void} goToStep
// @property {()=>boolean} next
// @property {()=>void} prev
// @property {(step:number, data:WizardData)=>{valid:boolean, errors:Record<string,string>}} validateStep
// @property {(fieldName:string)=>boolean} isFieldVisible  source unique de vérité pour la conditionnalité (US-5, US-8) — cf. WIZARD_STEPS[].conditionalFields
// @property {(name:string, value:string)=>void} updateField
// @property {(errors:Record<string,string>)=>boolean} setErrors  erreurs externes (422 de l'API)
// @property {(estimation?:object|null)=>object} serializeForSubmit
// @property {()=>void} persist
// @property {()=>boolean} restore
// @property {()=>void} clearPersistedState  bonus (cf. US-6 « nettoyage après soumission »)

// ============================================================================
// 1. DÉCOUPAGE DÉCLARATIF DES 5 ÉTAPES
// ============================================================================

/**
 * Définition déclarative des étapes du wizard (cf. specs §1).
 * - `fields`           : tous les champs de données rattachés à l'étape.
 * - `requiredFields`   : champs toujours requis sur cette étape.
 * - `conditionalFields`: règles de visibilité/obligation dépendant d'un autre
 *   champ de la même étape. Utilisées pour la réinitialisation en cascade
 *   (US-5) — la validation stricte (US-9) est, elle, écrite explicitement
 *   dans `validateStep` pour rester au plus près du texte des specs.
 */
var WIZARD_STEPS = [
  {
    id: 1,
    key: "address",
    title: "Adresse du bien",
    shortLabel: "Adresse",
    fields: ["address", "postalCode", "city", "placeId", "addressSource"],
    requiredFields: ["address", "postalCode", "city"],
    conditionalFields: [],
  },
  {
    id: 2,
    key: "property",
    title: "Type de bien",
    shortLabel: "Type de bien",
    fields: ["propertyType", "hasTerrain", "terrainSize"],
    requiredFields: ["propertyType"],
    conditionalFields: [
      {
        field: "hasTerrain",
        dependsOn: "propertyType",
        showWhen: function (value) {
          return value === "maison";
        },
        required: true,
      },
      {
        field: "terrainSize",
        dependsOn: "hasTerrain",
        showWhen: function (value) {
          return value === "yes";
        },
        required: true,
      },
    ],
  },
  {
    id: 3,
    key: "characteristics",
    title: "Caractéristiques & DPE",
    shortLabel: "Caractéristiques",
    fields: [
      "surface",
      "rooms",
      "dpe",
      "dpeRequest",
      // Précisions facultatives (specs/estimation-donnees-reelles.md §7.1) :
      // elles resserrent la fourchette (coefficients k_etage, k_exterieur,
      // k_etat du §3.6) mais AUCUNE n'est obligatoire — le tunnel convertit
      // aujourd'hui avec trois champs requis, on n'en ajoute pas un quatrième.
      "floor",
      "hasElevator",
      "outdoor",
      "condition",
    ],
    requiredFields: ["surface", "rooms", "dpe"],
    conditionalFields: [
      {
        field: "dpeRequest",
        dependsOn: "dpe",
        showWhen: function (value) {
          return value === "unknown";
        },
        required: false, // dpeRequest reste optionnel, comme aujourd'hui.
      },
      // Étage et ascenseur n'ont de sens qu'en appartement. La règle vit ICI
      // et nulle part ailleurs : `estimation-ui.js` interroge
      // `isFieldVisible()` et ne la redéclare jamais (§7.1, impératif
      // d'implémentation).
      {
        field: "floor",
        dependsOn: "propertyType",
        showWhen: function (value) {
          return value === "appartement";
        },
        required: false,
      },
      {
        field: "hasElevator",
        dependsOn: "propertyType",
        showWhen: function (value) {
          return value === "appartement";
        },
        required: false,
      },
      // Extérieur et état général ne concernent que le bâti : ni un terrain
      // nu, ni (au Lot 3) un local commercial.
      {
        field: "outdoor",
        dependsOn: "propertyType",
        showWhen: function (value) {
          return value === "appartement" || value === "maison";
        },
        required: false,
      },
      {
        field: "condition",
        dependsOn: "propertyType",
        showWhen: function (value) {
          return value === "appartement" || value === "maison";
        },
        required: false,
      },
    ],
  },
  {
    id: 4,
    key: "situation",
    title: "Votre situation",
    shortLabel: "Situation",
    fields: ["isOwner", "wantToSell"],
    requiredFields: ["isOwner", "wantToSell"],
    conditionalFields: [],
  },
  {
    id: 5,
    key: "contact",
    title: "Vos coordonnées",
    shortLabel: "Coordonnées",
    fields: ["name", "email", "phone"],
    requiredFields: ["name", "email", "phone"],
    conditionalFields: [],
  },
];

/** @returns {WizardData} un état de données vide (toutes les valeurs à ''). */
function createDefaultWizardData() {
  return {
    address: "",
    postalCode: "",
    city: "",
    placeId: "",
    addressSource: "",
    propertyType: "",
    hasTerrain: "",
    terrainSize: "",
    surface: "",
    rooms: "",
    dpe: "",
    dpeRequest: "",
    floor: "",
    hasElevator: "",
    outdoor: "",
    condition: "",
    isOwner: "",
    wantToSell: "",
    name: "",
    email: "",
    phone: "",
  };
}

// ============================================================================
// 1bis. CONDITIONNALITÉ DÉCLARATIVE — visibilité d'un champ (US-5, US-8)
// ============================================================================

/**
 * Source UNIQUE de vérité pour la conditionnalité d'affichage d'un champ :
 * dérivée directement des `conditionalFields` déclarés dans `WIZARD_STEPS`
 * (cf. §1). La couche d'affichage (estimation-ui.js) NE DOIT JAMAIS
 * redéfinir ces règles (ex. « le champ terrain n'apparaît que pour une
 * maison ») ailleurs que dans `WIZARD_STEPS` — elle doit appeler cette
 * fonction (ou `wizard.isFieldVisible`, cf. `createWizard`) pour savoir quoi
 * afficher.
 *
 * Un champ sans règle déclarée (ex. `propertyType`, `dpe` eux-mêmes, ou tout
 * champ qui ne dépend d'aucun autre) est toujours considéré visible.
 *
 * @param {string} fieldName
 * @param {WizardData} data
 * @returns {boolean}
 */
function isFieldVisible(fieldName, data) {
  var d = data || {};
  for (var i = 0; i < WIZARD_STEPS.length; i++) {
    var conditionalFields = WIZARD_STEPS[i].conditionalFields;
    for (var j = 0; j < conditionalFields.length; j++) {
      var rule = conditionalFields[j];
      if (rule.field === fieldName) {
        return !!rule.showWhen(d[rule.dependsOn]);
      }
    }
  }
  return true;
}

// ============================================================================
// 2. VALIDATION PAR ÉTAPE (fonction pure — US-3, US-8, US-9)
// ============================================================================

/**
 * Valide les données d'une étape. Fonction pure, testable sans DOM.
 * Règles exactes reprises de specs/estimation-wizard.md §4.
 *
 * @param {number} step
 * @param {WizardData} data
 * @returns {{valid:boolean, errors:Record<string,string>}}
 */
function validateStep(step, data) {
  var errors = {};
  var d = data || {};

  switch (step) {
    case 1:
      if (!d.address || !String(d.address).trim()) {
        errors.address = "L'adresse est obligatoire.";
      }
      if (!/^\d{5}$/.test(d.postalCode || "")) {
        errors.postalCode = "Le code postal doit contenir 5 chiffres.";
      }
      if (!d.city || !String(d.city).trim()) {
        errors.city = "La ville est obligatoire.";
      }
      break;

    case 2:
      if (!d.propertyType) {
        errors.propertyType = "Merci de sélectionner un type de bien.";
      }
      if (d.propertyType === "maison") {
        if (!d.hasTerrain) {
          errors.hasTerrain =
            "Merci de préciser si le bien dispose d'un terrain.";
        }
        if (d.hasTerrain === "yes") {
          var terrainSize = Number(d.terrainSize);
          if (!(terrainSize > 0)) {
            errors.terrainSize =
              "La surface du terrain doit être supérieure à 0.";
          }
        }
      }
      break;

    case 3:
      var surface = Number(d.surface);
      if (!(surface > 0)) {
        errors.surface = "La surface doit être un nombre supérieur à 0.";
      }
      var rooms = Number(d.rooms);
      if (!(Number.isInteger(rooms) && rooms >= 1)) {
        errors.rooms =
          "Le nombre de pièces doit être un entier supérieur ou égal à 1.";
      }
      if (!d.dpe) {
        errors.dpe = "Merci de sélectionner un diagnostic énergétique (DPE).";
      }
      // dpeRequest reste OPTIONNEL, y compris quand dpe === 'unknown'
      // (comportement identique à l'existant, cf. specs §4).
      break;

    case 4:
      if (!d.isOwner) {
        errors.isOwner = "Merci de préciser si vous êtes propriétaire.";
      }
      if (!d.wantToSell) {
        errors.wantToSell = "Merci de préciser votre projet de vente.";
      }
      break;

    case 5:
      if (!d.name || !String(d.name).trim()) {
        errors.name = "Le nom et prénom sont obligatoires.";
      }
      if (!d.email || !String(d.email).trim()) {
        errors.email = "L'email est obligatoire.";
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d.email).trim())) {
        errors.email = "Le format de l'email n'est pas valide.";
      }
      if (!d.phone || !String(d.phone).trim()) {
        errors.phone = "Le téléphone est obligatoire.";
      }
      // Pas de regex stricte sur le téléphone au Lot 1 (décision PO, §8).
      break;

    default:
      errors._step = "Étape inconnue.";
  }

  return { valid: Object.keys(errors).length === 0, errors: errors };
}

// ============================================================================
// 3. ADAPTER DE GÉOCODAGE — déplacé dans `google-places.js`
// ============================================================================
//
// `parseGooglePlace(place)` (specs §3) vit désormais dans
// `src/scripts/google-places.js`, chargé juste avant ce fichier sur
// `/estimation` : le champ d'adresse du hero de la page d'accueil s'appuie sur
// le même widget Google et a besoin du même adaptateur, sans pour autant
// charger tout ce wizard (table de prix comprise). Le contrat de la fonction
// est inchangé — elle reste une globale disponible ici comme dans
// `estimation-ui.js`.

// ============================================================================
// 4. CALCUL D'ESTIMATION DE REPLI — plus le chemin nominal
// ============================================================================
//
// ATTENTION — depuis le Lot 3 (specs/estimation-donnees-reelles.md §2.4), le
// calcul nominal est fait par l'API (`POST /v1/estimations`, transactions DVF
// réelles géolocalisées). `prixMoyenM2` et `calculerEstimation()` ci-dessous
// ne servent PLUS que de REPLI, quand l'API est injoignable (réseau, timeout,
// 5xx, 429) et que `PUBLIC_ESTIMATION_FALLBACK` vaut `'static'` — c'est le
// défaut, par décision client : un prix est toujours affiché.
//
// Dans ce mode, `lastEstimation.estimationStatus === 'static-fallback'`, la
// page et le PDF affichent un bandeau permanent « Estimation indicative » et
// AUCUNE mention de DVF ni de la DGFiP n'est produite : ce chiffre ne provient
// pas de ces données, l'annoncer serait faux et contreviendrait à
// l'attribution Etalab (§8.2).
//
// La fonction est conservée telle quelle (coefficients, table, arrondis) : les
// tests de non-régression de `scripts/test-estimation-wizard.mjs` la gèlent.
//
// Base de données des prix moyens au m² par ville (données 2025).
// NB : cette table duplique partiellement l'esprit de `src/data/prix.ts`
// (prix par région/département, utilisée par `src/pages/carte.astro`), mais
// ce n'est pas la même donnée (granularité ville vs région/département,
// valeurs différentes). Signalé tel que demandé — non retouché ici pour
// éviter toute régression sur `calculerEstimation`.
var prixMoyenM2 = {
  paris: 10500,
  lyon: 5200,
  marseille: 4100,
  toulouse: 3800,
  nice: 5500,
  nantes: 4200,
  strasbourg: 3500,
  montpellier: 4000,
  bordeaux: 5000,
  lille: 3200,
  rennes: 3900,
  reims: 2400,
  "saint-étienne": 1800,
  toulon: 3600,
  grenoble: 3400,
  dijon: 2800,
  angers: 3100,
  nîmes: 2700,
  villeurbanne: 4800,
  "le havre": 2300,
  "clermont-ferrand": 2500,
  "aix-en-provence": 5300,
  brest: 2200,
  tours: 2900,
  amiens: 2100,
  limoges: 1900,
  annecy: 5800,
  perpignan: 2600,
  besançon: 2400,
  metz: 2700,
  orléans: 2800,
  rouen: 2600,
  caen: 2800,
  mulhouse: 2300,
  nancy: 2500,
  argenteuil: 3800,
  montreuil: 5500,
  "saint-denis": 4200,
  default: 3000, // Prix moyen national par défaut
};

/**
 * Calcule l'estimation d'un bien à partir de la table statique ci-dessus.
 * Copie exacte de l'algorithme existant (coefficients et logique inchangés) —
 * non-régression pure. **Chemin de repli uniquement** (cf. l'avertissement en
 * tête de section) : le calcul nominal vient de l'API.
 *
 * @param {string} city
 * @param {number} surface
 * @param {number} rooms
 * @param {string} propertyType
 * @param {string} dpe
 */
function calculerEstimation(city, surface, rooms, propertyType, dpe) {
  // Extraire la ville et normaliser
  var cityLower = String(city || "")
    .toLowerCase()
    .trim();
  var prixM2 = prixMoyenM2["default"];

  // Rechercher la ville dans la base de données
  for (var ville in prixMoyenM2) {
    if (cityLower.includes(ville) || ville.includes(cityLower)) {
      prixM2 = prixMoyenM2[ville];
      break;
    }
  }

  // Ajustements selon le type de bien
  var coefficientType = 1;
  switch (propertyType) {
    case "appartement":
      coefficientType = 1;
      break;
    case "maison":
      coefficientType = 0.95; // Légèrement moins cher au m²
      break;
    case "terrain":
      coefficientType = 0.3; // Beaucoup moins cher
      break;
    case "local-commercial":
      coefficientType = 0.8;
      break;
  }

  // Ajustements selon le DPE
  var coefficientDPE = 1;
  switch (dpe) {
    case "A":
      coefficientDPE = 1.15; // +15% pour classe A
      break;
    case "B":
      coefficientDPE = 1.1; // +10% pour classe B
      break;
    case "C":
      coefficientDPE = 1.05; // +5% pour classe C
      break;
    case "D":
      coefficientDPE = 1; // Prix normal
      break;
    case "E":
      coefficientDPE = 0.95; // -5% pour classe E
      break;
    case "F":
      coefficientDPE = 0.85; // -15% pour classe F
      break;
    case "G":
      coefficientDPE = 0.75; // -25% pour classe G
      break;
    default:
      coefficientDPE = 1;
  }

  // Ajustement selon le nombre de pièces (bonus pour les grands appartements)
  var coefficientPieces = 1;
  if (propertyType === "appartement") {
    if (rooms >= 4) {
      coefficientPieces = 1.05;
    } else if (rooms === 1) {
      coefficientPieces = 0.95;
    }
  }

  // Calcul final
  var prixM2Final =
    prixM2 * coefficientType * coefficientDPE * coefficientPieces;
  var estimationMin = Math.round(prixM2Final * surface * 0.9);
  var estimationMax = Math.round(prixM2Final * surface * 1.1);
  var estimationMoyenne = Math.round(prixM2Final * surface);

  return {
    prixM2: Math.round(prixM2Final),
    estimationMin: estimationMin,
    estimationMax: estimationMax,
    estimationMoyenne: estimationMoyenne,
  };
}

// ============================================================================
// 5. SÉRIALISATION VERS LE PAYLOAD EXISTANT (§3.2 — aucune rupture)
// ============================================================================

/**
 * Construit le payload attendu par `estimationDatabase` / `lastEstimation`
 * (mêmes clés, mêmes types que l'existant, enrichi des précisions facultatives
 * de l'étape 3). Fonction pure : ne lit rien du DOM, ne stocke rien — c'est à
 * l'appelant de persister le résultat en localStorage.
 *
 * Le second paramètre porte l'estimation à embarquer (§5.4) :
 * - un objet          -> résultat de l'API mappé (`mapApiResultToLegacyEstimation`)
 *                        ou de `calculerEstimation()` en mode repli ;
 * - `null`            -> mode « estimation différée » assumé, aucun prix ;
 * - omis (`undefined`) -> repli historique : la fonction calcule elle-même via
 *                        `calculerEstimation()`. C'est ce qui permet à
 *                        `serializeForSubmit()` de rester appelable sans
 *                        argument (et aux tests existants de ne pas mentir sur
 *                        le contrat).
 *
 * Le statut (`estimationStatus`) est posé par l'appelant, qui seul sait
 * comment l'estimation a été obtenue.
 *
 * @param {WizardData} data
 * @param {object|null} [estimation]
 * @returns {object}
 */
function buildSubmitPayload(data, estimation) {
  var d = data || {};
  var surface = parseFloat(d.surface);
  var rooms = parseInt(d.rooms, 10);

  return {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    propertyType: d.propertyType,
    address: d.address,
    postalCode: d.postalCode,
    city: d.city,
    surface: surface,
    rooms: rooms,
    dpe: d.dpe,
    dpeRequest: d.dpeRequest,
    isOwner: d.isOwner,
    wantToSell: d.wantToSell,
    hasTerrain: d.hasTerrain,
    terrainSize: d.terrainSize, // reste une string, comme aujourd'hui
    // Précisions facultatives de l'étape 3 : conservées brutes (strings), au
    // même titre que `terrainSize`. Elles alimentent le rapport et l'e-mail
    // interne ; l'API, elle, reçoit des valeurs typées via
    // `buildEstimationApiPayload`.
    floor: d.floor,
    hasElevator: d.hasElevator,
    outdoor: d.outdoor,
    condition: d.condition,
    name: d.name,
    email: d.email,
    phone: d.phone,
    estimation:
      estimation === undefined
        ? calculerEstimation(d.city, surface, rooms, d.propertyType, d.dpe)
        : estimation,
  };
}

/**
 * Numéro de l'étape (1-5) portant `fieldName`, ou `null`. Fonction pure,
 * dérivée de `WIZARD_STEPS` — utilisée pour ramener l'utilisateur sur l'étape
 * du premier champ refusé par l'API (422, §7.1 « invalid »).
 *
 * @param {string} fieldName
 * @returns {number|null}
 */
function findStepForField(fieldName) {
  for (var i = 0; i < WIZARD_STEPS.length; i++) {
    if (WIZARD_STEPS[i].fields.indexOf(fieldName) !== -1) return WIZARD_STEPS[i].id;
  }
  return null;
}

// ============================================================================
// 6. PERSISTANCE SESSIONSTORAGE (RGPD — étapes 1 à 4 uniquement, §3.3)
// ============================================================================

var WIZARD_STORAGE_KEY = "estimationWizardState";
var WIZARD_STORAGE_VERSION = 1;

/**
 * Liste des champs persistables (étapes 1 à 4). N'inclut JAMAIS name/email/
 * phone (étape 5), conformément à la contrainte RGPD du §3.3.
 * @returns {string[]}
 */
function getPersistableFieldNames() {
  return WIZARD_STEPS.filter(function (step) {
    return step.id <= 4;
  }).reduce(function (acc, step) {
    return acc.concat(step.fields);
  }, []);
}

/** Lecture défensive de sessionStorage (peut throw en navigation privée Safari, iframe sandboxée, storage désactivé...). */
function safeSessionStorageGet(key) {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

/** Écriture défensive de sessionStorage. Ne throw jamais. */
function safeSessionStorageSet(key, value) {
  try {
    if (typeof sessionStorage === "undefined") return false;
    sessionStorage.setItem(key, value);
    return true;
  } catch (error) {
    return false;
  }
}

/** Suppression défensive de sessionStorage. Ne throw jamais. */
function safeSessionStorageRemove(key) {
  try {
    if (typeof sessionStorage === "undefined") return false;
    sessionStorage.removeItem(key);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Relit et valide l'état persistée. Défensif à 100% : JSON invalide, clé
 * absente, storage indisponible, ou schéma d'une version antérieure ->
 * renvoie `null` silencieusement (jamais de throw).
 * @returns {{version:number, currentStep:number, maxStepReached:number, data:object}|null}
 */
function readPersistedWizardState() {
  var raw = safeSessionStorageGet(WIZARD_STORAGE_KEY);
  if (!raw) return null;

  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return null; // JSON invalide -> on repart d'un état vide.
  }

  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.version !== WIZARD_STORAGE_VERSION) return null; // schéma antérieur -> ignoré.
  if (!parsed.data || typeof parsed.data !== "object") return null;
  if (
    typeof parsed.currentStep !== "number" ||
    typeof parsed.maxStepReached !== "number"
  ) {
    return null;
  }

  return parsed;
}

// ============================================================================
// 7. CONTRÔLEUR DU WIZARD — createWizard(formEl)
// ============================================================================

/**
 * Construit le contrôleur du wizard et l'attache au `<form>`. À appeler
 * après DOMContentLoaded (une fois le markup des 5 étapes en place, cf.
 * specs §5 pour les conventions d'IDs/classes attendues).
 *
 * Le state est la source de vérité ; toutes les fonctions `render*` ci-
 * dessous ne font qu'écrire dans le DOM (jamais lire une `.value`) — la
 * lecture des champs pour alimenter le state passe exclusivement par
 * `updateField(name, value)`, appelé par le frontend-dev depuis ses propres
 * listeners `input`/`change`.
 *
 * @param {HTMLFormElement} formEl
 * @returns {WizardController}
 */
function createWizard(formEl) {
  var totalSteps = WIZARD_STEPS.length;

  /** @type {WizardState} */
  var state = {
    currentStep: 1,
    totalSteps: totalSteps,
    maxStepReached: 1,
    data: createDefaultWizardData(),
    errors: {},
    touched: {},
  };

  function getStepDefinition(stepId) {
    for (var i = 0; i < WIZARD_STEPS.length; i++) {
      if (WIZARD_STEPS[i].id === stepId) return WIZARD_STEPS[i];
    }
    return null;
  }

  function queryDocument(selector) {
    if (typeof document === "undefined") return null;
    return document.querySelector(selector);
  }

  function getDocumentElementById(id) {
    if (typeof document === "undefined") return null;
    return document.getElementById(id);
  }

  // ---------------------------------------------------------------------
  // Rendu DOM (miroir de l'état — défensif : aucune erreur si un élément
  // attendu n'existe pas encore dans le markup).
  // ---------------------------------------------------------------------

  function renderStepVisibility() {
    if (!formEl || !formEl.querySelectorAll) return;
    var panels = formEl.querySelectorAll("[data-step]");
    panels.forEach(function (panel) {
      var stepId = Number(panel.getAttribute("data-step"));
      panel.hidden = stepId !== state.currentStep;
    });
  }

  function renderProgress() {
    var root = queryDocument(".wizard-progress");
    if (!root) return;
    root.setAttribute("aria-valuenow", String(state.currentStep));
    var items = root.querySelectorAll(".wizard-progress__item");
    items.forEach(function (item, index) {
      var stepId = index + 1;
      if (stepId === state.currentStep) {
        item.dataset.state = "active";
        item.setAttribute("aria-current", "step");
      } else if (stepId < state.currentStep) {
        item.dataset.state = "done";
        item.removeAttribute("aria-current");
      } else {
        item.dataset.state = "upcoming";
        item.removeAttribute("aria-current");
      }
    });
  }

  function renderNavButtons() {
    if (!formEl || !formEl.querySelector) return;
    var prevBtn = formEl.querySelector("#wizardPrev");
    var nextBtn = formEl.querySelector("#wizardNext");
    var submitBtn = formEl.querySelector("#wizardSubmit");
    var isLastStep = state.currentStep === totalSteps;
    if (prevBtn) prevBtn.hidden = state.currentStep === 1;
    if (nextBtn) nextBtn.hidden = isLastStep;
    if (submitBtn) submitBtn.hidden = !isLastStep;
  }

  function announceStepChange() {
    var liveRegion = getDocumentElementById("wizardLiveRegion");
    if (!liveRegion) return;
    var stepDef = getStepDefinition(state.currentStep);
    var title = stepDef ? stepDef.title : "";
    liveRegion.textContent =
      "Étape " +
      state.currentStep +
      " sur " +
      totalSteps +
      (title ? " : " + title : "");
  }

  function focusStepHeading() {
    if (!formEl || !formEl.querySelector) return;
    var panel = formEl.querySelector('[data-step="' + state.currentStep + '"]');
    if (!panel) return;
    var heading = panel.querySelector("h2");
    if (!heading) return;
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus();
  }

  function clearFieldErrorDisplay(fieldName) {
    if (!formEl || !formEl.querySelector) return;
    var input = formEl.querySelector("#" + fieldName);
    var errorEl = formEl.querySelector("#" + fieldName + "-error");
    if (input) input.removeAttribute("aria-invalid");
    if (errorEl) {
      errorEl.hidden = true;
      errorEl.textContent = "";
    }
  }

  function renderFieldError(fieldName, message) {
    if (!formEl || !formEl.querySelector) return;
    var input = formEl.querySelector("#" + fieldName);
    var errorEl = formEl.querySelector("#" + fieldName + "-error");
    if (input) input.setAttribute("aria-invalid", "true");
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = message;
    }
  }

  function renderErrors() {
    var stepDef = getStepDefinition(state.currentStep);
    if (!stepDef) return;
    stepDef.fields.forEach(function (fieldName) {
      if (state.errors[fieldName]) {
        renderFieldError(fieldName, state.errors[fieldName]);
      } else {
        clearFieldErrorDisplay(fieldName);
      }
    });
  }

  function renderAlertBanner(show) {
    var alertEl = queryDocument(".wizard-alert");
    if (!alertEl) return;
    alertEl.hidden = !show;
    if (show) {
      alertEl.textContent = "Merci de compléter les champs obligatoires.";
    }
  }

  function focusFirstInvalidField() {
    var stepDef = getStepDefinition(state.currentStep);
    if (!stepDef || !formEl || !formEl.querySelector) return;
    for (var i = 0; i < stepDef.fields.length; i++) {
      var fieldName = stepDef.fields[i];
      if (state.errors[fieldName]) {
        var input = formEl.querySelector("#" + fieldName);
        if (input) {
          input.focus();
          return;
        }
      }
    }
  }

  function render(options) {
    var opts = options || {};
    renderStepVisibility();
    renderProgress();
    renderNavButtons();
    if (opts.announce !== false) {
      announceStepChange();
    }
  }

  // ---------------------------------------------------------------------
  // Conditionnalité (US-5, US-8) : réinitialisation en cascade quand un
  // champ pivot change de valeur et masque un champ dépendant.
  // ---------------------------------------------------------------------

  function applyConditionalResets(changedField) {
    // On parcourt TOUTES les étapes (et non la seule étape courante) : un
    // champ conditionnel peut dépendre d'un champ affiché sur la même
    // étape, mais rien ne garantit que `state.currentStep` corresponde
    // encore à l'étape du champ modifié au moment de l'appel.
    WIZARD_STEPS.forEach(function (stepDef) {
      stepDef.conditionalFields.forEach(function (rule) {
        if (rule.dependsOn !== changedField) return;
        var isVisible = rule.showWhen(state.data[rule.dependsOn]);
        if (!isVisible && state.data[rule.field] !== "") {
          state.data[rule.field] = "";
          delete state.errors[rule.field];
          clearFieldErrorDisplay(rule.field);
          // Cascade : ex. propertyType -> hasTerrain -> terrainSize.
          applyConditionalResets(rule.field);
        }
      });
    });
  }

  // ---------------------------------------------------------------------
  // API publique
  // ---------------------------------------------------------------------

  function updateField(name, value) {
    state.data[name] = value;
    state.touched[name] = true;
    if (state.errors[name]) {
      delete state.errors[name];
      clearFieldErrorDisplay(name);
    }
    applyConditionalResets(name);
  }

  function goToStep(step) {
    var clamped = Math.min(Math.max(step, 1), totalSteps);
    state.currentStep = clamped;
    render();
  }

  function next() {
    var result = validateStep(state.currentStep, state.data);
    state.errors = result.errors;

    if (!result.valid) {
      renderErrors();
      renderAlertBanner(true);
      focusFirstInvalidField();
      return false;
    }

    renderAlertBanner(false);

    if (state.currentStep < totalSteps) {
      state.currentStep += 1;
      if (state.currentStep > state.maxStepReached) {
        state.maxStepReached = state.currentStep;
      }
      persist();
      render();
      focusStepHeading();
    }

    return true;
  }

  function prev() {
    if (state.currentStep > 1) {
      state.currentStep -= 1;
      render();
      focusStepHeading();
    }
  }

  function persist() {
    var persistableFields = getPersistableFieldNames();
    var dataToPersist = {};
    persistableFields.forEach(function (field) {
      dataToPersist[field] = state.data[field];
    });
    var payload = {
      version: WIZARD_STORAGE_VERSION,
      currentStep: state.currentStep,
      maxStepReached: state.maxStepReached,
      data: dataToPersist,
    };
    // name/email/phone (étape 5) ne font jamais partie de `dataToPersist`
    // puisqu'ils n'appartiennent pas aux champs renvoyés par
    // `getPersistableFieldNames()` (étapes 1 à 4 uniquement).
    safeSessionStorageSet(WIZARD_STORAGE_KEY, JSON.stringify(payload));
  }

  function restore() {
    var persisted = readPersistedWizardState();
    if (!persisted) return false;

    var persistableFields = getPersistableFieldNames();
    persistableFields.forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(persisted.data, field)) {
        state.data[field] = persisted.data[field];
      }
    });

    state.maxStepReached = Math.min(
      Math.max(persisted.maxStepReached, 1),
      totalSteps
    );
    state.currentStep = Math.min(
      Math.max(persisted.currentStep, 1),
      state.maxStepReached
    );

    render({ announce: false });
    return true;
  }

  function clearPersistedState() {
    safeSessionStorageRemove(WIZARD_STORAGE_KEY);
  }

  function serializeForSubmit(estimation) {
    return buildSubmitPayload(state.data, estimation);
  }

  /**
   * Injecte des erreurs venues de l'EXTÉRIEUR du wizard (typiquement la
   * réponse 422 de l'API, mappée par `mapApiErrorToFieldErrors`) et applique
   * exactement le même traitement qu'une erreur de validation locale :
   * repositionnement sur l'étape du premier champ fautif, message sous le
   * champ, bannière `role="alert"`, focus.
   *
   * C'est ce qui permet à la couche API de ne fournir qu'un
   * `Record<champ, message>` — `renderErrors()` fait le reste, sans table de
   * correspondance ni duplication de la mécanique d'affichage des erreurs.
   *
   * @param {Record<string,string>} errors
   * @returns {boolean} true si au moins une erreur a été posée
   */
  function setErrors(errors) {
    state.errors = errors || {};
    var fieldNames = Object.keys(state.errors);

    if (!fieldNames.length) {
      renderAlertBanner(false);
      renderErrors();
      return false;
    }

    // Étape du premier champ réellement rattaché à une étape (`_form` et les
    // champs inconnus n'en ont pas : on reste alors sur l'étape courante).
    for (var i = 0; i < fieldNames.length; i++) {
      var step = findStepForField(fieldNames[i]);
      if (step) {
        if (step !== state.currentStep) goToStep(step);
        break;
      }
    }

    renderErrors();
    renderAlertBanner(true);
    focusFirstInvalidField();
    return true;
  }

  // État initial : étape 1 visible, étapes 2-5 masquées. Pas d'annonce
  // aria-live au chargement (seules les transitions ultérieures s'annoncent).
  render({ announce: false });

  return {
    state: state,
    goToStep: goToStep,
    next: next,
    prev: prev,
    validateStep: function (step, data) {
      return validateStep(step, data);
    },
    isFieldVisible: function (fieldName) {
      return isFieldVisible(fieldName, state.data);
    },
    updateField: updateField,
    setErrors: setErrors,
    serializeForSubmit: serializeForSubmit,
    persist: persist,
    restore: restore,
    clearPersistedState: clearPersistedState,
  };
}

// ============================================================================
// 8. NOTES D'INTÉGRATION POUR LE FRONTEND-DEV (câblage au DOM)
// ============================================================================
//
// Ce module NE fait PAS :
// - le chargement du script Google Maps ni l'instanciation de
//   `google.maps.places.Autocomplete` (reprendre `loadGoogleMapsAPI`/
//   `initAutocomplete` de estimation.js) ;
// - le minuteur de repli (~3s) qui révèle le bloc CP/ville manuel si Google
//   Maps ne charge pas (§4) ;
// - le branchement des boutons (#wizardNext -> wizard.next(), #wizardPrev ->
//   wizard.prev(), #wizardSubmit -> submit handler) ;
// - la lecture des `<input>`/`<select>` (listeners `input`/`change` qui
//   appellent `wizard.updateField(name, value)`) ;
// - l'écriture de `estimationDatabase`/`lastEstimation` en localStorage et
//   l'appel EmailJS (utiliser `wizard.serializeForSubmit()` pour obtenir le
//   payload, puis reproduire la logique d'écriture + `emailjs.send(...)` +
//   redirection actuelles) ;
// - l'appel à `wizard.clearPersistedState()` après soumission réussie
//   (US-6 : la clé sessionStorage doit disparaître une fois `lastEstimation`
//   écrite) ;
// - la réhydratation des `.value` des `<input>`/`<select>` après
//   `wizard.restore()` : le contrôleur restaure `state.data`, mais ne réécrit
//   JAMAIS lui-même une `.value` (cf. section 7, il ne fait que lire les
//   champs via `updateField`) — c'est au frontend-dev de reporter
//   `state.data` sur le DOM juste après `restore()` (US-6).
//
// IMPORTANT — conditionnalité (US-5, US-8) : `WIZARD_STEPS[].conditionalFields`
// (section 1) est la SEULE source de vérité pour « quel champ dépend de
// quel autre, et sous quelle condition ». La couche d'affichage ne doit
// jamais redéclarer ces règles (ex. « le terrain n'apparaît que pour une
// maison ») : elle doit interroger `wizard.isFieldVisible(fieldName)` (ou la
// fonction pure `isFieldVisible(fieldName, data)`) pour décider quoi
// afficher/masquer dans le DOM.
//
// Conventions DOM attendues par le contrôleur (à créer par le frontend-dev,
// cf. specs §5/§6) :
// - un panneau par étape : `<fieldset data-step="1">` … `data-step="5"`,
//   chacun contenant un `<h2>` (cible du focus programmatique) ;
// - `#wizardPrev`, `#wizardNext`, `#wizardSubmit` dans le formulaire ;
// - `.wizard-progress` + `.wizard-progress__item` (un par étape, dans
//   l'ordre) hors du formulaire ;
// - `#wizardLiveRegion` (aria-live="polite", `.sr-only`) hors du formulaire ;
// - `.wizard-alert` (role="alert") hors du formulaire ;
// - pour chaque champ `X` : `#X` (l'input/select) et `#X-error`
//   (`<p class="field-error" role="alert" hidden>`), reliés par
//   `aria-describedby="X-error"` sur l'input.
//
// Ordre d'initialisation recommandé :
// 1. `var wizard = createWizard(document.getElementById('estimationForm'));`
// 2. `wizard.restore();` (repositionne sur `maxStepReached`, sans PII)
// 3. Câblage des listeners DOM (boutons, champs, Google Places).
// 4. Le callback `initAutocomplete` (déclenché par le `callback=` de l'URL
//    Google Maps) peut être défini indépendamment de `wizard` — il doit
//    juste, dans `place_changed`, appeler `parseGooglePlace(place)` puis
//    `wizard.updateField('postalCode', result.postalCode)` /
//    `wizard.updateField('city', result.city)` / `wizard.updateField('placeId', result.placeId)`
//    / `wizard.updateField('addressSource', 'autocomplete')` — SANS jamais
//    réassigner `document.getElementById('address').value` (cf. §0).
