#!/usr/bin/env node
/**
 * Vérification autonome de `src/scripts/rapport-edit.js` — la correction des
 * informations du bien depuis `/rapport`, suivie d'un recalcul.
 *
 * Même technique que les autres suites (`vm.Script`) : les fichiers sont
 * exécutés tels qu'ils seront injectés en production — scripts classiques,
 * aucun `import`/`export`, tout en portée globale — dans l'ordre réel de la
 * page : `estimation-wizard.js` (règles), `estimation-api.js` (client HTTP),
 * puis `rapport-edit.js`.
 *
 * CE QUE CETTE SUITE VERROUILLE, et pourquoi :
 *
 * 1. AUCUN NOUVEAU LEAD. C'est la raison d'être de la fonctionnalité : le
 *    recalcul ne doit toucher que `POST /v1/estimations`, et `lead_id`, `id`,
 *    `name`, `email`, `phone` doivent survivre intacts — c'est ce qui fait
 *    tenir le verrou de conversion de `rapport-report.js`.
 * 2. AUCUNE DONNÉE PERSONNELLE dans le corps envoyé. `/v1/estimations` répond
 *    422 `forbidden_pii` ; un recalcul qui embarquerait l'e-mail échouerait
 *    silencieusement pour le visiteur.
 * 3. UN ÉCHEC NE DÉGRADE PAS LE RAPPORT EN PLACE. Réseau coupé, 429, 5xx :
 *    `lastEstimation` reste tel quel. Remplacer une estimation fondée sur des
 *    transactions réelles par un repli statique parce que le réseau a hoqueté
 *    serait une régression que le visiteur n'a pas demandée.
 * 4. LES RÈGLES NE SONT PAS DUPLIQUÉES : la conditionnalité vient de
 *    `isFieldVisible`, la validation de `validateStep`.
 *
 * Usage : `node --test scripts/test-rapport-edit.mjs`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadScript(name) {
  const file = path.join(__dirname, "..", "src", "scripts", name);
  return new vm.Script(readFileSync(file, "utf8"), { filename: name });
}

const WIZARD_SCRIPT = loadScript("estimation-wizard.js");
const API_SCRIPT = loadScript("estimation-api.js");
const EDIT_SCRIPT = loadScript("rapport-edit.js");
const TRACKING_SCRIPT = loadScript("tracking.js");

// ============================================================================
// `lastEstimation` de référence — la forme réellement écrite par
// `estimation-ui.js` : clés historiques à plat, `surface`/`rooms` en `number`,
// coordonnées présentes (le rapport et le PDF en ont besoin).
// ============================================================================

function baseLastEstimation(overrides) {
  return Object.assign(
    {
      id: 1700000000000,
      timestamp: "2026-08-24T09:00:00.000Z",
      lead_id: "11111111-2222-4333-8444-555555555555",
      propertyType: "appartement",
      address: "12 rue de la Paix",
      postalCode: "75001",
      city: "paris",
      surface: 85,
      rooms: 3,
      dpe: "C",
      dpeRequest: "no",
      hasTerrain: "",
      terrainSize: "",
      floor: "3",
      hasElevator: "yes",
      outdoor: "balcony",
      condition: "good",
      isOwner: "yes",
      wantToSell: "yes",
      name: "Jean Dupont",
      email: "jean.dupont@example.com",
      phone: "0612345678",
      estimationStatus: "ok",
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

/** Réponse `EstimationResult` minimale mais complète du point de vue du mapping. */
function apiResult(overrides) {
  return Object.assign(
    {
      value: 640000,
      pricePerSqm: 11034,
      range: { low: 576000, high: 704000, halfWidthPct: 0.1, basis: "iqr" },
      confidence: { score: 72, label: "high" },
      method: { kind: "comparables", level: "radius", comparablesCount: 18 },
      comparables: [],
      dataSource: { dataCoverage: "full" },
      computedAt: "2026-08-24T10:00:00.000Z",
      apiVersion: "1",
    },
    overrides || {}
  );
}

