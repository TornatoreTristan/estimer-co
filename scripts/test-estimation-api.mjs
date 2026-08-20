#!/usr/bin/env node
/**
 * Vérification autonome de `src/scripts/estimation-api.js`.
 *
 * Même technique que `scripts/test-estimation-wizard.mjs` : le fichier est
 * exécuté EXACTEMENT tel qu'il sera injecté en production (script classique,
 * aucun import/export) via `vm.Script#runInThisContext()`, qui attache ses
 * déclarations `var`/`function` de premier niveau à l'objet global du process
 * Node — comme le ferait un `<script>` classique dans la page.
 *
 * `estimation-wizard.js` est chargé AVANT dans le même realm, comme en
 * production (`estimation.astro`) : `buildEstimationApiPayload` interroge
 * `isFieldVisible()` et `mapApiErrorToFieldErrors` interroge `WIZARD_STEPS`.
 * Deux tests vérifient explicitement que le module reste utilisable SANS le
 * wizard, puisque `/rapport` le charge seul (bouton « Relancer le calcul »).
 *
 * Ce que ce fichier couvre :
 * - `buildEstimationApiPayload` : aucune PII transmise (garantie §2.6), champs
 *   optionnels omis plutôt qu'envoyés vides, conditionnalité déléguée au
 *   wizard, typage des nombres ;
 * - `mapApiErrorToFieldErrors` : 422 -> `wizard.state.errors`, sans table de
 *   correspondance, avec repli `_form` pour les champs hors formulaire ;
 * - `mapApiResultToLegacyEstimation` : les quatre clés historiques sont
 *   préservées (non-régression US-11), les nouvelles sont additionnelles ;
 * - `resolveEstimationStatus` : décision client (repli statique par défaut) ;
 * - `requestEstimation` : timeout, retry unique sur réseau/5xx, AUCUN retry
 *   sur 4xx, ne rejette jamais.
 *
 * Usage : `node --test scripts/test-estimation-api.mjs`
 *         (ou `npm run test:estimation-api`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIZARD_SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "estimation-wizard.js");
const API_SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "estimation-api.js");

const WIZARD_SCRIPT = new vm.Script(readFileSync(WIZARD_SCRIPT_PATH, "utf8"), {
  filename: "estimation-wizard.js",
});
const API_SCRIPT = new vm.Script(readFileSync(API_SCRIPT_PATH, "utf8"), {
  filename: "estimation-api.js",
});

/**
 * (Ré)exécute les modules dans le realm courant.
 *
 * @param {{withWizard?: boolean}} [options] `withWizard: false` simule le
 *   chargement isolé de `/rapport`, où `estimation-wizard.js` n'est PAS
 *   présent : `isFieldVisible` et `WIZARD_STEPS` sont alors indéfinis.
 */
function loadApiModule(options) {
  const withWizard = !options || options.withWizard !== false;

  if (withWizard) {
    WIZARD_SCRIPT.runInThisContext();
  } else {
    // `runInThisContext` crée des globales non configurables : on ne peut pas
    // les `delete`, on les neutralise donc en les remettant à `undefined` —
    // ce que voient les gardes `typeof … !== "function"` du module.
    globalThis.isFieldVisible = undefined;
    globalThis.WIZARD_STEPS = undefined;
  }

  API_SCRIPT.runInThisContext();

  return {
    buildEstimationApiPayload: globalThis.buildEstimationApiPayload,
    mapApiErrorToFieldErrors: globalThis.mapApiErrorToFieldErrors,
    mapApiResultToLegacyEstimation: globalThis.mapApiResultToLegacyEstimation,
    resolveEstimationStatus: globalThis.resolveEstimationStatus,
    requestEstimation: globalThis.requestEstimation,
    ESTIMATION_API_FORBIDDEN_FIELDS: globalThis.ESTIMATION_API_FORBIDDEN_FIELDS,
    ESTIMATION_API_TIMEOUT_MS: globalThis.ESTIMATION_API_TIMEOUT_MS,
    ESTIMATION_API_PATH: globalThis.ESTIMATION_API_PATH,
    createDefaultWizardData: globalThis.createDefaultWizardData,
  };
}

