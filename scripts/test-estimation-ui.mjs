#!/usr/bin/env node
/**
 * Vérification autonome des fonctions pures de `src/scripts/estimation-ui.js`.
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
 * Comme il n'y a pas de `document` par défaut dans ce process Node, tout le
 * câblage DOM d'`estimation-ui.js` (protégé par `if (estimationFormEl) {
 * ... }` / `typeof document !== "undefined"`) reste inerte à l'exécution :
 * seules les fonctions pures déclarées au premier niveau
 * (`computeConditionalVisibility`, `computeHydrationPlan`, `appendToDatabase`,
 * `buildEmailTemplateParams`, `getSelectedOptionText`) sont exercées ici.
 *
 * Périmètre volontairement NON couvert par ce fichier (documenté plutôt que
 * simulé par un faux test) : l'application réelle du plan d'hydratation au
 * DOM par `hydrateFieldsFromState()` (les affectations `el.value = ...`,
 * l'affichage du récapitulatif d'adresse, l'appel à
 * `syncConditionalVisibility()`) ainsi que tout le reste du câblage
 * `addEventListener`/Google Places/EmailJS. Reproduire ce chemin de bout en
 * bout demanderait un DOM complet (formulaire à 5 étapes, `<select>` avec
 * options, etc.) — hors de portée sans dépendance type jsdom (explicitement
 * exclue). C'est un point de vérification manuelle en recette (cf. checklist
 * QA : « recharger la page à l'étape 3+, vérifier que les champs des étapes
 * précédentes sont bien pré-remplis, puis soumettre et vérifier le contenu
 * de l'email reçu »).
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
const WIZARD_SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "estimation-wizard.js");
const UI_SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "estimation-ui.js");

const WIZARD_SOURCE = readFileSync(WIZARD_SCRIPT_PATH, "utf8");
const WIZARD_SCRIPT = new vm.Script(WIZARD_SOURCE, { filename: "estimation-wizard.js" });

const UI_SOURCE = readFileSync(UI_SCRIPT_PATH, "utf8");
const UI_SCRIPT = new vm.Script(UI_SOURCE, { filename: "estimation-ui.js" });

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

  // Ordre de production : estimation-wizard.js (source de `isFieldVisible`,
  // `WIZARD_STEPS`...) est chargé avant estimation-ui.js.
  WIZARD_SCRIPT.runInThisContext();
  UI_SCRIPT.runInThisContext();

  return {
    computeConditionalVisibility: globalThis.computeConditionalVisibility,
    computeHydrationPlan: globalThis.computeHydrationPlan,
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
  });
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