// ============================================================================
// Contexte « fonctions pures » — aucun DOM, le câblage ne s'exécute pas
// ============================================================================

function pureContext() {
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    // `getElementById` renvoie toujours `null` : `#reportEditForm` est absent,
    // donc tout le bloc de câblage est sauté et seules les fonctions pures
    // restent définies.
    document: { getElementById: () => null, querySelector: () => null },
  };
  vm.createContext(sandbox);
  WIZARD_SCRIPT.runInContext(sandbox);
  API_SCRIPT.runInContext(sandbox);
  EDIT_SCRIPT.runInContext(sandbox);
  return sandbox;
}

// ============================================================================
// 1. État éditable
// ============================================================================

test("buildReportEditState — les nombres stockés redeviennent des chaînes de formulaire", () => {
  const ctx = pureContext();
  const state = ctx.buildReportEditState(baseLastEstimation());

  assert.equal(state.surface, "85");
  assert.equal(state.rooms, "3");
  assert.equal(state.floor, "3");
  assert.equal(state.dpe, "C");
  assert.equal(state.propertyType, "appartement");
  // L'adresse est recopiée sans être modifiable : `buildEstimationApiPayload`
  // l'exige, l'API refuserait un corps sans elle.
  assert.equal(state.address, "12 rue de la Paix");
  assert.equal(state.postalCode, "75001");
  assert.equal(state.city, "paris");
});

test("buildReportEditState — aucune coordonnée ne rejoint l'état éditable", () => {
  const ctx = pureContext();
  const state = ctx.buildReportEditState(baseLastEstimation());

  for (const champ of ["name", "email", "phone"]) {
    assert.equal(state[champ], "", `« ${champ} » ne doit jamais être repris ici`);
  }
});

test("buildReportEditState — un lastEstimation d'une version antérieure est nettoyé", () => {
  // Étage renseigné sur une MAISON : combinaison que `WIZARD_STEPS` interdit
  // aujourd'hui. L'envoyer telle quelle vaudrait un aller-retour pour rien.
  const ctx = pureContext();
  const state = ctx.buildReportEditState(
    baseLastEstimation({ propertyType: "maison", hasTerrain: "no", floor: "2", hasElevator: "yes" })
  );

  assert.equal(state.floor, "", "l'étage ne concerne que les appartements");
  assert.equal(state.hasElevator, "");
  assert.equal(state.hasTerrain, "no", "la question du terrain, elle, reste posée");
});

test("buildReportEditState — un lastEstimation vide ne fait pas tomber la fonction", () => {
  const ctx = pureContext();
  const state = ctx.buildReportEditState(null);

  assert.equal(state.surface, "");
  assert.equal(state.propertyType, "");
});

// ============================================================================
// 2. Conditionnalité — dérivée de `isFieldVisible`, jamais redéclarée
// ============================================================================

test("normalizeReportEditData — passer d'une maison à un appartement vide terrain ET surface de terrain", () => {
  const ctx = pureContext();
  const maison = ctx.buildReportEditState(
    baseLastEstimation({ propertyType: "maison", hasTerrain: "yes", terrainSize: "500" })
  );
  assert.equal(maison.terrainSize, "500", "état de départ cohérent");

  const appartement = ctx.normalizeReportEditData(
    Object.assign({}, maison, { propertyType: "appartement" })
  );

  assert.equal(appartement.hasTerrain, "");
  assert.equal(
    appartement.terrainSize,
    "",
    "la cascade doit aller jusqu'au champ qui ne dépend qu'indirectement du type"
  );
});

test("normalizeReportEditData — ne mute jamais l'objet reçu", () => {
  const ctx = pureContext();
  const maison = ctx.buildReportEditState(
    baseLastEstimation({ propertyType: "maison", hasTerrain: "yes", terrainSize: "500" })
  );
  const entree = Object.assign({}, maison, { propertyType: "appartement" });

  ctx.normalizeReportEditData(entree);

  assert.equal(entree.terrainSize, "500");
});

