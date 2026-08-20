#!/usr/bin/env node
/**
 * Vérification autonome de `src/scripts/estimation-wizard.js`.
 *
 * Le projet n'a aucune infra de test (pas de vitest/jest — cf. package.json).
 * Ce script s'appuie uniquement sur les modules natifs `node:test` et
 * `node:assert`, et exécute le fichier source EXACTEMENT tel qu'il sera
 * injecté en production (aucun import/export : c'est un script classique
 * chargé via `<script is:inline>`, cf. `src/components/RawScript.astro`).
 *
 * Pour récupérer ses fonctions/données sans réécrire le fichier en module
 * ES, on l'exécute avec `vm.Script#runInThisContext()`, qui attache ses
 * déclarations `var`/`function` de premier niveau à l'objet global du
 * process Node en cours — exactement comme le ferait un `<script>`
 * classique dans une page. On évite volontairement `vm.createContext()`
 * (qui crée un nouveau "realm" avec son propre `Array`/`Object`) : les
 * objets qu'il produit échouent les comparaisons `assert.deepEqual` du
 * fichier de test (erreur "not reference-equal") car leurs constructeurs
 * diffèrent de ceux du realm principal, même à structure strictement
 * identique.
 *
 * Usage : `node scripts/test-estimation-wizard.mjs` (ou `npm run test:wizard`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "src",
  "scripts",
  "estimation-wizard.js"
);

const WIZARD_SOURCE = readFileSync(SCRIPT_PATH, "utf8");
const WIZARD_SCRIPT = new vm.Script(WIZARD_SOURCE, {
  filename: "estimation-wizard.js",
});

/**
 * (Ré)exécute le module wizard dans le realm global courant et renvoie les
 * bindings de premier niveau utiles aux tests. Réexécuter le script à
 * chaque appel réassigne simplement les mêmes `var`/`function` globales
 * (sans effet de bord problématique), ce qui permet de repartir d'un
 * `sessionStorage` global maîtrisé pour chaque test.
 *
 * @param {{sessionStorage?: Storage}} [globals]
 */
function loadWizardModule(globals) {
  if (globals && globals.sessionStorage) {
    globalThis.sessionStorage = globals.sessionStorage;
  } else {
    delete globalThis.sessionStorage;
  }

  WIZARD_SCRIPT.runInThisContext();

  return {
    WIZARD_STEPS: globalThis.WIZARD_STEPS,
    WIZARD_STORAGE_KEY: globalThis.WIZARD_STORAGE_KEY,
    WIZARD_STORAGE_VERSION: globalThis.WIZARD_STORAGE_VERSION,
    createDefaultWizardData: globalThis.createDefaultWizardData,
    isFieldVisible: globalThis.isFieldVisible,
    validateStep: globalThis.validateStep,
    calculerEstimation: globalThis.calculerEstimation,
    buildSubmitPayload: globalThis.buildSubmitPayload,
    findStepForField: globalThis.findStepForField,
    getPersistableFieldNames: globalThis.getPersistableFieldNames,
    createWizard: globalThis.createWizard,
  };
}

/** Petite implémentation en mémoire de l'API Storage (Web Storage), pour simuler sessionStorage. */
function createMemoryStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

/** Storage qui simule Safari en navigation privée : toute écriture throw. */
function createThrowingStorage() {
  return {
    getItem() {
      throw new DOMExceptionLike("QuotaExceededError");
    },
    setItem() {
      throw new DOMExceptionLike("QuotaExceededError");
    },
    removeItem() {
      throw new DOMExceptionLike("QuotaExceededError");
    },
  };
}

