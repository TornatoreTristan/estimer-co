#!/usr/bin/env node
/**
 * Vérification autonome de `src/scripts/estimation-ui.js` : fonctions pures
 * (première moitié du fichier) ET soumission finale (seconde moitié, sur un
 * faux DOM monté ici même — cf. section « SOUMISSION FINALE » en fin de
 * fichier, ajoutée en réponse au point M9 de la revue QA).
 *
 * Même technique que `scripts/test-estimation-wizard.mjs` : les fichiers sont
 * exécutés tels qu'ils seront injectés en production (scripts classiques,
 * aucun import/export) via `vm.Script#runInThisContext()`. `estimation-ui.js`
 * consomme des globales déclarées par `estimation-wizard.js` (notamment
 * `isFieldVisible`, utilisée par `computeConditionalVisibility` pour ne PAS
 * dupliquer la règle de conditionnalité — cf. revue QA) : on charge donc
 * systématiquement `estimation-wizard.js` dans le même realm AVANT
 * `estimation-ui.js`, exactement dans l'ordre où les deux `<script
 * is:inline>` sont rendus sur la page (`estimation.astro`).
 *
 * Deux régimes d'exécution coexistent donc dans ce fichier :
 *
 * 1. `loadUiModule()` — SANS `document` (ou avec un `document` dont
 *    `getElementById("estimationForm")` renvoie `null`) : tout le câblage DOM
 *    d'`estimation-ui.js` (protégé par `if (estimationFormEl) { ... }`) reste
 *    inerte, seules les fonctions pures de premier niveau sont exercées
 *    (`computeConditionalVisibility`, `computeHydrationPlan`,
 *    `appendToDatabase`, `buildEmailTemplateParams`, `getSelectedOptionText`).
 *
 * 2. `createSubmitHarness()` — AVEC un faux DOM complet (formulaire à 5
 *    étapes, `<select>` avec options, boutons, zones d'erreur) plus des
 *    bouchons `fetch`, `emailjs`, `localStorage`, `sessionStorage` et
 *    `window.location`. Le câblage s'exécute alors pour de vrai : navigation
 *    par les boutons, saisie par événements `input`/`change`, soumission par
 *    `submit` ET par la touche Entrée (`form.requestSubmit()`). C'est ce qui
 *    permet de couvrir `handleSubmit`/`finalizeSubmit` — angle mort de tests
 *    relevé en revue QA, et endroit exact où le défaut de double soumission
 *    était passé.
 *
 * Reste NON couvert ici (documenté plutôt que simulé par un faux test) : le
 * widget Google Places lui-même, et le rendu visuel (aucune mise en page
 * n'est calculée sans navigateur). Points de vérification manuelle en recette
 * (cf. checklist QA : « recharger la page à l'étape 3+, vérifier que les
 * champs des étapes précédentes sont bien pré-remplis, puis soumettre et
 * vérifier le contenu de l'email reçu »).
 *
 * Ce que ce fichier couvre en revanche pour de vrai, sans DOM complet :
 * - `computeHydrationPlan(data)` (pure) : à partir d'un `state.data` restauré,
 *   la fonction calcule exactement quelles valeurs de champ et quel état de
 *   récapitulatif/bloc manuel DEVRAIENT être appliqués. C'est la logique dont
 *   l'absence causait le bug relevé en revue (aucune réhydratation) — un
 *   test qui l'exerce échoue immédiatement si un champ disparaît de
 *   `HYDRATABLE_FIELD_IDS` ou si la règle recap/manuel régresse.
 * - `getSelectedOptionText(id)`, avec un `document` minimal injecté
 *   (2-3 propriétés : `getElementById` renvoyant un faux `<select>` avec
 *   `selectedIndex`/`options`) : démontre que SI un `<select>` a bien la
 *   bonne valeur sélectionnée, la fonction en extrait le bon libellé — donc
 *   que la seconde moitié du bug (libellé erroné dans l'email) est bien
 *   corrigée dès lors que la première moitié (la valeur du select) l'est.
 *
 * Usage : `node scripts/test-estimation-ui.mjs` (ou `npm run test:estimation-ui`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLACES_SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "google-places.js");
const WIZARD_SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "estimation-wizard.js");
const UI_SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "estimation-ui.js");

const PLACES_SOURCE = readFileSync(PLACES_SCRIPT_PATH, "utf8");
const PLACES_SCRIPT = new vm.Script(PLACES_SOURCE, { filename: "google-places.js" });

const WIZARD_SOURCE = readFileSync(WIZARD_SCRIPT_PATH, "utf8");
const WIZARD_SCRIPT = new vm.Script(WIZARD_SOURCE, { filename: "estimation-wizard.js" });

const UI_SOURCE = readFileSync(UI_SCRIPT_PATH, "utf8");
const UI_SCRIPT = new vm.Script(UI_SOURCE, { filename: "estimation-ui.js" });

const API_SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "estimation-api.js");
const API_SOURCE = readFileSync(API_SCRIPT_PATH, "utf8");
const API_SCRIPT = new vm.Script(API_SOURCE, { filename: "estimation-api.js" });

const LEAD_SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "lead-api.js");
const LEAD_SOURCE = readFileSync(LEAD_SCRIPT_PATH, "utf8");
const LEAD_SCRIPT = new vm.Script(LEAD_SOURCE, { filename: "lead-api.js" });

const TRACKING_SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "tracking.js");
const TRACKING_SOURCE = readFileSync(TRACKING_SCRIPT_PATH, "utf8");
const TRACKING_SCRIPT = new vm.Script(TRACKING_SOURCE, { filename: "tracking.js" });

/**
 * @param {{document?: object}} [globals] `document` minimal optionnel, pour
 *   exercer les quelques fonctions qui en dépendent (`getSelectedOptionText`)
 *   sans tirer tout le câblage DOM du bloc `if (estimationFormEl) { ... }`
 *   (celui-ci reste inerte tant que `document.getElementById("estimationForm")`
 *   renvoie `null`/`undefined`, ce que nos faux `document` font toujours).
 */
function loadUiModule(globals) {
  if (globals && globals.document) {
    globalThis.document = globals.document;
  } else {
    delete globalThis.document;
  }

  // Ordre de production : google-places.js (`parseGooglePlace`,
  // `parseAddressQuery`, `loadGoogleMapsScript`) puis estimation-wizard.js
  // (`isFieldVisible`, `WIZARD_STEPS`...), enfin estimation-ui.js.
  PLACES_SCRIPT.runInThisContext();
  WIZARD_SCRIPT.runInThisContext();
  UI_SCRIPT.runInThisContext();

  return {
    computeConditionalVisibility: globalThis.computeConditionalVisibility,
    computeHydrationPlan: globalThis.computeHydrationPlan,
    isSameAddressInput: globalThis.isSameAddressInput,
    HYDRATABLE_FIELD_IDS: globalThis.HYDRATABLE_FIELD_IDS,
    appendToDatabase: globalThis.appendToDatabase,
    buildEmailTemplateParams: globalThis.buildEmailTemplateParams,
    getSelectedOptionText: globalThis.getSelectedOptionText,
  };
}

/** Faux `<select>` minimal : juste ce que lit `getSelectedOptionText`. */
function fakeSelect(value, optionSpecs) {
  var options = optionSpecs.map(function (spec) {
    return { value: spec.value, text: spec.text };
  });
  var selectedIndex = options.findIndex(function (o) {
    return o.value === value;
  });
  return { selectedIndex: selectedIndex, options: options };
}

function baseEstimationPayload(overrides) {
  return Object.assign(
    {
      propertyType: "appartement",
      address: "12 rue de la Paix, 75001 Paris, France",
      postalCode: "75001",
      city: "Paris",
      surface: 85,
      rooms: 3,
      dpe: "C",
      dpeRequest: "",
      isOwner: "yes",
      wantToSell: "yes",
      hasTerrain: "",
      terrainSize: "",
      name: "Jean Dupont",
      email: "jean.dupont@email.com",
      phone: "0612345678",
      estimation: {
        prixM2: 10000,
        estimationMin: 765000,
        estimationMax: 935000,
        estimationMoyenne: 850000,
      },
    },
    overrides || {}
  );
}

// ============================================================================
// computeConditionalVisibility — US-5, US-8 (dérivé de isFieldVisible, cf.
// estimation-wizard.js §1bis — pas de règle métier redéfinie ici)
// ============================================================================

test("computeConditionalVisibility — état par défaut : tout masqué", () => {
  const { computeConditionalVisibility } = loadUiModule();
  const result = computeConditionalVisibility({
    propertyType: "",
    hasTerrain: "",
    dpe: "",
    dpeRequest: "",
  });
  assert.deepEqual(result, {
    showTerrainQuestion: false,
    showTerrainSize: false,
    showDpeRequest: false,
    showRitmodiagCta: false,
    // Précisions facultatives de l'étape 3 : masquées tant que le type de bien
    // n'est pas choisi (règles portées par `WIZARD_STEPS[].conditionalFields`).
    showFloor: false,
    showElevator: false,
    showOutdoor: false,
    showCondition: false,
    showOptionalDetails: false,
  });
});

test("computeConditionalVisibility — appartement révèle étage, ascenseur, extérieur et état", () => {
  const { computeConditionalVisibility } = loadUiModule();
  const result = computeConditionalVisibility({ propertyType: "appartement" });
  assert.equal(result.showFloor, true);
  assert.equal(result.showElevator, true);
  assert.equal(result.showOutdoor, true);
  assert.equal(result.showCondition, true);
  assert.equal(result.showOptionalDetails, true);
});