test("computeReportEditVisibility — un terrain nu n'a ni étage, ni extérieur, ni état", () => {
  const ctx = pureContext();
  const visibility = ctx.computeReportEditVisibility(
    ctx.buildReportEditState(baseLastEstimation({ propertyType: "terrain" }))
  );

  assert.equal(visibility.floor, false);
  assert.equal(visibility.hasElevator, false);
  assert.equal(visibility.outdoor, false);
  assert.equal(visibility.condition, false);
  assert.equal(visibility._optional, false, "le bloc entier disparaît");
  assert.equal(visibility.surface, true, "la surface reste demandée");
});

test("computeReportEditVisibility — un appartement affiche étage et ascenseur", () => {
  const ctx = pureContext();
  const visibility = ctx.computeReportEditVisibility(
    ctx.buildReportEditState(baseLastEstimation())
  );

  assert.equal(visibility.floor, true);
  assert.equal(visibility.hasElevator, true);
  assert.equal(visibility.hasTerrain, false, "pas de question terrain hors maison");
  assert.equal(visibility._optional, true);
});

// ============================================================================
// 3. Validation — les règles du wizard, pas les nôtres
// ============================================================================

test("validateReportEdit — une surface nulle est refusée, avec le message du wizard", () => {
  const ctx = pureContext();
  const state = ctx.buildReportEditState(baseLastEstimation());
  state.surface = "0";

  const result = ctx.validateReportEdit(state);

  assert.equal(result.valid, false);
  assert.equal(result.errors.surface, ctx.validateStep(3, state).errors.surface);
});

test("validateReportEdit — les erreurs des étapes 2 et 3 remontent ensemble", () => {
  const ctx = pureContext();
  const state = ctx.buildReportEditState(baseLastEstimation());
  state.propertyType = "";
  state.rooms = "2,5";

  const result = ctx.validateReportEdit(state);

  assert.equal(result.valid, false);
  assert.ok(result.errors.propertyType, "étape 2");
  assert.ok(result.errors.rooms, "étape 3");
});

test("validateReportEdit — une maison avec terrain exige sa surface", () => {
  const ctx = pureContext();
  const state = ctx.buildReportEditState(
    baseLastEstimation({ propertyType: "maison", hasTerrain: "yes", terrainSize: "" })
  );

  assert.equal(ctx.validateReportEdit(state).valid, false);
  state.terrainSize = "500";
  assert.equal(ctx.validateReportEdit(state).valid, true);
});

// ============================================================================
// 4. Différentiel
// ============================================================================

// Les tableaux renvoyés viennent du contexte `vm` : leur prototype n'est pas
// celui du realm de test, ce que `deepStrictEqual` refuse alors même que le
// contenu est identique. On compare donc la forme sérialisée.
const joint = (liste) => Array.prototype.join.call(liste, "|");

test("diffReportEditFields — seuls les champs réellement changés sont listés", () => {
  const ctx = pureContext();
  const avant = ctx.buildReportEditState(baseLastEstimation());
  const apres = Object.assign({}, avant, { surface: "58", dpe: "E" });

  assert.equal(joint(ctx.diffReportEditFields(avant, apres)), "surface|dpe");
});

test("diffReportEditFields — resaisir la même valeur ne compte pas", () => {
  const ctx = pureContext();
  const avant = ctx.buildReportEditState(baseLastEstimation());
  const apres = Object.assign({}, avant, { surface: " 85 " });

  assert.equal(joint(ctx.diffReportEditFields(avant, apres)), "");
});

// ============================================================================
// 5. Fusion — LE point critique : aucun nouveau lead
// ============================================================================