function DOMExceptionLike(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

function baseWizardData(overrides) {
  return Object.assign(
    {
      address: "12 rue de la Paix",
      postalCode: "75001",
      city: "Paris",
      placeId: "",
      addressSource: "manual",
      propertyType: "appartement",
      hasTerrain: "",
      terrainSize: "",
      surface: "85",
      rooms: "3",
      dpe: "C",
      dpeRequest: "",
      isOwner: "yes",
      wantToSell: "yes",
      name: "Jean Dupont",
      email: "jean.dupont@email.com",
      phone: "0612345678",
    },
    overrides || {}
  );
}

// ============================================================================
// WIZARD_STEPS
// ============================================================================

test("WIZARD_STEPS décrit bien 5 étapes dans l'ordre imposé", () => {
  const { WIZARD_STEPS } = loadWizardModule();
  assert.equal(WIZARD_STEPS.length, 5);
  assert.deepEqual(
    WIZARD_STEPS.map((s) => s.id),
    [1, 2, 3, 4, 5]
  );
  assert.deepEqual(
    WIZARD_STEPS.map((s) => s.key),
    ["address", "property", "characteristics", "situation", "contact"]
  );
});

// ============================================================================
// isFieldVisible — source unique de vérité pour la conditionnalité (US-5, US-8)
// ============================================================================

test("isFieldVisible — un champ sans règle déclarée est toujours visible", () => {
  const { isFieldVisible } = loadWizardModule();
  assert.equal(isFieldVisible("propertyType", {}), true);
  assert.equal(isFieldVisible("dpe", { dpe: "" }), true);
  assert.equal(isFieldVisible("address", { propertyType: "maison" }), true);
});

test("isFieldVisible — hasTerrain visible seulement pour une maison", () => {
  const { isFieldVisible } = loadWizardModule();
  assert.equal(isFieldVisible("hasTerrain", { propertyType: "maison" }), true);
  assert.equal(isFieldVisible("hasTerrain", { propertyType: "appartement" }), false);
  assert.equal(isFieldVisible("hasTerrain", { propertyType: "" }), false);
});

test("isFieldVisible — terrainSize visible seulement si hasTerrain === 'yes'", () => {
  const { isFieldVisible } = loadWizardModule();
  assert.equal(
    isFieldVisible("terrainSize", { propertyType: "maison", hasTerrain: "yes" }),
    true
  );
  assert.equal(
    isFieldVisible("terrainSize", { propertyType: "maison", hasTerrain: "no" }),
    false
  );
  // Cohérent même sans repasser par propertyType : la règle ne regarde que
  // `hasTerrain` (la cascade de `updateField` garantit que `hasTerrain` est
  // déjà remis à '' quand `propertyType` change de valeur — cf. US-5).
  assert.equal(
    isFieldVisible("terrainSize", { propertyType: "appartement", hasTerrain: "yes" }),
    true
  );
});

test("isFieldVisible — dpeRequest visible seulement si dpe === 'unknown'", () => {
  const { isFieldVisible } = loadWizardModule();
  assert.equal(isFieldVisible("dpeRequest", { dpe: "unknown" }), true);
  assert.equal(isFieldVisible("dpeRequest", { dpe: "C" }), false);
  assert.equal(isFieldVisible("dpeRequest", { dpe: "" }), false);
});

test("wizard.isFieldVisible() reflète l'état courant après updateField (US-5)", () => {
  const { createWizard } = loadWizardModule();
  const wizard = createWizard(null);

  assert.equal(wizard.isFieldVisible("hasTerrain"), false);

  wizard.updateField("propertyType", "maison");
  assert.equal(wizard.isFieldVisible("hasTerrain"), true);
  assert.equal(wizard.isFieldVisible("terrainSize"), false);

  wizard.updateField("hasTerrain", "yes");
  assert.equal(wizard.isFieldVisible("terrainSize"), true);

  // Retour à un type sans terrain : la cascade réinitialise hasTerrain, donc
  // isFieldVisible("terrainSize") redevient false sans logique dupliquée.
  wizard.updateField("propertyType", "appartement");
  assert.equal(wizard.isFieldVisible("hasTerrain"), false);
  assert.equal(wizard.isFieldVisible("terrainSize"), false);
});

// ============================================================================
// validateStep — étape 1 (adresse)
// ============================================================================

test("validateStep(1) — cas passant", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(
    1,
    baseWizardData({ address: "12 rue de la Paix", postalCode: "75001", city: "Paris" })
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, {});
});