/** `wizard.state.data` complet, surchargé au besoin. */
function wizardData(overrides) {
  return Object.assign(
    {
      address: "12 avenue de la Senatorerie",
      postalCode: "23000",
      city: "Gueret",
      placeId: "",
      addressSource: "manual",
      propertyType: "maison",
      hasTerrain: "yes",
      terrainSize: "600",
      surface: "100",
      rooms: "5",
      dpe: "D",
      dpeRequest: "",
      floor: "",
      hasElevator: "",
      outdoor: "",
      condition: "good",
      isOwner: "yes",
      wantToSell: "yes",
      name: "Jean Dupont",
      email: "jean@dupont.fr",
      phone: "0612345678",
    },
    overrides || {}
  );
}

/** `EstimationResult` minimal mais réaliste (forme réelle de l'API, §5.3). */
function apiResult(overrides) {
  return Object.assign(
    {
      apiVersion: 1,
      requestId: "n1sxr405dgtsbt8h6egh7xba",
      value: 144000,
      pricePerSqm: 1440,
      range: { low: 108000, high: 180000, halfWidthPct: 0.25, basis: "iqr" },
      confidence: {
        score: 66,
        label: "medium",
        breakdown: { count: 37.02, proximity: 20, freshness: 8.84, dispersion: 0.33, penalties: 0 },
      },
      display: { showCentralValue: true, confidenceLabelFr: "Confiance moyenne", warnings: [] },
      method: {
        kind: "comparables",
        level: "radius",
        radiusM: 1000,
        windowMonths: 24,
        surfaceTolerancePct: 30,
        comparablesCount: 23,
        comparablesRejected: {},
        medianPriceM2Raw: 1302,
        timeAdjustmentFactor: 1,
        coefficients: {
          surface: 0.9945,
          floor: 1,
          outdoor: 1,
          condition: 1.03,
          dpe: 1,
          total: 1.0244,
          clamped: false,
        },
        landValue: 10937,
      },
      location: {
        label: "12 Avenue de la Sénatorerie 23000 Guéret",
        cityCode: "23096",
        city: "Guéret",
        postcode: "23000",
        lon: 1.870229,
        lat: 46.1672,
        geocodePrecision: "exact",
      },
      comparables: [
        {
          street: "Rue Du Senechal",
          city: "Guéret",
          distanceM: 350,
          date: "2025-03",
          propertyType: "maison",
          surface: 120,
          rooms: 5,
          pricePerSqm: 880,
          price: 106000,
          timeAdjustedPricePerSqm: 880,
        },
      ],
      dataSource: {
        dataCoverage: "dvf",
        primary: "DVF",
        dvfPublicationDate: "2026-05-18T13:14:12.000Z",
        lastImportAt: "2026-08-19T13:47:52.107Z",
        priceIndexQuarter: null,
        licence: "Licence Ouverte / Etalab 2.0",
        attributionFr: "Source : Demandes de valeurs foncières (DVF)…",
        disclaimerFr: "Cette estimation automatisée ne constitue ni une expertise…",
      },
      computedAt: "2026-08-19T13:55:34.159Z",
    },
    overrides || {}
  );
}

/**
 * Faux `fetch` scénarisé : chaque appel consomme le pas suivant du scénario.
 * Un pas est soit `{ status, body, headers }`, soit `{ throws: 'network' }`,
 * soit `{ hangs: true }` (ne se résout jamais -> déclenche le timeout).
 */