test("computeConditionalVisibility — maison : ni étage ni ascenseur, mais extérieur et état", () => {
  const { computeConditionalVisibility } = loadUiModule();
  const result = computeConditionalVisibility({ propertyType: "maison" });
  assert.equal(result.showFloor, false);
  assert.equal(result.showElevator, false);
  assert.equal(result.showOutdoor, true);
  assert.equal(result.showCondition, true);
  assert.equal(result.showOptionalDetails, true);
});

test("computeConditionalVisibility — terrain : aucune précision facultative, bloc entier masqué", () => {
  const { computeConditionalVisibility } = loadUiModule();
  const result = computeConditionalVisibility({ propertyType: "terrain" });
  assert.equal(result.showFloor, false);
  assert.equal(result.showElevator, false);
  assert.equal(result.showOutdoor, false);
  assert.equal(result.showCondition, false);
  assert.equal(
    result.showOptionalDetails,
    false,
    "le conteneur et sa phrase d'aide doivent disparaître quand il est vide"
  );
});

test("computeConditionalVisibility — maison révèle la question terrain", () => {
  const { computeConditionalVisibility } = loadUiModule();
  const result = computeConditionalVisibility({ propertyType: "maison", hasTerrain: "" });
  assert.equal(result.showTerrainQuestion, true);
  assert.equal(result.showTerrainSize, false);
});

test("computeConditionalVisibility — maison + terrain 'yes' révèle la surface", () => {
  const { computeConditionalVisibility } = loadUiModule();
  const result = computeConditionalVisibility({ propertyType: "maison", hasTerrain: "yes" });
  assert.equal(result.showTerrainSize, true);
});

test("computeConditionalVisibility — showTerrainSize ne dépend QUE de hasTerrain (source unique de vérité)", () => {
  // `showTerrainSize` délègue à `isFieldVisible("terrainSize", data)`, dont
  // l'UNIQUE règle déclarée (WIZARD_STEPS[1].conditionalFields, cf.
  // estimation-wizard.js §1bis) ne teste que `hasTerrain === "yes"` — pas
  // `propertyType`. La cohérence avec `propertyType` n'est PAS revérifiée
  // ici en double : elle est garantie par la cascade de `wizard.updateField`
  // (`hasTerrain` est remis à '' dès que `propertyType` change, cf. la suite
  // "isFieldVisible" et "updateField — conditionnalité terrain en cascade"
  // de `test-estimation-wizard.mjs`). Un état "fantôme" hasTerrain==='yes'
  // avec propertyType !== 'maison' ne peut donc pas survenir via le wizard
  // en usage normal ; le construire à la main ici prouverait seulement
  // qu'on a réintroduit une double vérification — précisément ce que la
  // revue QA demandait de supprimer.
  const { computeConditionalVisibility } = loadUiModule();
  const result = computeConditionalVisibility({ propertyType: "maison", hasTerrain: "yes" });
  assert.equal(result.showTerrainSize, true);
});

test("computeConditionalVisibility — dpe 'unknown' révèle la question devis", () => {
  const { computeConditionalVisibility } = loadUiModule();
  const result = computeConditionalVisibility({ dpe: "unknown", dpeRequest: "" });
  assert.equal(result.showDpeRequest, true);
  assert.equal(result.showRitmodiagCta, false);
});

test("computeConditionalVisibility — dpeRequest 'yes' révèle le CTA RITMODiag", () => {
  const { computeConditionalVisibility } = loadUiModule();
  const result = computeConditionalVisibility({ dpe: "unknown", dpeRequest: "yes" });
  assert.equal(result.showRitmodiagCta, true);
});

// ============================================================================
// computeHydrationPlan — US-6, correctif QA (réhydratation après restore())
// ============================================================================

test("computeHydrationPlan — état vide (première visite) : rien à afficher", () => {
  const { computeHydrationPlan } = loadUiModule();
  const plan = computeHydrationPlan({});
  assert.deepEqual(plan.fieldValues, {});
  assert.equal(plan.showRecap, false);
  assert.equal(plan.showManual, false);
});

test("computeHydrationPlan — reprend TOUTES les valeurs des étapes 1 à 4 (US-6)", () => {
  const { computeHydrationPlan, HYDRATABLE_FIELD_IDS } = loadUiModule();
  const data = {
    address: "12 rue de la Paix",
    postalCode: "75001",
    city: "Paris",
    addressSource: "autocomplete",
    propertyType: "maison",
    hasTerrain: "yes",
    terrainSize: "500",
    surface: "85",
    rooms: "3",
    dpe: "C",
    dpeRequest: "",
    isOwner: "yes",
    wantToSell: "yes",
    // Étape 5 : jamais persistée, ne doit jamais apparaître dans le plan.
    name: "Jean Dupont",
    email: "jean@dupont.fr",
    phone: "0612345678",
  };

  const plan = computeHydrationPlan(data);

  HYDRATABLE_FIELD_IDS.forEach((id) => {
    assert.equal(plan.fieldValues[id], data[id], `${id} devrait être repris tel quel`);
  });
  assert.equal(plan.fieldValues.propertyType, "maison");
  assert.equal("name" in plan.fieldValues, false);
  assert.equal("email" in plan.fieldValues, false);
  assert.equal("phone" in plan.fieldValues, false);
});

test("computeHydrationPlan — adresse autocomplétée : réaffiche le récapitulatif, pas le bloc manuel", () => {
  const { computeHydrationPlan } = loadUiModule();
  const plan = computeHydrationPlan({
    postalCode: "75001",
    city: "Paris",
    addressSource: "autocomplete",
  });
  assert.equal(plan.showRecap, true);
  assert.equal(plan.showManual, false);
  assert.equal(plan.recapPostal, "75001");
  assert.equal(plan.recapCity, "Paris");
});

test("computeHydrationPlan — adresse saisie manuellement : réaffiche le bloc manuel, pas le récapitulatif", () => {
  const { computeHydrationPlan } = loadUiModule();
  const plan = computeHydrationPlan({
    postalCode: "75001",
    city: "Paris",
    addressSource: "manual",
  });
  assert.equal(plan.showRecap, false);
  assert.equal(plan.showManual, true);
});

test("computeHydrationPlan — addressSource 'autocomplete' mais CP/ville incomplets : pas de faux récapitulatif", () => {
  const { computeHydrationPlan } = loadUiModule();
  const plan = computeHydrationPlan({ postalCode: "75001", city: "", addressSource: "autocomplete" });
  assert.equal(plan.showRecap, false);
  // CP présent malgré tout -> on ouvre le bloc manuel plutôt que de tout masquer.
  assert.equal(plan.showManual, true);
});

// ============================================================================
// isSameAddressInput — pré-remplissage depuis l'accueil (?address=...)
// ============================================================================

test("isSameAddressInput — casse et espaces superflus ignorés", () => {
  const { isSameAddressInput } = loadUiModule();
  assert.equal(
    isSameAddressInput("12 rue de la Paix, Paris", "  12   RUE de la paix,  Paris "),
    true
  );
});

test("isSameAddressInput — deux biens différents => false (le wizard repart de l'étape 1)", () => {
  const { isSameAddressInput } = loadUiModule();
  assert.equal(isSameAddressInput("12 rue de la Paix", "45 avenue Foch"), false);
});

test("isSameAddressInput — valeurs vides/absentes équivalentes (premier passage)", () => {
  const { isSameAddressInput } = loadUiModule();
  assert.equal(isSameAddressInput("", undefined), true);
  assert.equal(isSameAddressInput("12 rue de la Paix", ""), false);
});

// ============================================================================
// appendToDatabase
// ============================================================================

test("appendToDatabase — ajoute sans muter le tableau d'origine", () => {
  const { appendToDatabase } = loadUiModule();
  const original = [{ id: 1 }];
  const next = appendToDatabase(original, { id: 2 });
  assert.deepEqual(original, [{ id: 1 }], "le tableau d'origine ne doit pas être muté");
  assert.deepEqual(next, [{ id: 1 }, { id: 2 }]);
});

test("appendToDatabase — tolère une entrée non-tableau (storage corrompu)", () => {
  const { appendToDatabase } = loadUiModule();
  const next = appendToDatabase(null, { id: 1 });
  assert.deepEqual(next, [{ id: 1 }]);
});

// ============================================================================
// buildEmailTemplateParams — non-régression stricte du corps de l'email
// ============================================================================

test("buildEmailTemplateParams — clés de premier niveau attendues par EmailJS", () => {
  const { buildEmailTemplateParams } = loadUiModule();
  const payload = baseEstimationPayload();
  const params = buildEmailTemplateParams(payload, {
    propertyTypeText: "Appartement",
    dpeText: "C — Bon",
    toEmail: "contact@estimer.co",
  });

  assert.deepEqual(Object.keys(params), [
    "from_name",
    "from_email",
    "phone",
    "subject",
    "message",
    "to_email",
  ]);
  assert.equal(params.from_name, payload.name);
  assert.equal(params.from_email, payload.email);
  assert.equal(params.phone, payload.phone);
  assert.equal(params.subject, "Nouvelle demande d'estimation immobiliere");
  assert.equal(params.to_email, "contact@estimer.co");
});