test("mergeReportEdit — l'identité du lead traverse le recalcul intacte", () => {
  const ctx = pureContext();
  const avant = baseLastEstimation();
  const data = ctx.buildReportEditState(avant);
  data.surface = "58";

  const apres = ctx.mergeReportEdit(
    avant,
    data,
    { prixM2: 11034, estimationMin: 576000, estimationMax: 704000, estimationMoyenne: 640000 },
    ["surface"],
    "2026-08-24T10:00:00.000Z"
  );

  // C'est cette égalité, et elle seule, qui garantit qu'aucune seconde
  // conversion ne sera comptée : le verrou de `rapport-report.js` porte sur
  // `lead_id`.
  assert.equal(apres.lead_id, avant.lead_id);
  assert.equal(apres.id, avant.id);
  assert.equal(apres.timestamp, avant.timestamp);
  assert.equal(apres.name, avant.name);
  assert.equal(apres.email, avant.email);
  assert.equal(apres.phone, avant.phone);
  assert.equal(apres.address, avant.address);
  assert.equal(apres.isOwner, avant.isOwner);
  assert.equal(apres.wantToSell, avant.wantToSell);
});

test("mergeReportEdit — surface et pièces redeviennent des nombres, comme à la soumission", () => {
  const ctx = pureContext();
  const data = ctx.buildReportEditState(baseLastEstimation());
  // `<input type="number">` ne produit jamais de virgule décimale, et
  // `validateStep(3)` la refuserait (`Number("58,5")` vaut NaN) : la fusion
  // n'a donc à traiter que le point, comme `buildSubmitPayload`.
  data.surface = "58.5";
  data.rooms = "2";

  const apres = ctx.mergeReportEdit(baseLastEstimation(), data, {}, ["surface", "rooms"]);

  assert.equal(apres.surface, 58.5);
  assert.equal(apres.rooms, 2);
  assert.equal(typeof apres.surface, "number");
  assert.equal(typeof apres.rooms, "number");
});

test("mergeReportEdit — la révision s'incrémente et retient ce qui a bougé", () => {
  const ctx = pureContext();
  const data = ctx.buildReportEditState(baseLastEstimation());

  const premier = ctx.mergeReportEdit(baseLastEstimation(), data, {}, ["surface"]);
  assert.equal(premier.revision, 1);
  assert.equal(premier.editedFields, "surface");

  const second = ctx.mergeReportEdit(premier, data, {}, ["dpe", "condition"]);
  assert.equal(second.revision, 2);
  assert.equal(second.editedFields, "dpe|condition");
});

test("mergeReportEdit — un rapport en mode dégradé repasse en `ok` après recalcul", () => {
  const ctx = pureContext();
  const avant = baseLastEstimation({ estimationStatus: "static-fallback" });
  const data = ctx.buildReportEditState(avant);

  assert.equal(ctx.mergeReportEdit(avant, data, {}, ["dpe"]).estimationStatus, "ok");
});

test("replaceInEstimationDatabase — l'entrée d'origine est remplacée, pas dupliquée", () => {
  const ctx = pureContext();
  const database = [{ id: 1 }, { id: 1700000000000, surface: 85 }, { id: 2 }];
  const majorite = ctx.replaceInEstimationDatabase(database, { id: 1700000000000, surface: 58 });

  assert.equal(majorite.length, 3);
  assert.equal(majorite[1].surface, 58);
  assert.equal(database[1].surface, 85, "le tableau reçu n'est pas muté");
});

test("replaceInEstimationDatabase — une entrée absente est ajoutée", () => {
  const ctx = pureContext();
  assert.equal(ctx.replaceInEstimationDatabase([], { id: 7 }).length, 1);
});

// ============================================================================
// 6. Récapitulatif affiché
// ============================================================================

test("describeReportEdit — rien à dire tant que le rapport n'a pas été corrigé", () => {
  const ctx = pureContext();
  assert.equal(ctx.describeReportEdit(baseLastEstimation()), "");
});