function scriptedFetch(steps) {
  const calls = [];
  const fetchImpl = function (url, init) {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];

    if (step.throws) {
      return Promise.reject(new Error(step.throws));
    }

    if (step.hangs) {
      return new Promise(function (resolve, reject) {
        // Rejette quand l'AbortController déclenche, comme le vrai `fetch`.
        if (init && init.signal) {
          init.signal.addEventListener("abort", function () {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }
      });
    }

    return Promise.resolve({
      status: step.status,
      json: function () {
        return step.body === undefined
          ? Promise.reject(new Error("no body"))
          : Promise.resolve(step.body);
      },
      headers: {
        get: function (name) {
          return step.headers ? step.headers[name] || null : null;
        },
      },
    });
  };

  return { fetchImpl, calls };
}

const BASE_OPTIONS = {
  baseUrl: "https://api.estimer.co",
  timeoutMs: 40,
  retryDelayMs: 1,
};

// ============================================================================
// buildEstimationApiPayload — RGPD (§2.6) et forme du corps HTTP (§6.1)
// ============================================================================

test("buildEstimationApiPayload — ne transmet JAMAIS name/email/phone", () => {
  const { buildEstimationApiPayload, ESTIMATION_API_FORBIDDEN_FIELDS } = loadApiModule();
  const payload = buildEstimationApiPayload(wizardData());

  ESTIMATION_API_FORBIDDEN_FIELDS.forEach((field) => {
    assert.equal(field in payload, false, `${field} ne doit jamais être transmis à l'API`);
  });

  // Ceinture et bretelles : aucune des VALEURS personnelles ne doit se
  // retrouver dans le corps sérialisé, sous quelque clé que ce soit.
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("Jean Dupont"), false);
  assert.equal(serialized.includes("jean@dupont.fr"), false);
  assert.equal(serialized.includes("0612345678"), false);
});

test("buildEstimationApiPayload — types et clés attendus par la validation VineJS", () => {
  const { buildEstimationApiPayload } = loadApiModule();
  const payload = buildEstimationApiPayload(wizardData());

  assert.equal(payload.address, "12 avenue de la Senatorerie");
  assert.equal(payload.postalCode, "23000");
  assert.equal(payload.city, "Gueret");
  assert.equal(payload.propertyType, "maison");
  assert.equal(payload.surface, 100);
  assert.equal(typeof payload.surface, "number");
  assert.equal(payload.rooms, 5);
  assert.equal(typeof payload.rooms, "number");
  assert.equal(payload.dpe, "D");
  assert.equal(payload.terrainSize, 600);
  assert.equal(payload.condition, "good");
});

test("buildEstimationApiPayload — un champ optionnel non renseigné est OMIS, jamais envoyé vide", () => {
  const { buildEstimationApiPayload } = loadApiModule();
  const payload = buildEstimationApiPayload(
    wizardData({ propertyType: "appartement", hasTerrain: "", terrainSize: "", condition: "" })
  );

  // Une chaîne vide sur une énumération VineJS stricte vaudrait 422 alors que
  // l'utilisateur n'a simplement rien répondu : ces champs sont facultatifs.
  ["floor", "hasElevator", "outdoor", "condition", "terrainSize"].forEach((field) => {
    assert.equal(field in payload, false, `${field} vide ne doit pas être transmis`);
  });
});

test("buildEstimationApiPayload — floor/hasElevator suivent la conditionnalité du wizard", () => {
  const { buildEstimationApiPayload } = loadApiModule();

  const appartement = buildEstimationApiPayload(
    wizardData({ propertyType: "appartement", hasTerrain: "", terrainSize: "", floor: "3", hasElevator: "yes" })
  );
  assert.equal(appartement.floor, 3);
  assert.equal(appartement.hasElevator, true);

  // Même données, mais une maison : la règle de visibilité de
  // `WIZARD_STEPS[].conditionalFields` masque l'étage et l'ascenseur, donc on
  // ne les transmet pas. La règle n'est PAS redéclarée dans estimation-api.js.
  const maison = buildEstimationApiPayload(
    wizardData({ propertyType: "maison", floor: "3", hasElevator: "yes" })
  );
  assert.equal("floor" in maison, false);
  assert.equal("hasElevator" in maison, false);
});

test("buildEstimationApiPayload — « je ne sais pas » sur l'ascenseur n'affirme rien", () => {
  const { buildEstimationApiPayload } = loadApiModule();
  const payload = buildEstimationApiPayload(
    wizardData({ propertyType: "appartement", hasTerrain: "", hasElevator: "unknown" })
  );
  assert.equal(
    "hasElevator" in payload,
    false,
    "'unknown' ne doit pas être transmis comme `false`"
  );
});