test("buildEmailTemplateParams — le message contient toutes les sections attendues", () => {
  const { buildEmailTemplateParams } = loadUiModule();
  const payload = baseEstimationPayload();
  const { message } = buildEmailTemplateParams(payload, {
    propertyTypeText: "Appartement",
    dpeText: "C — Bon",
  });

  assert.ok(message.includes("NOUVELLE DEMANDE D'ESTIMATION"));
  assert.ok(message.includes("INFORMATIONS DU BIEN"));
  assert.ok(message.includes("- Type de bien : Appartement"));
  assert.ok(message.includes(`- Adresse : ${payload.address}`));
  assert.ok(message.includes("- Code postal : 75001"));
  assert.ok(message.includes("- Ville : Paris"));
  assert.ok(message.includes("- Surface : 85 m²"));
  assert.ok(message.includes("- Nombre de pieces : 3"));
  assert.ok(message.includes("- DPE : C — Bon"));
  assert.ok(message.includes("SITUATION DU DEMANDEUR"));
  assert.ok(message.includes("- Proprietaire : Oui"));
  assert.ok(message.includes("- Souhaite vendre : Oui"));
  assert.ok(message.includes("ESTIMATION CALCULEE"));
  // Le séparateur de milliers produit par `toLocaleString("fr-FR")` dépend
  // des données ICU du runtime Node (espace normale U+0020 ou espace fine
  // insécable U+202F selon les versions) : on dérive la valeur attendue de
  // la même API plutôt que de coder en dur un caractère précis.
  assert.ok(message.includes(`- Prix au m² : ${(10000).toLocaleString("fr-FR")} €`));
  assert.ok(message.includes("COORDONNEES DU CLIENT"));
  assert.ok(message.includes(`- Nom : ${payload.name}`));
  assert.ok(message.includes(`- Email : ${payload.email}`));
  assert.ok(message.includes(`- Telephone : ${payload.phone}`));
});

test("buildEmailTemplateParams — la provenance est ajoutée après les coordonnées", () => {
  const { buildEmailTemplateParams } = loadUiModule();
  const { message } = buildEmailTemplateParams(baseEstimationPayload(), {
    acquisition: {
      gclid: "EAIaIQobCh",
      campaign: "gads_lead_proprietaire_idf_202608",
      landingPage: "/",
    },
  });

  // Ce chemin ne sert qu'en panne d'API : sans cette section, les seuls leads
  // sans provenance seraient ceux qu'on cherche justement à rattraper.
  assert.ok(message.indexOf("PROVENANCE") > message.indexOf("COORDONNEES DU CLIENT"));
  assert.ok(message.includes("- Campagne : gads_lead_proprietaire_idf_202608"));
  assert.ok(message.includes("- gclid : EAIaIQobCh"));
});

test("buildEmailTemplateParams — sans provenance, aucune section vide", () => {
  const { buildEmailTemplateParams } = loadUiModule();

  assert.equal(buildEmailTemplateParams(baseEstimationPayload(), {}).message.includes("PROVENANCE"), false);
  assert.equal(
    buildEmailTemplateParams(baseEstimationPayload(), { acquisition: {} }).message.includes(
      "PROVENANCE"
    ),
    false
  );
});

// ---------------------------------------------------------------------------
// Mode dégradé (specs/estimation-donnees-reelles.md §2.4, étape 3) : dans TOUS
// les cas d'échec de l'API, l'e-mail interne doit porter une mention explicite,
// sans quoi le lead serait traité comme une demande nominale alors que le
// chiffre n'a pas été calculé sur des transactions réelles.
// ---------------------------------------------------------------------------

test("buildEmailTemplateParams — estimation nominale : aucune mention de mode dégradé", () => {
  const { buildEmailTemplateParams } = loadUiModule();
  const { message } = buildEmailTemplateParams(
    baseEstimationPayload({ estimationStatus: "ok" }),
    {}
  );
  assert.equal(message.includes("ESTIMATION NON CALCULEE"), false);
  assert.ok(message.startsWith("NOUVELLE DEMANDE D'ESTIMATION"));
});

test("buildEmailTemplateParams — API indisponible + repli statique : mention explicite en tête", () => {
  const { buildEmailTemplateParams } = loadUiModule();
  const { message } = buildEmailTemplateParams(
    baseEstimationPayload({ estimationStatus: "static-fallback" }),
    {}
  );
  assert.ok(message.includes("ESTIMATION NON CALCULEE (API indisponible)"));
  assert.ok(message.includes("MODE DEGRADE"));
  assert.ok(
    message.indexOf("ESTIMATION NON CALCULEE") < message.indexOf("NOUVELLE DEMANDE"),
    "la mention doit précéder le corps du message"
  );
  assert.ok(message.includes("- Source du calcul : REPLI INTERNE (hors DVF) - API indisponible"));
});

test("buildEmailTemplateParams — estimation différée : mention explicite et aucune source", () => {
  const { buildEmailTemplateParams } = loadUiModule();
  const { message } = buildEmailTemplateParams(
    baseEstimationPayload({ estimationStatus: "deferred", estimation: null }),
    {}
  );
  assert.ok(message.includes("ESTIMATION NON CALCULEE (API indisponible)"));
  assert.ok(message.includes("- Source du calcul : AUCUNE - API indisponible"));
});

test("buildEmailTemplateParams — un `lastEstimation` sans estimationStatus est traité comme nominal", () => {
  const { buildEmailTemplateParams } = loadUiModule();
  // Non-régression : les payloads d'avant le Lot 3 n'ont pas cette clé.
  const { message } = buildEmailTemplateParams(baseEstimationPayload(), {});
  assert.equal(message.includes("ESTIMATION NON CALCULEE"), false);
});

test("buildEmailTemplateParams — les précisions facultatives n'apparaissent que si renseignées", () => {
  const { buildEmailTemplateParams } = loadUiModule();

  const sans = buildEmailTemplateParams(baseEstimationPayload(), {}).message;
  ["- Etage :", "- Ascenseur :", "- Exterieur :", "- Etat general :"].forEach((line) => {
    assert.equal(sans.includes(line), false, `${line} ne doit pas apparaître à vide`);
  });

  const avec = buildEmailTemplateParams(
    baseEstimationPayload({
      floor: "3",
      hasElevator: "yes",
      outdoor: "balcony",
      condition: "to-renovate",
    }),
    {}
  ).message;
  assert.ok(avec.includes("- Etage : 3"));
  assert.ok(avec.includes("- Ascenseur : Oui"));
  assert.ok(avec.includes("- Exterieur : Balcon"));
  assert.ok(avec.includes("- Etat general : A renover"));
});

test("buildEmailTemplateParams — pas de bloc Terrain pour un appartement", () => {
  const { buildEmailTemplateParams } = loadUiModule();
  const payload = baseEstimationPayload({ propertyType: "appartement" });
  const { message } = buildEmailTemplateParams(payload, {});
  assert.ok(!message.includes("- Terrain :"));
});

test("buildEmailTemplateParams — bloc Terrain présent pour une maison sans terrain", () => {
  const { buildEmailTemplateParams } = loadUiModule();
  const payload = baseEstimationPayload({ propertyType: "maison", hasTerrain: "no", terrainSize: "" });
  const { message } = buildEmailTemplateParams(payload, {});
  assert.ok(message.includes("- Terrain : Non"));
  assert.ok(!message.includes("- Surface du terrain"));
});

test("buildEmailTemplateParams — bloc Terrain + surface pour une maison avec terrain", () => {
  const { buildEmailTemplateParams } = loadUiModule();
  const payload = baseEstimationPayload({
    propertyType: "maison",
    hasTerrain: "yes",
    terrainSize: "500",
  });
  const { message } = buildEmailTemplateParams(payload, {});
  assert.ok(message.includes("- Terrain : Oui"));
  assert.ok(message.includes("- Surface du terrain : 500 m²"));
});

test("buildEmailTemplateParams — wantToSell 'maybe' => 'Peut-etre'", () => {
  const { buildEmailTemplateParams } = loadUiModule();
  const payload = baseEstimationPayload({ wantToSell: "maybe" });
  const { message } = buildEmailTemplateParams(payload, {});
  assert.ok(message.includes("- Souhaite vendre : Peut-etre"));
});

test("buildEmailTemplateParams — wantToSell 'no' => 'Non'", () => {
  const { buildEmailTemplateParams } = loadUiModule();
  const payload = baseEstimationPayload({ wantToSell: "no" });
  const { message } = buildEmailTemplateParams(payload, {});
  assert.ok(message.includes("- Souhaite vendre : Non"));
});

test("buildEmailTemplateParams — utilise payload.propertyType/dpe si aucun libellé fourni", () => {
  const { buildEmailTemplateParams } = loadUiModule();
  const payload = baseEstimationPayload({ propertyType: "terrain", dpe: "unknown" });
  const params = buildEmailTemplateParams(payload, {});
  assert.ok(params.message.includes("- Type de bien : terrain"));
  assert.ok(params.message.includes("- DPE : unknown"));
});

// ============================================================================
// getSelectedOptionText — défensif hors DOM, puis avec un <select> minimal injecté
// ============================================================================

test("getSelectedOptionText — renvoie '' sans throw quand document est absent", () => {
  const { getSelectedOptionText } = loadUiModule();
  assert.doesNotThrow(() => {
    assert.equal(getSelectedOptionText("propertyType"), "");
  });
});

test("getSelectedOptionText — extrait le bon libellé d'un <select> dont la valeur est déjà hydratée", () => {
  // Reproduit la seconde moitié du bug relevé en revue QA : SI la valeur du
  // <select> a bien été restaurée (ce que `computeHydrationPlan` garantit
  // désormais côté logique), le libellé lu à la soumission — celui qui part
  // dans le corps de l'email EmailJS — doit être le bon, pas le libellé par
  // défaut ("Sélectionnez un type").
  const propertyTypeOptions = [
    { value: "", text: "Sélectionnez un type" },
    { value: "appartement", text: "Appartement" },
    { value: "maison", text: "Maison" },
    { value: "terrain", text: "Terrain" },
    { value: "local-commercial", text: "Local commercial" },
  ];

  const fakeDocument = {
    getElementById(id) {
      if (id === "estimationForm") return null; // n'active jamais le câblage DOM complet.
      if (id === "propertyType") return fakeSelect("maison", propertyTypeOptions);
      return null;
    },
  };

  const { getSelectedOptionText } = loadUiModule({ document: fakeDocument });
  assert.equal(getSelectedOptionText("propertyType"), "Maison");
});