test("describeReportEdit — la phrase nomme les champs corrigés en clair", () => {
  const ctx = pureContext();
  const phrase = ctx.describeReportEdit(
    baseLastEstimation({ revision: 1, editedFields: "surface|dpe" })
  );

  assert.match(phrase, /Estimation recalculée après correction/);
  assert.match(phrase, /Surface habitable, DPE/);
});

test("describeReportEdit — un champ inconnu (version antérieure) est ignoré, pas affiché brut", () => {
  const ctx = pureContext();
  const phrase = ctx.describeReportEdit(
    baseLastEstimation({ revision: 2, editedFields: "surface|champInexistant" })
  );

  assert.match(phrase, /recalculée 2 fois/);
  assert.match(phrase, /Surface habitable/);
  assert.equal(phrase.includes("champInexistant"), false);
});

// ============================================================================
// Faux DOM et faux réseau — parcours complet du formulaire
// ============================================================================

/** Éléments portant `hidden` dans `rapport.astro` (leur état initial compte). */
const HIDDEN_BY_DEFAULT = [
  "reportEditForm",
  "reportEditNotice",
  "reportEditStatus",
  "hasTerrainGroup",
  "terrainSizeGroup",
  "floorGroup",
  "hasElevatorGroup",
  "outdoorGroup",
  "conditionGroup",
];

/** `<select>` du formulaire : `tagName` décide de l'événement écouté. */
const SELECT_IDS = [
  "propertyType",
  "hasTerrain",
  "dpe",
  "hasElevator",
  "outdoor",
  "condition",
];