test("buildEstimationApiPayload — DPE absent devient 'unknown' (valeur acceptée par l'API)", () => {
  const { buildEstimationApiPayload } = loadApiModule();
  assert.equal(buildEstimationApiPayload(wizardData({ dpe: "" })).dpe, "unknown");
  assert.equal(buildEstimationApiPayload(wizardData({ dpe: "Z" })).dpe, "unknown");
});

test("buildEstimationApiPayload — hasTerrain='no' n'envoie pas de surface de terrain", () => {
  const { buildEstimationApiPayload } = loadApiModule();
  const payload = buildEstimationApiPayload(wizardData({ hasTerrain: "no", terrainSize: "600" }));
  assert.equal("terrainSize" in payload, false);
});

test("buildEstimationApiPayload — utilisable sans estimation-wizard.js (page /rapport)", () => {
  const { buildEstimationApiPayload } = loadApiModule({ withWizard: false });
  // Données au format `lastEstimation` : surface et rooms sont déjà des nombres.
  const payload = buildEstimationApiPayload({
    address: "12 avenue de la Senatorerie",
    postalCode: "23000",
    city: "Gueret",
    propertyType: "maison",
    surface: 100,
    rooms: 5,
    dpe: "D",
    hasTerrain: "yes",
    terrainSize: "600",
    condition: "good",
    name: "Jean Dupont",
  });

  assert.equal(payload.surface, 100);
  assert.equal(payload.rooms, 5);
  assert.equal(payload.terrainSize, 600);
  assert.equal("name" in payload, false);
});

// ============================================================================
// mapApiErrorToFieldErrors — 422 -> wizard.state.errors (§7.1 « invalid »)
// ============================================================================

test("mapApiErrorToFieldErrors — mappe champ par champ, sans table de correspondance", () => {
  const { mapApiErrorToFieldErrors } = loadApiModule();
  const errors = mapApiErrorToFieldErrors({
    code: "VALIDATION_ERROR",
    errors: [
      { field: "postalCode", rule: "regex", message: "Le code postal doit comporter 5 chiffres." },
      { field: "rooms", rule: "min", message: "Le bien doit comporter au moins 1 pièce." },
    ],
  });

  assert.deepEqual(errors, {
    postalCode: "Le code postal doit comporter 5 chiffres.",
    rooms: "Le bien doit comporter au moins 1 pièce.",
  });
});

test("mapApiErrorToFieldErrors — un chemin VineJS préfixé est réduit au nom du champ", () => {
  const { mapApiErrorToFieldErrors } = loadApiModule();
  const errors = mapApiErrorToFieldErrors({
    errors: [{ field: "body.surface", rule: "min", message: "Surface trop faible." }],
  });
  assert.deepEqual(errors, { surface: "Surface trop faible." });
});

test("mapApiErrorToFieldErrors — un champ hors formulaire tombe dans _form", () => {
  const { mapApiErrorToFieldErrors } = loadApiModule();
  const errors = mapApiErrorToFieldErrors({
    errors: [{ field: "lat", rule: "min", message: "Latitude hors de France." }],
  });
  // `lat` n'a pas de `#id` dans le formulaire : le message ne doit pas être
  // perdu, mais il n'a aucun champ où s'afficher.
  assert.equal(errors._form, "Latitude hors de France.");
  assert.equal("lat" in errors, false);
});

test("mapApiErrorToFieldErrors — un refus de PII ne s'affiche pas sous le champ « Nom »", () => {
  const { mapApiErrorToFieldErrors } = loadApiModule();
  const errors = mapApiErrorToFieldErrors({
    errors: [
      { field: "name", rule: "forbidden_pii", message: "Ce champ n'est pas accepté." },
    ],
  });
  // `name` EST un champ du wizard (étape 5), mais il n'est jamais transmis :
  // une telle erreur trahit un bug de notre côté, pas une saisie fautive. La
  // reporter sous le champ « Nom » induirait l'utilisateur en erreur.
  assert.equal("name" in errors, false);
  assert.equal(errors._form, "Ce champ n'est pas accepté.");
});