test("validateStep(1) — code postal invalide (US-3)", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(
    1,
    baseWizardData({ address: "45 avenue Foch", postalCode: "ABC12", city: "Paris" })
  );
  assert.equal(result.valid, false);
  assert.equal(result.errors.postalCode, "Le code postal doit contenir 5 chiffres.");
});

test("validateStep(1) — champs vides", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(1, baseWizardData({ address: "", postalCode: "", city: "" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.address);
  assert.ok(result.errors.postalCode);
  assert.ok(result.errors.city);
});

// ============================================================================
// validateStep — étape 2 (conditionnalité terrain, US-8)
// ============================================================================

test("validateStep(2) — appartement : pas besoin de hasTerrain", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(2, baseWizardData({ propertyType: "appartement", hasTerrain: "" }));
  assert.equal(result.valid, true);
});

test("validateStep(2) — maison sans hasTerrain renseigné => invalide", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(2, baseWizardData({ propertyType: "maison", hasTerrain: "" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.hasTerrain);
});

test("validateStep(2) — maison + terrain 'yes' sans terrainSize => invalide", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(
    2,
    baseWizardData({ propertyType: "maison", hasTerrain: "yes", terrainSize: "" })
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.terrainSize);
});

test("validateStep(2) — maison + terrain 'yes' + terrainSize > 0 => valide", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(
    2,
    baseWizardData({ propertyType: "maison", hasTerrain: "yes", terrainSize: "500" })
  );
  assert.equal(result.valid, true);
});

test("validateStep(2) — maison + terrain 'no' : terrainSize non requis", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(
    2,
    baseWizardData({ propertyType: "maison", hasTerrain: "no", terrainSize: "" })
  );
  assert.equal(result.valid, true);
});

test("validateStep(2) — aucun type sélectionné => invalide", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(2, baseWizardData({ propertyType: "" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.propertyType);
});

// ============================================================================
// validateStep — étape 3 (surface/rooms/DPE, dpeRequest optionnel)
// ============================================================================

test("validateStep(3) — cas passant", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(3, baseWizardData({ surface: "85", rooms: "3", dpe: "C" }));
  assert.equal(result.valid, true);
});

test("validateStep(3) — DPE inconnu SANS dpeRequest reste valide (optionnel)", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(
    3,
    baseWizardData({ surface: "85", rooms: "3", dpe: "unknown", dpeRequest: "" })
  );
  assert.equal(result.valid, true, "dpeRequest doit rester optionnel même si dpe === 'unknown'");
});