function makeElement(id) {
  const listeners = {};
  const attributes = {};
  return {
    id: id,
    tagName: SELECT_IDS.indexOf(id) !== -1 ? "SELECT" : "INPUT",
    value: "",
    innerHTML: "",
    textContent: "",
    hidden: HIDDEN_BY_DEFAULT.indexOf(id) !== -1,
    disabled: false,
    focused: false,
    attributes: attributes,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dispatch(type, event) {
      (listeners[type] || []).forEach((fn) => fn(event || {}));
    },
    focus() {
      this.focused = true;
    },
    setAttribute(name, value) {
      attributes[name] = value;
    },
    removeAttribute(name) {
      delete attributes[name];
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
  };
}

/**
 * Charge la page `/rapport` avec son formulaire de correction, un faux réseau
 * et un `localStorage` inspectable.
 *
 * @param {object} lastEstimation
 * @param {{ reponses?: Array<object|Error>, mesure?: boolean, store?: Map }} [options]
 *   `reponses` : ce que le faux `fetch` renverra, dans l'ordre. Une `Error`
 *   simule une coupure réseau.
 */
function mountEditor(lastEstimation, options) {
  const opts = options || {};
  const elements = new Map();
  const store = opts.store || new Map();
  const requetes = [];
  const reponses = (opts.reponses || []).slice();
  let rechargements = 0;

  store.set("lastEstimation", JSON.stringify(lastEstimation));

  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    setTimeout: (fn, delay) => setTimeout(fn, delay),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: setInterval,
    clearInterval: clearInterval,
    Promise: Promise,
    AbortController: AbortController,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
      },
      querySelector() {
        return null;
      },
    },
    window: {
      location: {
        reload() {
          rechargements += 1;
        },
      },
      addEventListener() {},
      crypto: globalThis.crypto,
      dataLayer: [{ event: "consent_update" }],
    },
    TextEncoder,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    CONFIG: { API: { BASE_URL: "https://api.test.local" } },
    fetch(url, init) {
      requetes.push({ url: String(url), body: JSON.parse(init.body) });
      const next = reponses.shift();
      if (next instanceof Error) return Promise.reject(next);
      const body = next === undefined ? apiResult() : next;
      return Promise.resolve({
        status: body.__httpStatus || 200,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
      });
    },
  };
  vm.createContext(sandbox);

  if (opts.mesure) TRACKING_SCRIPT.runInContext(sandbox);
  WIZARD_SCRIPT.runInContext(sandbox);
  API_SCRIPT.runInContext(sandbox);
  EDIT_SCRIPT.runInContext(sandbox);

  return {
    sandbox,
    get: (id) => elements.get(id) || null,
    requetes,
    rechargements: () => rechargements,
    stocke: () => JSON.parse(store.get("lastEstimation")),
    pousses: () => sandbox.window.dataLayer,
    /** Saisit une valeur comme le ferait le visiteur. */
    saisir(id, value) {
      const el = elements.get(id);
      el.value = value;
      el.dispatch(el.tagName === "SELECT" ? "change" : "input");
    },
    /** Soumet le formulaire et laisse le faux réseau se dérouler. */
    async recalculer() {
      elements.get("reportEditForm").dispatch("submit", { preventDefault() {} });
      // Deux tours de boucle : `fetch` puis la lecture du corps JSON.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

// ============================================================================
// 7. Parcours nominal
// ============================================================================

test("recalcul — l'appel part sur /v1/estimations, et sur rien d'autre", async () => {
  const editor = mountEditor(baseLastEstimation());
  editor.saisir("surface", "58");
  await editor.recalculer();

  assert.equal(editor.requetes.length, 1);
  assert.equal(editor.requetes[0].url, "https://api.test.local/v1/estimations");
  assert.equal(
    editor.requetes.some((r) => r.url.includes("/v1/leads")),
    false,
    "un recalcul ne doit JAMAIS produire de lead"
  );
});

test("recalcul — aucune donnée personnelle dans le corps envoyé", async () => {
  const editor = mountEditor(baseLastEstimation());
  editor.saisir("surface", "58");
  await editor.recalculer();

  const corps = JSON.stringify(editor.requetes[0].body);
  for (const secret of ["Jean Dupont", "jean.dupont@example.com", "0612345678"]) {
    assert.equal(corps.indexOf(secret), -1, `« ${secret} » ne doit pas quitter la page`);
  }
  // L'adresse, elle, est indispensable au calcul et attendue par l'API.
  assert.equal(editor.requetes[0].body.address, "12 rue de la Paix");
  assert.equal(editor.requetes[0].body.surface, 58);
});

test("recalcul — le rapport enregistré est remplacé, l'identité du lead préservée", async () => {
  const editor = mountEditor(baseLastEstimation());
  editor.saisir("surface", "58");
  editor.saisir("dpe", "E");
  await editor.recalculer();

  const stocke = editor.stocke();

  assert.equal(stocke.estimation.estimationMoyenne, 640000);
  assert.equal(stocke.surface, 58);
  assert.equal(stocke.dpe, "E");
  assert.equal(stocke.estimationStatus, "ok");
  assert.equal(stocke.revision, 1);
  assert.equal(stocke.editedFields, "surface|dpe");
  assert.equal(stocke.lead_id, "11111111-2222-4333-8444-555555555555");
  assert.equal(stocke.email, "jean.dupont@example.com");
  assert.equal(editor.rechargements(), 1, "la page est rechargée pour être re-rendue");
});

test("recalcul — sans modification, aucun appel n'est émis", async () => {
  const editor = mountEditor(baseLastEstimation());
  await editor.recalculer();

  assert.equal(editor.requetes.length, 0, "un quota consommé pour un résultat identique");
  assert.equal(editor.get("reportEditStatus").hidden, false);
  assert.match(editor.get("reportEditStatus").textContent, /Aucune modification/);
  assert.equal(editor.rechargements(), 0);
});

// ============================================================================
// 8. Validation dans le formulaire
// ============================================================================

test("recalcul — une saisie invalide reste dans la page, sans appel réseau", async () => {
  const editor = mountEditor(baseLastEstimation());
  editor.saisir("surface", "0");
  await editor.recalculer();

  assert.equal(editor.requetes.length, 0);
  assert.equal(editor.get("surface-error").hidden, false);
  assert.match(editor.get("surface-error").textContent, /supérieur à 0/);
  assert.equal(editor.get("surface").getAttribute("aria-invalid"), "true");
  assert.equal(editor.get("reportEditStatus").getAttribute("data-tone"), "error");
  assert.equal(editor.rechargements(), 0);
});

test("recalcul — un 422 de l'API replace l'erreur sous le champ concerné", async () => {
  const editor = mountEditor(baseLastEstimation(), {
    reponses: [
      {
        __httpStatus: 422,
        code: "VALIDATION_ERROR",
        errors: [{ field: "body.surface", message: "Surface hors bornes admises." }],
      },
    ],
  });
  editor.saisir("surface", "5000");
  await editor.recalculer();

  assert.equal(editor.get("surface-error").hidden, false);
  assert.equal(editor.get("surface-error").textContent, "Surface hors bornes admises.");
  assert.equal(editor.stocke().surface, 85, "le rapport en place n'a pas bougé");
  assert.equal(editor.rechargements(), 0);
  assert.equal(editor.get("reportEditSubmit").disabled, false, "le visiteur reprend la main");
});

// ============================================================================
// 9. Échecs — le rapport en place n'est jamais dégradé
// ============================================================================

test("recalcul — réseau coupé : le rapport d'origine est conservé tel quel", async () => {
  const editor = mountEditor(baseLastEstimation(), {
    // Une coupure par tentative : `requestEstimation` en fait deux.
    reponses: [new Error("offline"), new Error("offline")],
  });
  editor.saisir("surface", "58");
  await editor.recalculer();
  await new Promise((resolve) => setTimeout(resolve, 1600)); // backoff du retry
  await new Promise((resolve) => setImmediate(resolve));

  const stocke = editor.stocke();
  assert.equal(stocke.surface, 85, "aucune écriture partielle");
  assert.equal(stocke.estimation.estimationMoyenne, 850000);
  assert.equal(stocke.revision, undefined);
  assert.equal(editor.rechargements(), 0);
  assert.match(editor.get("reportEditStatus").textContent, /reste affiché/);
  assert.equal(editor.get("reportEditSubmit").disabled, false);
});

test("recalcul — 429 : message explicite, aucune nouvelle tentative", async () => {
  const editor = mountEditor(baseLastEstimation(), {
    reponses: [{ __httpStatus: 429, code: "RATE_LIMITED", retryAfter: 30 }],
  });
  editor.saisir("dpe", "A");
  await editor.recalculer();

  assert.equal(editor.requetes.length, 1, "un 429 ne se rejoue pas");
  assert.match(editor.get("reportEditStatus").textContent, /Trop de demandes/);
  assert.equal(editor.stocke().dpe, "C");
  assert.equal(editor.rechargements(), 0);
});

test("recalcul — 200 sans valeur (bien non supporté) : rien n'est écrasé", async () => {
  const editor = mountEditor(baseLastEstimation(), {
    reponses: [apiResult({ value: null, method: { kind: "not-supported" } })],
  });
  editor.saisir("propertyType", "local-commercial");
  await editor.recalculer();

  assert.equal(editor.stocke().propertyType, "appartement");
  assert.equal(editor.rechargements(), 0);
  assert.match(editor.get("reportEditStatus").getAttribute("data-tone"), /error/);
});

// ============================================================================
// 10. Conditionnalité appliquée au DOM
// ============================================================================

test("formulaire — choisir « maison » révèle la question du terrain et masque l'étage", () => {
  const editor = mountEditor(baseLastEstimation());

  assert.equal(editor.get("floorGroup").hidden, false, "état de départ : appartement");
  assert.equal(editor.get("hasTerrainGroup").hidden, true);

  editor.saisir("propertyType", "maison");

  assert.equal(editor.get("hasTerrainGroup").hidden, false);
  assert.equal(editor.get("floorGroup").hidden, true);
  assert.equal(editor.get("floor").value, "", "un champ masqué est aussi vidé à l'écran");
});

test("formulaire — un terrain nu replie tout le bloc des précisions facultatives", () => {
  const editor = mountEditor(baseLastEstimation());
  editor.saisir("propertyType", "terrain");

  assert.equal(editor.get("reportEditOptional").hidden, true);
  assert.equal(editor.get("outdoorGroup").hidden, true);
  assert.equal(editor.get("conditionGroup").hidden, true);
});

test("formulaire — le champ est pré-rempli avec le rapport en place, et replié", () => {
  const editor = mountEditor(baseLastEstimation());

  assert.equal(editor.get("reportEditForm").hidden, true);
  assert.equal(editor.get("surface").value, "85");
  assert.equal(editor.get("dpe").value, "C");
  assert.equal(editor.get("condition").value, "good");
  assert.equal(editor.get("reportEditToggle").getAttribute("aria-expanded"), "false");
});

test("formulaire — le bouton d'ouverture bascule l'affichage et l'état ARIA", () => {
  const editor = mountEditor(baseLastEstimation());
  const toggle = editor.get("reportEditToggle");

  toggle.dispatch("click");
  assert.equal(editor.get("reportEditForm").hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  toggle.dispatch("click");
  assert.equal(editor.get("reportEditForm").hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("formulaire — annuler restitue les valeurs enregistrées", () => {
  const editor = mountEditor(baseLastEstimation());
  editor.get("reportEditToggle").dispatch("click");
  editor.saisir("surface", "58");

  editor.get("reportEditCancel").dispatch("click");

  assert.equal(editor.get("surface").value, "85");
  assert.equal(editor.get("reportEditForm").hidden, true);
});

// ============================================================================
// 11. Mesure de la correction
// ============================================================================

test("mesure — `report_estimation_edited` part une fois, et une seule", async () => {
  const corrige = baseLastEstimation({ revision: 1, editedFields: "surface|dpe" });
  const navigateur = new Map();

  const premier = mountEditor(corrige, { mesure: true, store: navigateur });
  await new Promise((resolve) => setImmediate(resolve));
  const second = mountEditor(corrige, { mesure: true, store: navigateur });
  await new Promise((resolve) => setImmediate(resolve));

  const evenements = (editor) =>
    editor.pousses().filter((charge) => charge && charge.event === "report_estimation_edited");

  assert.equal(evenements(premier).length, 1);
  assert.equal(evenements(second).length, 0, "un rechargement ne recompte pas");

  const evenement = evenements(premier)[0];
  assert.equal(evenement.estimation_revision, 1);
  assert.equal(evenement.changed_fields, "surface|dpe");
  assert.equal(evenement.lead_id, corrige.lead_id);
});

test("mesure — un rapport jamais corrigé n'émet rien", async () => {
  const editor = mountEditor(baseLastEstimation(), { mesure: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    editor.pousses().filter((charge) => charge && charge.event === "report_estimation_edited"),
    []
  );
});

test("mesure — aucune donnée personnelle n'accompagne l'événement", async () => {
  const editor = mountEditor(
    baseLastEstimation({ revision: 1, editedFields: "surface" }),
    { mesure: true }
  );
  await new Promise((resolve) => setImmediate(resolve));

  const pousses = JSON.stringify(editor.pousses());
  for (const secret of ["Jean Dupont", "jean.dupont@example.com", "0612345678"]) {
    assert.equal(pousses.indexOf(secret), -1);
  }
});

test("bandeau — un rapport corrigé le dit à l'écran", () => {
  const editor = mountEditor(baseLastEstimation({ revision: 1, editedFields: "surface" }));

  assert.equal(editor.get("reportEditNotice").hidden, false);
  assert.match(editor.get("reportEditNotice").textContent, /Surface habitable/);
});