test("mapApiErrorToFieldErrors — entrées vides ou corps illisible ne cassent rien", () => {
  const { mapApiErrorToFieldErrors } = loadApiModule();
  assert.deepEqual(mapApiErrorToFieldErrors(null), {});
  assert.deepEqual(mapApiErrorToFieldErrors({}), {});
  assert.deepEqual(mapApiErrorToFieldErrors({ errors: "nope" }), {});
  assert.deepEqual(mapApiErrorToFieldErrors({ errors: [{ field: "surface" }] }), {});
});

// ============================================================================
// mapApiResultToLegacyEstimation — NON-RÉGRESSION US-11
// ============================================================================

test("mapApiResultToLegacyEstimation — les quatre clés historiques sont préservées", () => {
  const { mapApiResultToLegacyEstimation } = loadApiModule();
  const estimation = mapApiResultToLegacyEstimation(apiResult());

  // Mêmes noms, même niveau, même type : c'est le contrat que lisent
  // `rapport-report.js` et `pdf-report.js`.
  assert.equal(estimation.prixM2, 1440);
  assert.equal(estimation.estimationMin, 108000);
  assert.equal(estimation.estimationMax, 180000);
  assert.equal(estimation.estimationMoyenne, 144000);
  ["prixM2", "estimationMin", "estimationMax", "estimationMoyenne"].forEach((key) => {
    assert.equal(typeof estimation[key], "number", `${key} doit rester un number`);
  });
});

test("mapApiResultToLegacyEstimation — les nouvelles clés sont additionnelles", () => {
  const { mapApiResultToLegacyEstimation } = loadApiModule();
  const estimation = mapApiResultToLegacyEstimation(apiResult());

  assert.equal(estimation.confidence.score, 66);
  assert.equal(estimation.range.halfWidthPct, 0.25);
  assert.equal(estimation.method.comparablesCount, 23);
  assert.equal(estimation.comparables.length, 1);
  assert.equal(estimation.location.cityCode, "23096");
  assert.equal(estimation.dataSource.dataCoverage, "dvf");
  assert.equal(estimation.display.showCentralValue, true);
  assert.equal(estimation.apiVersion, 1);
});

test("mapApiResultToLegacyEstimation — value null (not-supported) -> null, aucun prix inventé", () => {
  const { mapApiResultToLegacyEstimation } = loadApiModule();
  assert.equal(
    mapApiResultToLegacyEstimation(apiResult({ value: null, pricePerSqm: null })),
    null
  );
  assert.equal(mapApiResultToLegacyEstimation(null), null);
  assert.equal(mapApiResultToLegacyEstimation("nope"), null);
});

test("mapApiResultToLegacyEstimation — comparables absents deviennent un tableau vide", () => {
  const { mapApiResultToLegacyEstimation } = loadApiModule();
  const estimation = mapApiResultToLegacyEstimation(apiResult({ comparables: undefined }));
  assert.deepEqual(estimation.comparables, []);
});

// ============================================================================
// resolveEstimationStatus — décision client : le repli affiche un prix
// ============================================================================

test("resolveEstimationStatus — succès avec valeur -> 'ok'", () => {
  const { resolveEstimationStatus } = loadApiModule();
  assert.equal(
    resolveEstimationStatus({ status: "ok", result: apiResult() }, { FALLBACK: "static" }),
    "ok"
  );
});

test("resolveEstimationStatus — 200 sans valeur (not-supported) -> 'deferred'", () => {
  const { resolveEstimationStatus } = loadApiModule();
  // Ce n'est pas une panne : c'est l'API qui dit « je ne sais pas » (§3.2,
  // local commercial). On ne fabrique donc pas un prix de repli.
  assert.equal(
    resolveEstimationStatus(
      { status: "ok", result: apiResult({ value: null }) },
      { FALLBACK: "static" }
    ),
    "deferred"
  );
});

test("resolveEstimationStatus — échec + FALLBACK 'static' (défaut) -> 'static-fallback'", () => {
  const { resolveEstimationStatus } = loadApiModule();
  assert.equal(
    resolveEstimationStatus({ status: "deferred", result: null }, { FALLBACK: "static" }),
    "static-fallback"
  );
  // FALLBACK absent : le défaut 'static' s'applique (décision client).
  assert.equal(resolveEstimationStatus({ status: "deferred", result: null }, {}), "static-fallback");
  assert.equal(resolveEstimationStatus({ status: "deferred", result: null }), "static-fallback");
});