test("getSelectedOptionText — libellé par défaut si le <select> n'a jamais été hydraté (régression du bug initial)", () => {
  const propertyTypeOptions = [
    { value: "", text: "Sélectionnez un type" },
    { value: "maison", text: "Maison" },
  ];

  const fakeDocument = {
    getElementById(id) {
      if (id === "estimationForm") return null;
      if (id === "propertyType") return fakeSelect("", propertyTypeOptions);
      return null;
    },
  };

  const { getSelectedOptionText } = loadUiModule({ document: fakeDocument });
  assert.equal(
    getSelectedOptionText("propertyType"),
    "Sélectionnez un type",
    "sans hydratation, c'est exactement ce libellé erroné qui partait dans l'email avant correctif"
  );
});

// ============================================================================
// SOUMISSION FINALE — handleSubmit / finalizeSubmit
// ============================================================================
//
// Angle mort de tests relevé en revue QA (M9) : jusqu'ici ce fichier ne
// couvrait que des fonctions pures, alors que la soumission est LE seul code
// du lot devenu asynchrone — et c'est exactement là que le défaut de double
// soumission (B4) est passé.
//
// On exécute donc le câblage DOM complet d'`estimation-ui.js` (le bloc
// `if (estimationFormEl) { ... }`) dans un faux DOM minimal, sans jsdom :
// chaque élément n'implémente que les quelques propriétés réellement lues par
// le code (`value`, `hidden`, `disabled`, `innerHTML`, `textContent`,
// `addEventListener`, `focus`, `querySelector`). `fetch`, `emailjs`,
// `localStorage`, `sessionStorage` et `window.location` sont bouchonnés et
// journalisés, ce qui permet d'observer ce qui compte vraiment :
//   - COMBIEN d'appels `POST /v1/estimations` partent,
//   - COMBIEN de leads partent, et PAR QUEL CANAL,
//   - dans quel ORDRE surviennent l'envoi, la persistance et la redirection,
//   - si le formulaire redevient utilisable après un échec (drapeau relâché).
//
// DEUX CANAUX D'ENVOI, JAMAIS LES DEUX À LA FOIS
// ----------------------------------------------
// Depuis le passage aux e-mails transactionnels, le lead part par
// `POST /v1/leads` (API, gabarit rendu côté serveur, identifiants SMTP hors du
// navigateur). EmailJS n'est plus qu'un repli LEGACY, réservé aux cas où l'on
// SAIT qu'aucun e-mail n'est parti. Le harnais compte donc séparément
// `leadCalls` (canal nominal) et `emailSends` (repli), et les tests vérifient
// systématiquement que leur somme vaut 1 : un lead envoyé deux fois, c'est un
// prospect rappelé deux fois par deux conseillers.

/** Options d'un `<select>` du formulaire, dans l'ordre du markup. */
const SUBMIT_SELECT_OPTIONS = {
  propertyType: [
    { value: "", text: "Sélectionnez un type" },
    { value: "appartement", text: "Appartement" },
    { value: "maison", text: "Maison" },
    { value: "terrain", text: "Terrain" },
    { value: "local-commercial", text: "Local commercial" },
  ],
  hasTerrain: [
    { value: "", text: "Sélectionnez" },
    { value: "yes", text: "Oui" },
    { value: "no", text: "Non" },
  ],
  dpe: [
    { value: "", text: "Sélectionnez" },
    { value: "A", text: "A — Très performant" },
    { value: "C", text: "C — Bon" },
    { value: "unknown", text: "Je ne sais pas" },
  ],
  dpeRequest: [
    { value: "", text: "Sélectionnez" },
    { value: "yes", text: "Oui" },
    { value: "no", text: "Non" },
  ],
  hasElevator: [
    { value: "", text: "Sélectionnez" },
    { value: "yes", text: "Oui" },
    { value: "no", text: "Non" },
    { value: "unknown", text: "Ne sait pas" },
  ],
  outdoor: [
    { value: "", text: "Sélectionnez" },
    { value: "none", text: "Aucun" },
    { value: "balcony", text: "Balcon" },
  ],
  condition: [
    { value: "", text: "Sélectionnez" },
    { value: "good", text: "Bon" },
  ],
  isOwner: [
    { value: "", text: "Sélectionnez" },
    { value: "yes", text: "Oui" },
    { value: "no", text: "Non" },
  ],
  wantToSell: [
    { value: "", text: "Sélectionnez" },
    { value: "yes", text: "Oui" },
    { value: "maybe", text: "Peut-être" },
    { value: "no", text: "Non" },
  ],
};

/** Tous les `#id` de champ manipulés par le wizard (pour créer les `#id-error`). */
const SUBMIT_FIELD_IDS = [
  "address", "postalCode", "city",
  "propertyType", "hasTerrain", "terrainSize",
  "surface", "rooms", "dpe", "dpeRequest", "floor", "hasElevator", "outdoor", "condition",
  "isOwner", "wantToSell",
  "name", "email", "phone",
];

/** Résultat d'API nominal minimal (§5.3), suffisant pour `mapApiResultToLegacyEstimation`. */
function okApiResult(overrides) {
  return Object.assign(
    {
      value: 850000,
      pricePerSqm: 10000,
      range: { low: 765000, high: 935000, halfWidthPct: 0.1, basis: "iqr" },
      confidence: { score: 78, label: "high" },
      method: { kind: "comparables", level: "radius", radiusM: 500, comparablesCount: 24 },
      comparables: [],
      dataSource: { dataCoverage: "full", attributionFr: "Source : DVF (DGFiP)." },
      apiVersion: "1.0.0",
    },
    overrides || {}
  );
}

/**
 * Monte un faux DOM, exécute les quatre scripts de `/estimation` dans l'ordre
 * de production, et renvoie de quoi piloter le formulaire + observer les
 * effets de bord.
 *
 * @param {{responses?: Array<{status?:number, body?:object, networkError?:boolean}>,
 *          leadResponses?: Array<{status?:number, body?:object, networkError?:boolean, pending?:boolean}>,
 *          apiBaseUrl?: string,
 *          withoutLeadApi?: boolean,
 *          fallback?: string}} [config]
 */