test("validateStep(3) — surface <= 0 => invalide", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(3, baseWizardData({ surface: "0", rooms: "3", dpe: "C" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.surface);
});

test("validateStep(3) — rooms non entier => invalide", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(3, baseWizardData({ surface: "85", rooms: "2.5", dpe: "C" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.rooms);
});

test("validateStep(3) — dpe vide => invalide", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(3, baseWizardData({ surface: "85", rooms: "3", dpe: "" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.dpe);
});

// ============================================================================
// validateStep — étape 4 (situation)
// ============================================================================

test("validateStep(4) — cas passant", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(4, baseWizardData({ isOwner: "yes", wantToSell: "maybe" }));
  assert.equal(result.valid, true);
});

test("validateStep(4) — champs vides => invalide", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(4, baseWizardData({ isOwner: "", wantToSell: "" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.isOwner);
  assert.ok(result.errors.wantToSell);
});

// ============================================================================
// validateStep — étape 5 (coordonnées, PII)
// ============================================================================

test("validateStep(5) — cas passant", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(
    5,
    baseWizardData({ name: "Jean Dupont", email: "jean@dupont.fr", phone: "0612345678" })
  );
  assert.equal(result.valid, true);
});

test("validateStep(5) — email au format invalide => invalide", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(
    5,
    baseWizardData({ name: "Jean Dupont", email: "pas-un-email", phone: "0612345678" })
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.email);
});

test("validateStep(5) — champs vides => invalide", () => {
  const { validateStep } = loadWizardModule();
  const result = validateStep(5, baseWizardData({ name: "", email: "", phone: "" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.name);
  assert.ok(result.errors.email);
  assert.ok(result.errors.phone);
});

// NB : `parseGooglePlace` ne vit plus dans estimation-wizard.js (il est
// partagé avec le formulaire d'adresse de la page d'accueil) — ses tests ont
// suivi la fonction dans `scripts/test-google-places.mjs`.

// ============================================================================
// calculerEstimation — non-régression de l'algorithme existant
// ============================================================================

test("calculerEstimation — ville connue, DPE neutre (D), appartement", () => {
  const { calculerEstimation } = loadWizardModule();
  const result = calculerEstimation("Paris", 85, 3, "appartement", "D");
  // prixM2 = 10500 * 1 (appartement) * 1 (DPE D) * 1 (3 pièces, pas de bonus) = 10500
  assert.equal(result.prixM2, 10500);
  assert.equal(result.estimationMoyenne, Math.round(10500 * 85));
  assert.equal(result.estimationMin, Math.round(10500 * 85 * 0.9));
  assert.equal(result.estimationMax, Math.round(10500 * 85 * 1.1));
});

test("calculerEstimation — ville inconnue => prix par défaut", () => {
  const { calculerEstimation } = loadWizardModule();
  const result = calculerEstimation("Ville Inexistante Zzz", 50, 2, "appartement", "D");
  assert.equal(result.prixM2, 3000);
});

test("calculerEstimation — maison applique le coefficient 0.95, sans bonus pièces", () => {
  const { calculerEstimation } = loadWizardModule();
  const result = calculerEstimation("Paris", 100, 5, "maison", "D");
  assert.equal(result.prixM2, Math.round(10500 * 0.95));
});

test("calculerEstimation — DPE G applique une décote de 25%", () => {
  const { calculerEstimation } = loadWizardModule();
  const result = calculerEstimation("Paris", 100, 3, "appartement", "G");
  assert.equal(result.prixM2, Math.round(10500 * 0.75));
});

// ============================================================================
// buildSubmitPayload / serializeForSubmit — forme exacte du payload (§3.2)
// ============================================================================

test("buildSubmitPayload — clés et types exacts du payload §3.2", () => {
  const { buildSubmitPayload } = loadWizardModule();
  const data = baseWizardData({
    surface: "85",
    rooms: "3",
    terrainSize: "", // reste string
    propertyType: "appartement",
    address: "12 rue de la Paix, 75001 Paris, France",
  });
  const payload = buildSubmitPayload(data);

  // Mêmes clés, dans le même esprit que l'objet formData existant.
  const expectedKeys = [
    "id",
    "timestamp",
    "propertyType",
    "address",
    "postalCode",
    "city",
    "surface",
    "rooms",
    "dpe",
    "dpeRequest",
    "isOwner",
    "wantToSell",
    "hasTerrain",
    "terrainSize",
    // Précisions facultatives de l'étape 3 (Lot 3) : brutes, comme terrainSize.
    "floor",
    "hasElevator",
    "outdoor",
    "condition",
    "name",
    "email",
    "phone",
    "estimation",
  ];
  assert.deepEqual(Object.keys(payload), expectedKeys);

  // Types stricts.
  assert.equal(typeof payload.id, "number");
  assert.equal(typeof payload.timestamp, "string");
  assert.equal(typeof payload.surface, "number");
  assert.equal(payload.surface, 85);
  assert.equal(typeof payload.rooms, "number");
  assert.equal(payload.rooms, 3);
  assert.equal(typeof payload.terrainSize, "string", "terrainSize doit rester une string brute");
  assert.equal(typeof payload.estimation, "object");
  assert.ok("prixM2" in payload.estimation);
  assert.ok("estimationMin" in payload.estimation);
  assert.ok("estimationMax" in payload.estimation);
  assert.ok("estimationMoyenne" in payload.estimation);

  // §0 : address n'est jamais retouchée.
  assert.equal(payload.address, "12 rue de la Paix, 75001 Paris, France");
});

test("buildSubmitPayload — terrainSize conserve la valeur brute d'une maison avec terrain", () => {
  const { buildSubmitPayload } = loadWizardModule();
  const payload = buildSubmitPayload(
    baseWizardData({ propertyType: "maison", hasTerrain: "yes", terrainSize: "500" })
  );
  assert.equal(payload.terrainSize, "500");
  assert.equal(typeof payload.terrainSize, "string");
});

test("buildSubmitPayload — sans 2e argument, le repli calcule toujours l'estimation (rétro-compat)", () => {
  const { buildSubmitPayload, calculerEstimation } = loadWizardModule();
  const data = baseWizardData({ surface: "85", rooms: "3", propertyType: "appartement" });
  const payload = buildSubmitPayload(data);

  assert.deepEqual(
    payload.estimation,
    calculerEstimation("Paris", 85, 3, "appartement", data.dpe)
  );
});

test("buildSubmitPayload — l'estimation fournie est embarquée telle quelle (résultat API)", () => {
  const { buildSubmitPayload } = loadWizardModule();
  const apiEstimation = {
    prixM2: 1440,
    estimationMin: 108000,
    estimationMax: 180000,
    estimationMoyenne: 144000,
    confidence: { score: 66, label: "medium" },
  };
  const payload = buildSubmitPayload(baseWizardData(), apiEstimation);

  assert.equal(payload.estimation, apiEstimation);
  // Non-régression US-11 : les quatre clés historiques restent lisibles au
  // même endroit, avec les mêmes noms et les mêmes types.
  ["prixM2", "estimationMin", "estimationMax", "estimationMoyenne"].forEach((key) => {
    assert.equal(typeof payload.estimation[key], "number");
  });
});

test("buildSubmitPayload — `null` explicite reste null (mode estimation différée)", () => {
  const { buildSubmitPayload } = loadWizardModule();
  const payload = buildSubmitPayload(baseWizardData(), null);
  assert.equal(payload.estimation, null, "aucun prix ne doit être inventé");
});

test("serializeForSubmit — transmet l'estimation reçue au payload", () => {
  const { createWizard } = loadWizardModule();
  const wizard = createWizard(null);
  wizard.updateField("city", "Guéret");
  wizard.updateField("surface", "100");
  wizard.updateField("rooms", "5");

  const estimation = { prixM2: 1, estimationMin: 2, estimationMax: 3, estimationMoyenne: 4 };
  assert.equal(wizard.serializeForSubmit(estimation).estimation, estimation);
  assert.equal(wizard.serializeForSubmit(null).estimation, null);
});

// ============================================================================
// Champs facultatifs de l'étape 3 (specs/estimation-donnees-reelles.md §7.1)
// ============================================================================

test("étape 3 — floor/hasElevator/outdoor/condition ne sont JAMAIS obligatoires", () => {
  const { WIZARD_STEPS, validateStep } = loadWizardModule();
  const step3 = WIZARD_STEPS.find((step) => step.id === 3);

  // Aucun des nouveaux champs ne rejoint `requiredFields` : le tunnel convertit
  // avec trois champs requis, on n'en ajoute pas un quatrième.
  assert.deepEqual(step3.requiredFields, ["surface", "rooms", "dpe"]);
  ["floor", "hasElevator", "outdoor", "condition"].forEach((field) => {
    assert.ok(step3.fields.includes(field), `${field} doit appartenir à l'étape 3`);
    assert.equal(step3.requiredFields.includes(field), false);
  });

  // Et la validation passe avec tous ces champs vides.
  const result = validateStep(
    3,
    baseWizardData({ surface: "85", rooms: "3", dpe: "C", floor: "", hasElevator: "", outdoor: "", condition: "" })
  );
  assert.equal(result.valid, true);
});

test("isFieldVisible — la conditionnalité des nouveaux champs vit dans WIZARD_STEPS", () => {
  const { isFieldVisible } = loadWizardModule();

  assert.equal(isFieldVisible("floor", { propertyType: "appartement" }), true);
  assert.equal(isFieldVisible("hasElevator", { propertyType: "appartement" }), true);
  assert.equal(isFieldVisible("floor", { propertyType: "maison" }), false);
  assert.equal(isFieldVisible("hasElevator", { propertyType: "maison" }), false);

  assert.equal(isFieldVisible("outdoor", { propertyType: "maison" }), true);
  assert.equal(isFieldVisible("condition", { propertyType: "appartement" }), true);
  assert.equal(isFieldVisible("outdoor", { propertyType: "terrain" }), false);
  assert.equal(isFieldVisible("condition", { propertyType: "local-commercial" }), false);
});

test("updateField — passer d'appartement à maison réinitialise étage et ascenseur", () => {
  const { createWizard } = loadWizardModule();
  const wizard = createWizard(null);

  wizard.updateField("propertyType", "appartement");
  wizard.updateField("floor", "4");
  wizard.updateField("hasElevator", "yes");
  assert.equal(wizard.state.data.floor, "4");

  // Cascade US-5 : le champ masqué ne doit pas rester dans l'état, sans quoi
  // un étage serait transmis à l'API pour une maison.
  wizard.updateField("propertyType", "maison");
  assert.equal(wizard.state.data.floor, "");
  assert.equal(wizard.state.data.hasElevator, "");
});

// ============================================================================
// findStepForField / setErrors — erreurs externes (422 de l'API)
// ============================================================================

test("findStepForField — retrouve l'étape d'un champ, null pour un champ inconnu", () => {
  const { findStepForField } = loadWizardModule();
  assert.equal(findStepForField("address"), 1);
  assert.equal(findStepForField("propertyType"), 2);
  assert.equal(findStepForField("condition"), 3);
  assert.equal(findStepForField("wantToSell"), 4);
  assert.equal(findStepForField("email"), 5);
  assert.equal(findStepForField("_form"), null);
  assert.equal(findStepForField("lat"), null);
});

test("setErrors — pose les erreurs de l'API et repositionne sur l'étape fautive", () => {
  const { createWizard } = loadWizardModule();
  const wizard = createWizard(null);
  wizard.goToStep(5);

  const posed = wizard.setErrors({ surface: "La surface doit être d'au moins 9 m²." });

  assert.equal(posed, true);
  assert.equal(wizard.state.currentStep, 3, "on revient sur l'étape du champ fautif");
  assert.equal(wizard.state.errors.surface, "La surface doit être d'au moins 9 m².");
});

test("setErrors — un objet vide n'affiche rien et ne déplace pas l'utilisateur", () => {
  const { createWizard } = loadWizardModule();
  const wizard = createWizard(null);
  wizard.goToStep(5);

  assert.equal(wizard.setErrors({}), false);
  assert.equal(wizard.state.currentStep, 5);
  assert.deepEqual(wizard.state.errors, {});
});

test("setErrors — une erreur sans champ (_form) laisse l'utilisateur où il est", () => {
  const { createWizard } = loadWizardModule();
  const wizard = createWizard(null);
  wizard.goToStep(5);

  assert.equal(wizard.setErrors({ _form: "Requête refusée." }), true);
  assert.equal(wizard.state.currentStep, 5);
});

// ============================================================================
// Persistance sessionStorage — RGPD (§3.3, US-6)
// ============================================================================

test("getPersistableFieldNames — n'inclut jamais name/email/phone", () => {
  const { getPersistableFieldNames } = loadWizardModule();
  const fields = getPersistableFieldNames();
  assert.equal(fields.includes("name"), false);
  assert.equal(fields.includes("email"), false);
  assert.equal(fields.includes("phone"), false);
  // En revanche les champs des étapes 1 à 4 doivent bien y être.
  ["address", "postalCode", "city", "propertyType", "surface", "rooms", "isOwner", "wantToSell"].forEach(
    (field) => {
      assert.ok(fields.includes(field), `${field} devrait être persistable`);
    }
  );
});

test("createWizard().persist() n'écrit jamais name/email/phone en sessionStorage", () => {
  const storage = createMemoryStorage();
  const { createWizard, WIZARD_STORAGE_KEY } = loadWizardModule({ sessionStorage: storage });

  const wizard = createWizard(null); // pas de DOM : formEl absent, tout est défensif.
  wizard.updateField("address", "12 rue de la Paix");
  wizard.updateField("postalCode", "75001");
  wizard.updateField("city", "Paris");
  wizard.updateField("name", "Jean Dupont");
  wizard.updateField("email", "jean@dupont.fr");
  wizard.updateField("phone", "0612345678");
  wizard.persist();

  const raw = storage.getItem(WIZARD_STORAGE_KEY);
  assert.ok(raw, "la clé sessionStorage doit être écrite");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.data.address, "12 rue de la Paix");
  assert.equal("name" in parsed.data, false);
  assert.equal("email" in parsed.data, false);
  assert.equal("phone" in parsed.data, false);
  assert.equal(raw.includes("Jean Dupont"), false);
  assert.equal(raw.includes("jean@dupont.fr"), false);
});

test("createWizard().restore() recharge les données non-PII et se repositionne", () => {
  const storage = createMemoryStorage();
  const { createWizard, WIZARD_STORAGE_KEY, WIZARD_STORAGE_VERSION } = loadWizardModule({
    sessionStorage: storage,
  });

  storage.setItem(
    WIZARD_STORAGE_KEY,
    JSON.stringify({
      version: WIZARD_STORAGE_VERSION,
      currentStep: 4,
      maxStepReached: 4,
      data: { address: "12 rue de la Paix", postalCode: "75001", city: "Paris", surface: "85", rooms: "3" },
    })
  );

  const wizard = createWizard(null);
  const restored = wizard.restore();

  assert.equal(restored, true);
  assert.equal(wizard.state.currentStep, 4);
  assert.equal(wizard.state.maxStepReached, 4);
  assert.equal(wizard.state.data.address, "12 rue de la Paix");
  assert.equal(wizard.state.data.surface, "85");
});

test("restore() — JSON invalide en sessionStorage => état vide, ne throw jamais", () => {
  const storage = createMemoryStorage();
  storage.setItem("estimationWizardState", "{ceci n'est pas du JSON valide");
  const { createWizard } = loadWizardModule({ sessionStorage: storage });

  const wizard = createWizard(null);
  assert.doesNotThrow(() => {
    const restored = wizard.restore();
    assert.equal(restored, false);
  });
  assert.equal(wizard.state.currentStep, 1);
  assert.equal(wizard.state.data.address, "");
});

test("restore() — schéma d'une version antérieure => ignoré silencieusement", () => {
  const storage = createMemoryStorage();
  storage.setItem(
    "estimationWizardState",
    JSON.stringify({ currentStep: 3, maxStepReached: 3, data: { address: "ancienne valeur" } })
    // pas de champ `version` => traité comme un schéma antérieur.
  );
  const { createWizard } = loadWizardModule({ sessionStorage: storage });

  const wizard = createWizard(null);
  const restored = wizard.restore();
  assert.equal(restored, false);
  assert.equal(wizard.state.currentStep, 1);
  assert.equal(wizard.state.data.address, "");
});

test("restore() — sessionStorage indisponible (navigation privée Safari) => ne throw jamais", () => {
  const throwingStorage = createThrowingStorage();
  const { createWizard } = loadWizardModule({ sessionStorage: throwingStorage });

  const wizard = createWizard(null);
  assert.doesNotThrow(() => {
    const restored = wizard.restore();
    assert.equal(restored, false);
  });

  assert.doesNotThrow(() => {
    wizard.persist();
  });
});

test("restore() — sessionStorage vide (première visite) => état par défaut", () => {
  const storage = createMemoryStorage();
  const { createWizard } = loadWizardModule({ sessionStorage: storage });
  const wizard = createWizard(null);
  const restored = wizard.restore();
  assert.equal(restored, false);
  assert.equal(wizard.state.currentStep, 1);
  assert.equal(wizard.state.maxStepReached, 1);
});

// ============================================================================
// createWizard — navigation, conditionnalité, sans DOM (formEl = null)
// ============================================================================

test("createWizard().next() bloque si l'étape courante est invalide", () => {
  const { createWizard } = loadWizardModule();
  const wizard = createWizard(null);
  const advanced = wizard.next(); // étape 1 vide par défaut
  assert.equal(advanced, false);
  assert.equal(wizard.state.currentStep, 1);
  assert.ok(Object.keys(wizard.state.errors).length > 0);
});

test("createWizard().next() avance si l'étape courante est valide", () => {
  const { createWizard } = loadWizardModule();
  const wizard = createWizard(null);
  wizard.updateField("address", "12 rue de la Paix");
  wizard.updateField("postalCode", "75001");
  wizard.updateField("city", "Paris");
  const advanced = wizard.next();
  assert.equal(advanced, true);
  assert.equal(wizard.state.currentStep, 2);
  assert.equal(wizard.state.maxStepReached, 2);
});

test("createWizard().prev() recule sans perdre les données déjà saisies", () => {
  const { createWizard } = loadWizardModule();
  const wizard = createWizard(null);
  wizard.updateField("address", "12 rue de la Paix");
  wizard.updateField("postalCode", "75001");
  wizard.updateField("city", "Paris");
  wizard.next();
  wizard.updateField("propertyType", "appartement");
  wizard.next();
  wizard.updateField("surface", "85");
  wizard.updateField("rooms", "3");

  wizard.prev();
  wizard.prev();
  assert.equal(wizard.state.currentStep, 1);

  wizard.next();
  wizard.next();
  assert.equal(wizard.state.currentStep, 3);
  assert.equal(wizard.state.data.surface, "85");
  assert.equal(wizard.state.data.rooms, "3");
});

test("updateField — conditionnalité terrain en cascade (US-5)", () => {
  const { createWizard } = loadWizardModule();
  const wizard = createWizard(null);

  wizard.updateField("propertyType", "maison");
  wizard.updateField("hasTerrain", "yes");
  wizard.updateField("terrainSize", "500");
  assert.equal(wizard.state.data.terrainSize, "500");

  // Changement de type de bien : hasTerrain ET terrainSize doivent être
  // réinitialisés (cascade), sans mémorisation au retour sur "maison".
  wizard.updateField("propertyType", "appartement");
  assert.equal(wizard.state.data.hasTerrain, "");
  assert.equal(wizard.state.data.terrainSize, "");

  wizard.updateField("propertyType", "maison");
  assert.equal(wizard.state.data.hasTerrain, "", "pas de mémorisation au retour sur 'maison'");
});

test("updateField — dpeRequest réinitialisé si dpe change et n'est plus 'unknown'", () => {
  const { createWizard } = loadWizardModule();
  const wizard = createWizard(null);
  wizard.updateField("dpe", "unknown");
  wizard.updateField("dpeRequest", "yes");
  assert.equal(wizard.state.data.dpeRequest, "yes");

  wizard.updateField("dpe", "C");
  assert.equal(wizard.state.data.dpeRequest, "");
});

test("serializeForSubmit() reflète l'état courant du wizard", () => {
  const { createWizard } = loadWizardModule();
  const wizard = createWizard(null);
  Object.entries(
    baseWizardData({ address: "12 rue de la Paix, 75001 Paris, France" })
  ).forEach(([name, value]) => wizard.updateField(name, value));

  const payload = wizard.serializeForSubmit();
  assert.equal(payload.address, "12 rue de la Paix, 75001 Paris, France");
  assert.equal(payload.surface, 85);
  assert.equal(payload.rooms, 3);
  assert.equal(typeof payload.estimation.prixM2, "number");
});