test("resolveEstimationStatus — échec + FALLBACK 'none' -> 'deferred'", () => {
  const { resolveEstimationStatus } = loadApiModule();
  assert.equal(
    resolveEstimationStatus({ status: "deferred", result: null }, { FALLBACK: "none" }),
    "deferred"
  );
});

// ============================================================================
// requestEstimation — timeout, retry, ne rejette jamais
// ============================================================================

test("requestEstimation — succès 200 : status 'ok', une seule tentative", async () => {
  const { requestEstimation, ESTIMATION_API_PATH } = loadApiModule();
  const { fetchImpl, calls } = scriptedFetch([{ status: 200, body: apiResult() }]);

  const response = await requestEstimation(
    { address: "x" },
    Object.assign({ fetchImpl }, BASE_OPTIONS)
  );

  assert.equal(response.status, "ok");
  assert.equal(response.result.value, 144000);
  assert.equal(response.attempts, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.estimer.co" + ESTIMATION_API_PATH);
  assert.equal(calls[0].init.method, "POST");
});

test("requestEstimation — le callback reçoit la même réponse que la promesse", async () => {
  const { requestEstimation } = loadApiModule();
  const { fetchImpl } = scriptedFetch([{ status: 200, body: apiResult() }]);

  let fromCallback = null;
  const response = await requestEstimation(
    {},
    Object.assign({ fetchImpl }, BASE_OPTIONS),
    (r) => {
      fromCallback = r;
    }
  );
  assert.equal(fromCallback, response);
});

test("requestEstimation — 422 : status 'invalid', erreurs mappées, AUCUN retry", async () => {
  const { requestEstimation } = loadApiModule();
  const { fetchImpl, calls } = scriptedFetch([
    {
      status: 422,
      body: {
        code: "VALIDATION_ERROR",
        errors: [{ field: "surface", rule: "min", message: "Surface trop faible." }],
      },
    },
  ]);

  const response = await requestEstimation({}, Object.assign({ fetchImpl }, BASE_OPTIONS));

  assert.equal(response.status, "invalid");
  assert.deepEqual(response.errors, { surface: "Surface trop faible." });
  assert.equal(calls.length, 1, "un 4xx ne doit JAMAIS être rejoué");
});

test("requestEstimation — 429 : status 'rate-limited', retryAfter lu, AUCUN retry", async () => {
  const { requestEstimation } = loadApiModule();
  const { fetchImpl, calls } = scriptedFetch([
    { status: 429, body: { code: "RATE_LIMITED", message: "Trop de requêtes.", retryAfter: 42 } },
  ]);

  const response = await requestEstimation({}, Object.assign({ fetchImpl }, BASE_OPTIONS));

  assert.equal(response.status, "rate-limited");
  assert.equal(response.retryAfter, 42);
  assert.ok(response.message.includes("42"));
  assert.equal(calls.length, 1, "US-8 : le front ne retente jamais après un 429");
});

test("requestEstimation — 429 sans corps : Retry-After lu dans l'en-tête", async () => {
  const { requestEstimation } = loadApiModule();
  const { fetchImpl } = scriptedFetch([
    { status: 429, body: {}, headers: { "Retry-After": "17" } },
  ]);

  const response = await requestEstimation({}, Object.assign({ fetchImpl }, BASE_OPTIONS));
  assert.equal(response.retryAfter, 17);
});

test("requestEstimation — 404 : retour à l'étape 1 avec une erreur sur l'adresse", async () => {
  const { requestEstimation } = loadApiModule();
  const { fetchImpl, calls } = scriptedFetch([
    { status: 404, body: { code: "COMMUNE_NOT_FOUND", message: "Commune inconnue." } },
  ]);

  const response = await requestEstimation({}, Object.assign({ fetchImpl }, BASE_OPTIONS));

  assert.equal(response.status, "invalid");
  assert.equal(response.addressUnresolved, true);
  assert.ok(response.errors.address, "l'erreur doit porter sur le champ adresse");
  assert.equal(calls.length, 1);
});

test("requestEstimation — 500 : un SEUL retry, puis échec", async () => {
  const { requestEstimation } = loadApiModule();
  const { fetchImpl, calls } = scriptedFetch([
    { status: 500, body: { code: "INTERNAL_ERROR" } },
    { status: 500, body: { code: "INTERNAL_ERROR" } },
    { status: 500, body: { code: "INTERNAL_ERROR" } },
  ]);

  const response = await requestEstimation({}, Object.assign({ fetchImpl }, BASE_OPTIONS));

  assert.equal(response.status, "deferred");
  assert.equal(calls.length, 2, "1 appel + 1 retry, pas davantage");
  assert.equal(response.attempts, 2);
});

test("requestEstimation — 5xx puis succès : la seconde tentative est retenue", async () => {
  const { requestEstimation } = loadApiModule();
  const { fetchImpl, calls } = scriptedFetch([
    { status: 503, body: { code: "DATA_UNAVAILABLE" } },
    { status: 200, body: apiResult() },
  ]);

  const response = await requestEstimation({}, Object.assign({ fetchImpl }, BASE_OPTIONS));

  assert.equal(response.status, "ok");
  assert.equal(calls.length, 2);
});

test("requestEstimation — erreur réseau : retry puis échec, sans jamais rejeter", async () => {
  const { requestEstimation } = loadApiModule();
  const { fetchImpl, calls } = scriptedFetch([{ throws: "network down" }]);

  const response = await requestEstimation({}, Object.assign({ fetchImpl }, BASE_OPTIONS));

  assert.equal(response.status, "deferred");
  assert.equal(response.reason, "network");
  assert.equal(calls.length, 2);
});

test("requestEstimation — timeout : la requête est abandonnée puis rejouée une fois", async () => {
  const { requestEstimation } = loadApiModule();
  const { fetchImpl, calls } = scriptedFetch([{ hangs: true }]);

  const response = await requestEstimation({}, Object.assign({ fetchImpl }, BASE_OPTIONS));

  assert.equal(response.status, "deferred");
  assert.equal(response.reason, "timeout");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].init.signal, "un AbortSignal doit être passé à fetch");
});