function createSubmitHarness(config) {
  const cfg = config || {};
  const responses = cfg.responses || [{ status: 200, body: okApiResult() }];
  /*
   * Réponses de `POST /v1/leads` (e-mails transactionnels). Par défaut :
   * l'API accepte et envoie. `pending: true` simule un envoi ENCORE EN VOL —
   * indispensable pour rejouer le scénario bfcache, où la page gèle alors que
   * la requête d'envoi n'a pas répondu.
   */
  const leadResponses = cfg.leadResponses || [
    { status: 200, body: { status: "sent", reference: "REF123", acknowledgement: true } },
  ];

  const log = [];          // journal ordonné des effets de bord observables
  const fetchCalls = [];   // POST /v1/estimations
  const leadCalls = [];    // POST /v1/leads
  const emailSends = [];   // repli legacy EmailJS
  const focusLog = [];
  const consoleErrors = [];
  const elements = new Map();

  function onFocus(id) {
    focusLog.push(id);
  }

  function makeElement(id, tagName) {
    const listeners = {};
    const attributes = {};
    return {
      id: id,
      tagName: tagName || "INPUT",
      value: "",
      innerHTML: "",
      textContent: "",
      hidden: false,
      disabled: false,
      dataset: {},
      addEventListener(type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      dispatch(type, event) {
        (listeners[type] || []).forEach(function (fn) {
          fn(event || {});
        });
      },
      setAttribute(name, value) {
        attributes[name] = String(value);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
      },
      removeAttribute(name) {
        delete attributes[name];
      },
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(attributes, name);
      },
      focus() {
        onFocus(id);
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
  }

  function register(id, tagName) {
    const node = makeElement(id, tagName);
    elements.set(id, node);
    return node;
  }

  function registerSelect(id, options) {
    const node = register(id, "SELECT");
    node.options = options.map(function (option) {
      return { value: option.value, text: option.text };
    });
    let current = "";
    Object.defineProperty(node, "value", {
      configurable: true,
      enumerable: true,
      get() {
        return current;
      },
      set(next) {
        current = String(next);
        node.selectedIndex = node.options.findIndex(function (option) {
          return option.value === current;
        });
      },
    });
    node.value = "";
    return node;
  }

  // --- éléments du formulaire -------------------------------------------
  const form = register("estimationForm", "FORM");

  SUBMIT_FIELD_IDS.forEach(function (id) {
    if (SUBMIT_SELECT_OPTIONS[id]) registerSelect(id, SUBMIT_SELECT_OPTIONS[id]);
    else register(id, "INPUT");
    register(id + "-error", "P").hidden = true;
  });

  [
    "addressRecap", "addressRecapPostal", "addressRecapCity", "addressRecapEdit",
    "addressManual", "hasTerrainGroup", "terrainSizeGroup", "dpeRequestGroup",
    "ritmodiagLink", "optionalDetailsGroup", "floorGroup", "hasElevatorGroup",
    "outdoorGroup", "conditionGroup", "wizardSubmitStatus", "wizardSubmitStatusText",
    "wizardLiveRegion",
  ].forEach(function (id) {
    register(id, "DIV");
  });

  const prevBtn = register("wizardPrev", "BUTTON");
  const nextBtn = register("wizardNext", "BUTTON");
  const submitBtn = register("wizardSubmit", "BUTTON");
  submitBtn.innerHTML = "<span>Obtenir mon estimation</span>";

  const wizardAlert = makeElement("wizardAlert", "DIV");
  wizardAlert.hidden = true;

  const panels = [1, 2, 3, 4, 5].map(function (step) {
    const panel = makeElement("panel-" + step, "FIELDSET");
    panel.setAttribute("data-step", String(step));
    const heading = makeElement("heading-" + step, "H2");
    panel.querySelector = function (selector) {
      return selector === "h2" ? heading : null;
    };
    return panel;
  });

  form.querySelector = function (selector) {
    if (selector.charAt(0) === "#") {
      const id = selector.slice(1);
      return elements.has(id) ? elements.get(id) : null;
    }
    const stepMatch = /^\[data-step="(\d)"\]$/.exec(selector);
    if (stepMatch) return panels[Number(stepMatch[1]) - 1] || null;
    return null;
  };
  form.querySelectorAll = function (selector) {
    return selector === "[data-step]" ? panels : [];
  };
  form.requestSubmit = function () {
    // Reproduit fidèlement le comportement natif : `requestSubmit()` sans
    // soumetteur déclenche `submit` SANS consulter l'état `disabled` du
    // bouton d'envoi. C'est tout le nœud de B4.
    form.dispatch("submit", { preventDefault() {} });
  };

  // --- document / window / storages --------------------------------------
  const documentStub = {
    getElementById(id) {
      return elements.has(id) ? elements.get(id) : null;
    },
    querySelector(selector) {
      return selector === ".wizard-alert" ? wizardAlert : null;
    },
    head: { appendChild() {} },
    createElement(tagName) {
      return makeElement("created", String(tagName || "DIV").toUpperCase());
    },
  };

  const redirects = [];
  const locationStub = { search: "", pathname: "/estimation/" };
  let hrefValue = "https://estimer.co/estimation/";
  Object.defineProperty(locationStub, "href", {
    configurable: true,
    enumerable: true,
    get() {
      return hrefValue;
    },
    set(next) {
      hrefValue = String(next);
      redirects.push(hrefValue);
      log.push("redirect");
    },
  });

  // Écouteurs posés sur `window` par le code testé. Un seul usage aujourd'hui
  // (`pageshow`), mais le bouchon reste générique pour ne pas avoir à le
  // retoucher au prochain écouteur global.
  const windowListeners = {};
  const windowStub = {
    location: locationStub,
    history: { replaceState() {} },
    addEventListener(type, fn) {
      (windowListeners[type] = windowListeners[type] || []).push(fn);
    },
  };

  function makeStorage(logKeys) {
    const map = new Map();
    return {
      getItem(key) {
        return map.has(key) ? map.get(key) : null;
      },
      setItem(key, value) {
        map.set(key, String(value));
        if (logKeys && logKeys.indexOf(key) !== -1) log.push("persist:" + key);
      },
      removeItem(key) {
        map.delete(key);
      },
    };
  }

  const localStorageStub = makeStorage(["lastEstimation"]);
  const sessionStorageStub = makeStorage(null);

  // --- EmailJS ------------------------------------------------------------
  let settleEmail = null;
  const emailjsStub = {
    init() {},
    send(serviceId, templateId, params) {
      emailSends.push({ serviceId: serviceId, templateId: templateId, params: params });
      log.push("emailjs");
      return new Promise(function (resolve, reject) {
        settleEmail = { resolve: resolve, reject: reject };
      });
    },
  };

  // --- réseau -------------------------------------------------------------
  //
  // Deux endpoints distincts, deux journaux distincts : `POST /v1/estimations`
  // (le calcul) et `POST /v1/leads` (l'e-mail transactionnel). Le routage se
  // fait sur l'URL et non sur le rang d'appel — sans quoi ajouter un endpoint
  // décalerait silencieusement toutes les réponses bouchonnées.
  function fetchStub(url, init) {
    const isLead = String(url).indexOf("/v1/leads") !== -1;
    const calls = isLead ? leadCalls : fetchCalls;
    const specs = isLead ? leadResponses : responses;
    const index = Math.min(calls.length, specs.length - 1);
    const spec = specs[index] || {};

    calls.push({
      url: url,
      method: init && init.method,
      body: init && init.body ? JSON.parse(init.body) : null,
    });
    log.push(isLead ? "lead" : "fetch");

    if (spec.networkError) return Promise.reject(new Error("réseau indisponible (bouchon)"));
    // Requête qui ne répond jamais : le code appelant reste « en vol ».
    if (spec.pending) return new Promise(function () {});

    return Promise.resolve({
      status: spec.status === undefined ? 200 : spec.status,
      headers: {
        get() {
          return null;
        },
      },
      json() {
        return Promise.resolve(spec.body === undefined ? null : spec.body);
      },
    });
  }

  // --- installation des globales -----------------------------------------
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    CONFIG: globalThis.CONFIG,
    emailjs: globalThis.emailjs,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    consoleLog: console.log,
    consoleError: console.error,
  };

  globalThis.document = documentStub;
  globalThis.window = windowStub;
  globalThis.localStorage = localStorageStub;
  globalThis.sessionStorage = sessionStorageStub;
  /*
   * `apiBaseUrl: ""` simule un déploiement SANS API (état actuel de la prod
   * tant que `PUBLIC_API_URL` n'est pas posé) : ni le calcul ni l'envoi du
   * lead ne partent sur le réseau, et le parcours doit rester complet grâce
   * au repli statique et au repli EmailJS.
   */
  globalThis.CONFIG = {
    API: {
      BASE_URL: cfg.apiBaseUrl === undefined ? "https://api.test.local" : cfg.apiBaseUrl,
      FALLBACK: cfg.fallback || "static",
    },
    EMAILJS: { SERVICE_ID: "service_test", TEMPLATE_ID: "template_test", PUBLIC_KEY: "pk_test" },
    EMAIL: { TO: "contact@estimer.co" },
  };
  globalThis.emailjs = emailjsStub;
  globalThis.fetch = fetchStub;

  // Les délais longs du parcours (backoff de 1,5 s avant l'unique retry,
  // timeout de 6 s par tentative, minuteurs d'écran) sont compressés : les
  // tests exercent la LOGIQUE de retry, pas la patience de l'horloge.
  const realSetTimeout = saved.setTimeout;
  globalThis.setTimeout = function (fn, delay) {
    const args = Array.prototype.slice.call(arguments, 2);
    return realSetTimeout.apply(null, [fn, delay >= 1000 ? 5 : delay].concat(args));
  };

  console.log = function () {};
  console.error = function () {
    consoleErrors.push(Array.prototype.join.call(arguments, " "));
  };

  /*
   * Ordre de production, celui d'`estimation.astro` : google-places,
   * estimation-wizard, estimation-api, lead-api, puis estimation-ui — qui
   * consomme les globales des quatre précédents.
   *
   * `lead-api.js` est chargé SAUF si le scénario demande explicitement son
   * absence (`withoutLeadApi`), ce qui simule une page qui aurait oublié le
   * script : `estimation-ui.js` doit alors se rabattre sur EmailJS plutôt que
   * de casser toute la soumission sur une `ReferenceError`.
   */
  /*
   * `tracking.js` (socle de mesure) est écrit dans le `<head>` par
   * `Tracking.astro`, donc AVANT tout script de page — et seulement si un
   * conteneur de tags est configuré. Les scénarios qui ne demandent pas la
   * mesure neutralisent donc `embTrack`, comme le fait `withoutLeadApi` pour
   * `requestLead` : c'est ce que voient les gardes `typeof … === "function"`
   * d'`estimation-ui.js`, et c'est aussi ce qui empêche un scénario d'hériter
   * du `dataLayer` du précédent (`runInThisContext` crée des globales non
   * configurables, impossibles à supprimer).
   */
  if (cfg.mesure) {
    windowStub.dataLayer = [];
    TRACKING_SCRIPT.runInThisContext();
  } else {
    globalThis.embTrack = undefined;
  }

  PLACES_SCRIPT.runInThisContext();
  WIZARD_SCRIPT.runInThisContext();
  API_SCRIPT.runInThisContext();
  if (cfg.withoutLeadApi) {
    // `runInThisContext` crée des globales non configurables : on ne peut pas
    // les `delete`, on les neutralise en les remettant à `undefined` — ce que
    // voient les gardes `typeof … !== "function"` d'`estimation-ui.js`.
    globalThis.requestLead = undefined;
    globalThis.buildEstimationLeadPayload = undefined;
    globalThis.shouldUseLegacyFallback = undefined;
  } else {
    LEAD_SCRIPT.runInThisContext();
  }
  UI_SCRIPT.runInThisContext();

  function setField(id, value) {
    const node = elements.get(id);
    node.value = value;
    node.dispatch(node.tagName === "SELECT" ? "change" : "input", {});
  }

  return {
    log: log,
    fetchCalls: fetchCalls,
    leadCalls: leadCalls,
    emailSends: emailSends,
    /** Corps JSON du dernier `POST /v1/leads`, ou `null`. */
    lastLeadBody() {
      return leadCalls.length ? leadCalls[leadCalls.length - 1].body : null;
    },
    redirects: redirects,
    /** Événements poussés dans le dataLayer (scénarios `mesure: true`). */
    pousses(nom) {
      const tous = windowStub.dataLayer || [];
      return nom
        ? tous.filter(function (charge) {
            return charge && charge.event === nom;
          })
        : tous;
    },
    focusLog: focusLog,
    consoleErrors: consoleErrors,
    submitBtn: submitBtn,
    wizardAlert: wizardAlert,
    element(id) {
      return elements.get(id) || null;
    },
    /** Étape actuellement visible, déduite du DOM (comme un utilisateur la voit). */
    visibleStep() {
      for (let i = 0; i < panels.length; i++) {
        if (!panels[i].hidden) return i + 1;
      }
      return null;
    },
    setField: setField,
    clickNext() {
      nextBtn.dispatch("click", {});
    },
    /** Remplit les étapes 1 à 5 avec des données valides, via de vrais événements DOM. */
    fillValidForm() {
      setField("address", "12 rue de la Paix, 75001 Paris, France");
      setField("postalCode", "75001");
      setField("city", "Paris");
      this.clickNext();
      setField("propertyType", "appartement");
      this.clickNext();
      setField("surface", "85");
      setField("rooms", "3");
      setField("dpe", "C");
      this.clickNext();
      setField("isOwner", "yes");
      setField("wantToSell", "yes");
      this.clickNext();
      setField("name", "Jean Dupont");
      setField("email", "jean.dupont@email.com");
      setField("phone", "0612345678");
    },
    /** Soumission « bouton » (événement submit du formulaire). */
    submit() {
      form.dispatch("submit", { preventDefault() {} });
    },
    /**
     * Soumission « clavier » (US-7) : Entrée depuis un champ de la dernière
     * étape -> `form.requestSubmit()`. C'est le chemin exact de B4.
     */
    pressEnterOn(fieldId) {
      form.dispatch("keydown", {
        key: "Enter",
        target: elements.get(fieldId),
        preventDefault() {},
      });
    },
    /**
     * Émet un `pageshow` sur `window`.
     *
     * @param {boolean} persisted `true` = la page est restaurée depuis le
     *   bfcache (retour arrière depuis /rapport/, closures intactes) ;
     *   `false` = `pageshow` de chargement ordinaire, qui suit chaque
     *   navigation normale et ne doit RIEN relâcher.
     */
    firePageshow(persisted) {
      (windowListeners.pageshow || []).forEach(function (fn) {
        fn({ persisted: !!persisted });
      });
    },
    /** Nombre d'écouteurs `pageshow` réellement posés par le code de production. */
    pageshowListenerCount() {
      return (windowListeners.pageshow || []).length;
    },
    lastEstimation() {
      const raw = localStorageStub.getItem("lastEstimation");
      return raw ? JSON.parse(raw) : null;
    },
    estimationDatabase() {
      const raw = localStorageStub.getItem("estimationDatabase");
      return raw ? JSON.parse(raw) : null;
    },
    resolveEmail(value) {
      if (settleEmail) settleEmail.resolve(value || { status: 200, text: "OK" });
    },
    rejectEmail(error) {
      if (settleEmail) settleEmail.reject(error || new Error("EmailJS indisponible"));
    },
    /** Attend qu'une condition observable soit vraie (ou échoue au bout de 2 s). */
    async waitFor(predicate, description) {
      const deadline = Date.now() + 2000;
      while (!predicate()) {
        if (Date.now() > deadline) {
          throw new Error("Condition jamais atteinte : " + (description || "?"));
        }
        await new Promise(function (resolve) {
          realSetTimeout(resolve, 2);
        });
      }
      await new Promise(function (resolve) {
        realSetTimeout(resolve, 5);
      });
    },
    /** Laisse simplement se vider les microtâches et les minuteurs compressés. */
    async settle(ms) {
      await new Promise(function (resolve) {
        realSetTimeout(resolve, ms === undefined ? 30 : ms);
      });
    },
    restore() {
      globalThis.setTimeout = saved.setTimeout;
      console.log = saved.consoleLog;
      console.error = saved.consoleError;
      if (saved.document === undefined) delete globalThis.document;
      else globalThis.document = saved.document;
      if (saved.window === undefined) delete globalThis.window;
      else globalThis.window = saved.window;
      if (saved.localStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = saved.localStorage;
      if (saved.sessionStorage === undefined) delete globalThis.sessionStorage;
      else globalThis.sessionStorage = saved.sessionStorage;
      if (saved.CONFIG === undefined) delete globalThis.CONFIG;
      else globalThis.CONFIG = saved.CONFIG;
      if (saved.emailjs === undefined) delete globalThis.emailjs;
      else globalThis.emailjs = saved.emailjs;
      if (saved.fetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = saved.fetch;
    },
  };
}

/** Monte le harnais, exécute le scénario, démonte quoi qu'il arrive. */
async function withSubmitHarness(config, scenario) {
  const harness = createSubmitHarness(config);
  try {
    await scenario(harness);
  } finally {
    harness.restore();
  }
}

// ---------------------------------------------------------------------------
// Le harnais lui-même doit être crédible : s'il ne conduisait pas réellement
// l'utilisateur jusqu'à l'étape 5, tous les tests suivants passeraient à vide.
// ---------------------------------------------------------------------------

test("harnais de soumission — le formulaire rempli mène bien à l'étape 5", async () => {
  await withSubmitHarness({}, async (h) => {
    assert.equal(h.visibleStep(), 1, "on démarre à l'étape 1");
    h.fillValidForm();
    assert.equal(h.visibleStep(), 5, "les 4 « Suivant » doivent avoir été acceptés");
    assert.equal(h.fetchCalls.length, 0, "aucun appel API avant la soumission");
  });
});

// ---------------------------------------------------------------------------
// B4 — DOUBLE SOUMISSION
// ---------------------------------------------------------------------------

test("B4 — deux Entrée rapprochées ne produisent QU'UN appel API, QU'UN lead, QU'UNE redirection", async () => {
  await withSubmitHarness({ responses: [{ status: 200, body: okApiResult() }] }, async (h) => {
    h.fillValidForm();

    // Deux appuis sur Entrée pendant la fenêtre d'appel API. `requestSubmit()`
    // ignore `submitBtn.disabled` : avant le correctif, ce scénario produisait
    // deux POST /v1/estimations, deux e-mails (lead dupliqué) et deux
    // redirections.
    h.pressEnterOn("name");
    h.pressEnterOn("name");

    await h.waitFor(() => h.redirects.length > 0, "redirection vers /rapport/");

    assert.equal(h.fetchCalls.length, 1, "un seul POST /v1/estimations");
    assert.equal(h.leadCalls.length, 1, "un seul POST /v1/leads (pas de lead dupliqué)");
    assert.equal(h.emailSends.length, 0, "l'API a envoyé : aucun repli EmailJS");
    assert.equal(h.redirects.length, 1, "une seule redirection");
    assert.deepEqual(h.redirects, ["/rapport/"]);
    assert.equal(
      h.estimationDatabase().length,
      1,
      "une seule estimation ajoutée à l'historique local"
    );
  });
});

test("B4 — une troisième soumission pendant l'appel en vol reste sans effet", async () => {
  await withSubmitHarness({ responses: [{ status: 200, body: okApiResult() }] }, async (h) => {
    h.fillValidForm();
    h.submit();
    h.submit();
    h.pressEnterOn("email");

    await h.waitFor(() => h.redirects.length > 0, "redirection vers /rapport/");

    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.leadCalls.length, 1);
    assert.equal(h.emailSends.length, 0);
    assert.equal(h.redirects.length, 1);
  });
});

test("B4 — le drapeau n'est jamais posé quand l'étape 5 est invalide (le formulaire reste soumettable)", async () => {
  await withSubmitHarness({ responses: [{ status: 200, body: okApiResult() }] }, async (h) => {
    h.fillValidForm();
    h.setField("email", "pas-un-email"); // invalide -> validateStep(5) échoue

    h.submit();
    assert.equal(h.fetchCalls.length, 0, "une saisie invalide ne doit générer aucun appel API");
    assert.equal(h.element("email-error").hidden, false);

    h.setField("email", "jean.dupont@email.com");
    h.submit();
    await h.waitFor(() => h.redirects.length > 0, "redirection après correction");
    assert.equal(h.fetchCalls.length, 1, "la soumission suivante doit bien partir");
  });
});

// ---------------------------------------------------------------------------
// RETOUR ARRIÈRE BFCACHE — le pendant obligatoire de B4
//
// `finalizeSubmit` laisse volontairement `submitInFlight` à `true` sur les
// chemins qui redirigent : c'est ce qui ferme la fenêtre de double soumission
// pendant la navigation. Mais un « Précédent » depuis /rapport/ ne recharge
// PAS la page : le navigateur la restaure depuis le bfcache avec ses closures
// intactes, drapeau compris. Sans écouteur `pageshow`, le formulaire revient
// à l'écran, réactivé par la fin de l'envoi du lead... et n'envoie plus jamais
// rien, sans le moindre message. Revenir corriger une saisie après avoir vu
// son estimation est un geste courant : c'est un lead perdu en silence.
// ---------------------------------------------------------------------------

test("bfcache — après un retour arrière depuis /rapport/, une nouvelle soumission repart normalement", async () => {
  await withSubmitHarness(
    {
      responses: [
        { status: 200, body: okApiResult() },
        { status: 200, body: okApiResult() },
      ],
    },
    async (h) => {
      // 1. Soumission complète : appel API, lead, persistance, redirection.
      h.fillValidForm();
      h.submit();
      await h.waitFor(() => h.redirects.length > 0, "redirection vers /rapport/");
      assert.equal(h.fetchCalls.length, 1);
      assert.equal(h.leadCalls.length, 1);
      assert.equal(h.emailSends.length, 0);

      // Le lead API s'est résolu avant le gel de la page : le bouton redevient
      // cliquable alors que `submitInFlight` reste, lui, à `true`. C'est
      // exactement l'état trompeur que le bfcache va restaurer.
      await h.settle();
      assert.equal(h.submitBtn.disabled, false, "le bouton est bien réactivé avant le gel");

      // 2. Retour arrière : restauration depuis le bfcache.
      h.firePageshow(true);

      // 3. L'utilisateur corrige puis resoumet : ça doit repartir.
      h.setField("surface", "90");
      h.submit();

      await h.waitFor(() => h.redirects.length > 1, "seconde redirection vers /rapport/");
      assert.equal(h.fetchCalls.length, 2, "un second POST /v1/estimations doit partir");
      assert.equal(h.leadCalls.length, 2, "un second POST /v1/leads doit partir");
      assert.equal(h.emailSends.length, 0, "aucun repli EmailJS sur le chemin API nominal");
    }
  );
});

test("bfcache — l'état visuel du bouton est remis au repos, même si EmailJS était encore en vol au gel", async () => {
  await withSubmitHarness(
    { responses: [{ status: 200, body: okApiResult() }], withoutLeadApi: true },
    async (h) => {
    const idleHTML = h.submitBtn.innerHTML;

    h.fillValidForm();
    h.submit();
    await h.waitFor(() => h.redirects.length > 0, "redirection vers /rapport/");

    // On NE résout PAS la promesse EmailJS : au gel de la page, le bouton est
    // resté sur « Envoi en cours... » et `disabled`. Le restaurer tel quel
    // remplacerait un blocage silencieux par un affichage mensonger.
    assert.equal(h.submitBtn.disabled, true, "prémisse : bouton figé au moment du gel");

    h.firePageshow(true);

    assert.equal(h.submitBtn.disabled, false, "le bouton doit être de nouveau actionnable");
    assert.equal(h.submitBtn.innerHTML, idleHTML, "le libellé d'origine doit être restauré");
    assert.equal(h.submitBtn.getAttribute("aria-busy"), null, "plus aucune occupation annoncée");
    assert.equal(
      h.element("wizardSubmitStatus").hidden,
      true,
      "le message de progression ne doit pas subsister sur un formulaire au repos"
    );
    }
  );
});

test("bfcache — un `pageshow` ordinaire (persisted=false) ne relâche PAS le drapeau (non-régression B4)", async () => {
  await withSubmitHarness({ responses: [{ status: 200, body: okApiResult() }] }, async (h) => {
    assert.equal(
      h.pageshowListenerCount(),
      1,
      "prémisse : un écouteur `pageshow` est bien posé par le code de production"
    );

    h.fillValidForm();
    h.submit();

    // Toujours dans la fenêtre d'appel en vol (la réponse `fetch` ne sera lue
    // qu'à la prochaine microtâche). Un `pageshow` de chargement ordinaire —
    // celui qui suit CHAQUE navigation, bfcache ou non — ne doit rien relâcher
    // ici, sinon on rouvre exactement la double soumission de B4.
    assert.equal(h.submitBtn.disabled, true, "prémisse : soumission en vol");
    h.firePageshow(false);

    assert.equal(h.submitBtn.disabled, true, "le bouton reste occupé pendant l'appel");
    h.submit();
    h.pressEnterOn("name");

    await h.waitFor(() => h.redirects.length > 0, "redirection vers /rapport/");
    await h.settle();

    assert.equal(h.fetchCalls.length, 1, "un seul POST /v1/estimations");
    assert.equal(h.leadCalls.length, 1, "un seul POST /v1/leads");
    assert.equal(h.emailSends.length, 0, "aucun repli EmailJS");
    assert.equal(h.redirects.length, 1, "une seule redirection");
  });
});

// ---------------------------------------------------------------------------
// Ordre EmailJS (non bloquant) -> persistance -> redirection (US-10)
// ---------------------------------------------------------------------------

test("ordre de soumission — EmailJS puis persistance puis redirection, sans attendre la réponse EmailJS", async () => {
  await withSubmitHarness({ responses: [{ status: 200, body: okApiResult() }] }, async (h) => {
    h.fillValidForm();
    h.submit();

    await h.waitFor(() => h.redirects.length > 0, "redirection vers /rapport/");

    // La promesse EmailJS n'a toujours PAS été résolue à ce stade : la
    // redirection ne doit pas en dépendre (US-10, « Échec d'envoi EmailJS »).
    assert.deepEqual(
      h.log.filter((entry) => entry !== "fetch"),
      ["lead", "persist:lastEstimation", "redirect"]
    );

    const stored = h.lastEstimation();
    assert.equal(stored.estimationStatus, "ok");
    assert.equal(stored.estimation.estimationMoyenne, 850000);
    assert.equal(stored.name, "Jean Dupont", "les PII restent côté front (localStorage + EmailJS)");
    // ... mais ne partent JAMAIS à l'API (§2.6).
    assert.equal("name" in h.fetchCalls[0].body, false);
    assert.equal("email" in h.fetchCalls[0].body, false);
    assert.equal("phone" in h.fetchCalls[0].body, false);
  });
});

test("ordre de soumission — un échec EmailJS ne change ni la persistance ni la redirection", async () => {
  await withSubmitHarness(
    { responses: [{ status: 200, body: okApiResult() }], withoutLeadApi: true },
    async (h) => {
    h.fillValidForm();
    h.submit();
    await h.waitFor(() => h.redirects.length > 0, "redirection vers /rapport/");

    h.rejectEmail(new Error("EmailJS HS"));
    await h.settle();

    assert.equal(h.redirects.length, 1);
    assert.ok(h.lastEstimation(), "`lastEstimation` reste écrite malgré l'échec d'e-mail");
    }
  );
});

// ---------------------------------------------------------------------------
// 422 — donnée invalide : aucun chiffre, aucun lead, retour au champ fautif
// ---------------------------------------------------------------------------

test("422 — pas de redirection, pas de `lastEstimation`, pas d'e-mail, retour au champ fautif", async () => {
  await withSubmitHarness(
    {
      responses: [
        {
          status: 422,
          body: {
            code: "VALIDATION_ERROR",
            message: "Certaines informations doivent être corrigées.",
            errors: [
              { field: "surface", rule: "range", message: "La surface doit être comprise entre 9 et 1 000 m²." },
            ],
          },
        },
      ],
    },
    async (h) => {
      h.fillValidForm();
      h.submit();

      await h.waitFor(() => h.element("surface-error").hidden === false, "erreur sous #surface");

      assert.equal(h.fetchCalls.length, 1, "un 422 n'est jamais rejoué");
      assert.equal(h.emailSends.length, 0, "aucun lead pour une demande invalide");
      assert.equal(h.redirects.length, 0, "aucune redirection");
      assert.equal(h.lastEstimation(), null, "aucune estimation écrite");
      assert.equal(h.visibleStep(), 3, "retour sur l'étape du champ fautif");
      assert.equal(
        h.element("surface-error").textContent,
        "La surface doit être comprise entre 9 et 1 000 m²."
      );
      assert.ok(h.focusLog.includes("surface"), "le focus revient sur le champ fautif");
      assert.equal(h.submitBtn.disabled, false, "le bouton est réactivé");
    }
  );
});

test("422 — le drapeau est relâché : corriger puis resoumettre déclenche bien un nouvel appel", async () => {
  await withSubmitHarness(
    {
      responses: [
        {
          status: 422,
          body: {
            code: "VALIDATION_ERROR",
            errors: [{ field: "surface", message: "Surface invalide." }],
          },
        },
        { status: 200, body: okApiResult() },
      ],
    },
    async (h) => {
      h.fillValidForm();
      h.submit();
      await h.waitFor(() => h.element("surface-error").hidden === false, "erreur sous #surface");

      h.setField("surface", "85");
      h.clickNext();
      h.clickNext();
      assert.equal(h.visibleStep(), 5);
      h.submit();

      await h.waitFor(() => h.redirects.length > 0, "redirection après correction");
      assert.equal(h.fetchCalls.length, 2, "la seconde soumission doit repartir");
      assert.equal(h.leadCalls.length, 1);
      assert.equal(h.emailSends.length, 0);
    }
  );
});

// ---------------------------------------------------------------------------
// 429 — quota : un seul appel, aucun retry (US-8), message affiché
// ---------------------------------------------------------------------------

test("429 — un seul appel, aucun retry, message explicite, aucune redirection", async () => {
  await withSubmitHarness(
    {
      responses: [
        { status: 429, body: { code: "RATE_LIMITED", retryAfter: 42 } },
        { status: 200, body: okApiResult() },
      ],
    },
    async (h) => {
      h.fillValidForm();
      h.submit();

      await h.waitFor(() => h.wizardAlert.hidden === false, "bannière d'alerte");
      await h.settle();

      assert.equal(h.fetchCalls.length, 1, "le front n'effectue AUCUN retry sur 429 (US-8)");
      assert.equal(h.emailSends.length, 0);
      assert.equal(h.redirects.length, 0);
      assert.equal(h.lastEstimation(), null);
      assert.match(h.wizardAlert.textContent, /Trop de demandes/);
      assert.match(h.wizardAlert.textContent, /42 secondes/);
      assert.equal(h.submitBtn.disabled, false);
    }
  );
});

test("429 — le drapeau est relâché : l'utilisateur peut réessayer lui-même", async () => {
  await withSubmitHarness(
    {
      responses: [
        { status: 429, body: { code: "RATE_LIMITED" } },
        { status: 200, body: okApiResult() },
      ],
    },
    async (h) => {
      h.fillValidForm();
      h.submit();
      await h.waitFor(() => h.wizardAlert.hidden === false, "bannière d'alerte");

      h.submit();
      await h.waitFor(() => h.redirects.length > 0, "redirection au second essai");
      assert.equal(h.fetchCalls.length, 2, "un second essai manuel doit être possible");
    }
  );
});

// ---------------------------------------------------------------------------
// 5xx — exactement 2 tentatives (1 + 1 retry) puis repli statique
// ---------------------------------------------------------------------------

test("5xx — exactement 2 appels (1 + 1 retry) puis `static-fallback` affiché quand même", async () => {
  await withSubmitHarness(
    { responses: [{ status: 503, body: { code: "SERVICE_UNAVAILABLE" } }] },
    async (h) => {
      h.fillValidForm();
      h.submit();

      await h.waitFor(() => h.redirects.length > 0, "redirection vers /rapport/");

      assert.equal(h.fetchCalls.length, 2, "1 tentative + 1 unique retry");
      assert.equal(h.leadCalls.length, 1, "le lead transactionnel part avec le statut de mode dégradé");
      assert.equal(h.emailSends.length, 0, "aucun repli EmailJS si l'API lead accepte");
      assert.equal(h.redirects.length, 1);

      const stored = h.lastEstimation();
      assert.equal(stored.estimationStatus, "static-fallback");
      assert.ok(stored.estimation.estimationMoyenne > 0, "un prix de repli est bien affiché");
      assert.equal(
        h.lastLeadBody().estimation.status,
        "static-fallback",
        "l'API transactionnelle reçoit le statut de mode dégradé"
      );
    }
  );
});

test("erreur réseau + FALLBACK=none — estimation différée, aucun chiffre inventé", async () => {
  await withSubmitHarness(
    { fallback: "none", responses: [{ networkError: true }] },
    async (h) => {
      h.fillValidForm();
      h.submit();

      await h.waitFor(() => h.redirects.length > 0, "redirection vers /rapport/");

      assert.equal(h.fetchCalls.length, 2, "1 tentative + 1 unique retry");
      const stored = h.lastEstimation();
      assert.equal(stored.estimationStatus, "deferred");
      assert.equal(stored.estimation, null, "aucune valeur ne doit être inventée");
    }
  );
});

// ---------------------------------------------------------------------------
// Le drapeau doit être relâché sur CHAQUE chemin qui laisse l'utilisateur sur
// le formulaire — y compris un chemin d'erreur imprévu.
// ---------------------------------------------------------------------------

test("chemin d'erreur imprévu — le formulaire redevient soumettable (drapeau jamais bloqué à true)", async () => {
  await withSubmitHarness(
    {
      withoutLeadApi: true,
      responses: [
        // 200 sans corps exploitable : `requestEstimation` renvoie un échec
        // `deferred`, et le repli statique prend la main. On force ensuite une
        // exception dans la suite de la soumission pour vérifier le filet.
        { status: 200, body: okApiResult() },
        { status: 200, body: okApiResult() },
      ],
    },
    async (h) => {
      h.fillValidForm();

      // `localStorage.setItem` qui throw (quota, mode privé Safari) est déjà
      // capté par `persistEstimation` ; on casse ici plus tôt, dans le calcul
      // du corps de l'e-mail, pour simuler une exception vraiment imprévue.
      const realSend = globalThis.emailjs.send;
      globalThis.emailjs.send = function () {
        throw new TypeError("panne imprévue dans EmailJS");
      };

      h.submit();
      await h.waitFor(
        () => h.submitBtn.disabled === false,
        "bouton réactivé après l'exception"
      );

      assert.equal(h.redirects.length, 0, "aucune redirection sur ce chemin");
      assert.match(h.wizardAlert.textContent, /erreur inattendue/i);

      globalThis.emailjs.send = realSend;
      h.submit();
      await h.waitFor(() => h.redirects.length > 0, "seconde soumission acceptée");
      assert.equal(h.fetchCalls.length, 2, "le formulaire n'est pas resté bloqué");
    }
  );
});

// ===========================================================================
// Mesure du tunnel — specs/plan-taggage-conversions.md §4.2
// ===========================================================================
//
// L'entonnoir d'estimation est l'objet même du plan de taggage : c'est lui qui
// dira où les visiteurs achetés en publicité abandonnent. Un événement de trop
// ou de moins, et le taux d'abandon d'une étape devient faux sans que rien ne
// le signale.

test("mesure — l'entrée dans le tunnel n'est annoncée qu'une fois", async () => {
  await withSubmitHarness({ mesure: true }, async (h) => {
    const demarrages = h.pousses("estimation_start");

    assert.equal(demarrages.length, 1);
    assert.equal(demarrages[0].entry_point, "direct");
    // `false` est une information, pas une absence : le filtre d'`embTrack`
    // n'écarte que null / undefined / chaîne vide.
    assert.equal(demarrages[0].has_address_prefill, false);

    // Et une seule vue d'étape à l'arrivée : la séquence d'initialisation
    // (restauration, pré-remplissage) appelle `next()`/`goToStep()` plusieurs
    // fois, ce que le verrou `mesureActive` doit absorber en silence.
    const vues = h.pousses("estimation_step_view");
    assert.equal(vues.length, 1);
    assert.deepEqual(vues[0], {
      event: "estimation_step_view",
      step_number: 1,
      step_key: "address",
      step_direction: "forward",
    });
  });
});

test("mesure — chaque étape franchie produit une vue, dans le bon sens", async () => {
  await withSubmitHarness({ mesure: true }, async (h) => {
    h.setField("address", "12 rue de la Paix, 75001 Paris, France");
    h.setField("postalCode", "75001");
    h.setField("city", "Paris");
    h.clickNext();
    h.setField("propertyType", "appartement");
    h.clickNext();

    assert.deepEqual(
      h.pousses("estimation_step_view").map((e) => [e.step_number, e.step_key, e.step_direction]),
      [
        [1, "address", "forward"],
        [2, "property", "forward"],
        [3, "characteristics", "forward"],
      ]
    );

    // Retour arrière : c'est une vue d'étape, pas un abandon.
    h.element("wizardPrev").dispatch("click", {});
    const vues = h.pousses("estimation_step_view");
    assert.deepEqual(
      [vues[vues.length - 1].step_number, vues[vues.length - 1].step_direction],
      [2, "backward"]
    );
  });
});

test("mesure — l'adresse validée est mesurée une fois, quel qu'en soit le chemin", async () => {
  await withSubmitHarness({ mesure: true }, async (h) => {
    h.setField("address", "12 rue de la Paix, 75001 Paris, France");
    h.setField("postalCode", "75001");
    h.setField("city", "Paris");
    h.clickNext();

    const adresses = h.pousses("estimation_address_selected");
    assert.equal(adresses.length, 1);
    assert.equal(adresses[0].postal_code, "75001");
    assert.equal(adresses[0].city, "Paris");
    assert.equal(adresses[0].departement_code, "75");
    // Saisie libre, sans suggestion Google retenue.
    assert.equal(adresses[0].address_source, "manual");
    // La rue elle-même n'a rien à faire dans le dataLayer (plan §2.6).
    assert.equal("address" in adresses[0], false);

    // Aller-retour sur l'étape 1 : l'adresse n'est pas « re-validée ».
    h.element("wizardPrev").dispatch("click", {});
    h.clickNext();
    assert.equal(h.pousses("estimation_address_selected").length, 1);
  });
});

test("mesure — un champ manquant remonte les NOMS des champs fautifs", async () => {
  await withSubmitHarness({ mesure: true }, async (h) => {
    h.setField("address", "12 rue de la Paix");
    // Ni code postal ni ville : la validation de l'étape 1 doit bloquer.
    h.clickNext();

    const erreurs = h.pousses("estimation_step_error");
    assert.equal(erreurs.length, 1);
    assert.equal(erreurs[0].step_number, 1);
    assert.equal(erreurs[0].step_key, "address");
    assert.ok(erreurs[0].error_count >= 1);
    assert.ok(
      erreurs[0].error_fields.split("|").every((champ) => /^[a-zA-Z]+$/.test(champ)),
      "des noms de champs, jamais les messages affichés ni la saisie"
    );

    // L'étape n'a pas changé : aucune vue supplémentaire.
    assert.equal(h.pousses("estimation_step_view").length, 1);
  });
});

test("mesure — la soumission porte le lead_id et la qualification du lead", async () => {
  await withSubmitHarness({ mesure: true, apiBaseUrl: "" }, async (h) => {
    h.fillValidForm();
    h.submit();
    await h.settle();

    const soumissions = h.pousses("estimation_submit");
    assert.equal(soumissions.length, 1);

    const soumission = soumissions[0];
    assert.match(soumission.lead_id, /.{8,}/, "un identifiant non vide");
    assert.equal(soumission.property_type, "appartement");
    assert.equal(soumission.surface_bucket, "060-089");
    assert.equal(soumission.departement_code, "75");
    assert.equal(soumission.lead_quality, "hot");
    for (const interdit of ["name", "email", "phone", "address"]) {
      assert.equal(interdit in soumission, false, `« ${interdit} » ne doit pas être poussé`);
    }

    // Le même identifiant est persisté : c'est lui que `/rapport/` relira pour
    // n'émettre la conversion qu'une fois (plan §2.4).
    assert.equal(h.lastEstimation().lead_id, soumission.lead_id);
  });
});

test("mesure — sans conteneur de tags, le tunnel ne pousse rien et fonctionne", async () => {
  await withSubmitHarness({ apiBaseUrl: "" }, async (h) => {
    h.fillValidForm();
    h.submit();
    await h.settle();

    assert.equal(h.pousses().length, 0, "aucun dataLayer sans socle de mesure");
    // Et surtout : le parcours va jusqu'au bout. Une mesure absente ne doit
    // jamais coûter un lead.
    assert.deepEqual(h.redirects, ["/rapport/"]);
    assert.equal(h.lastEstimation().lead_id, "");
  });
});