test("requestEstimation — timeout de 6 s par défaut (§2.4)", () => {
  const { ESTIMATION_API_TIMEOUT_MS } = loadApiModule();
  assert.equal(ESTIMATION_API_TIMEOUT_MS, 6000);
});

test("requestEstimation — sans PUBLIC_API_URL : échec immédiat, aucun fetch", async () => {
  const { requestEstimation } = loadApiModule();
  const { fetchImpl, calls } = scriptedFetch([{ status: 200, body: apiResult() }]);

  const response = await requestEstimation({}, { baseUrl: "", fetchImpl });

  assert.equal(response.status, "deferred");
  assert.equal(response.reason, "no-config");
  assert.equal(calls.length, 0);
});

test("requestEstimation — un callback qui throw ne transforme pas la promesse en rejet", async () => {
  const { requestEstimation } = loadApiModule();
  const { fetchImpl } = scriptedFetch([{ status: 200, body: apiResult() }]);

  const response = await requestEstimation(
    {},
    Object.assign({ fetchImpl }, BASE_OPTIONS),
    () => {
      throw new Error("boom");
    }
  );
  assert.equal(response.status, "ok");
});

test("requestEstimation — corps 200 illisible : échec propre, pas d'exception", async () => {
  const { requestEstimation } = loadApiModule();
  const { fetchImpl } = scriptedFetch([{ status: 200 }]); // json() rejette

  const response = await requestEstimation({}, Object.assign({ fetchImpl }, BASE_OPTIONS));
  assert.equal(response.status, "deferred");
  assert.equal(response.result, null);
});

test("requestEstimation — la barre finale de PUBLIC_API_URL est normalisée", async () => {
  const { requestEstimation } = loadApiModule();
  const { fetchImpl, calls } = scriptedFetch([{ status: 200, body: apiResult() }]);

  await requestEstimation(
    {},
    Object.assign({}, BASE_OPTIONS, { fetchImpl, baseUrl: "https://api.estimer.co///" })
  );
  assert.equal(calls[0].url, "https://api.estimer.co/v1/estimations");
});
