#!/usr/bin/env node
/**
 * Vérification autonome de `src/scripts/lead-api.js` — client de
 * `POST /v1/leads` (e-mails transactionnels, Scaleway TEM côté serveur).
 *
 * Même technique que `scripts/test-estimation-api.mjs` : le fichier est
 * exécuté EXACTEMENT tel qu'il sera injecté en production (script classique,
 * aucun import/export) via `vm.Script#runInThisContext()`, qui attache ses
 * déclarations `var`/`function` de premier niveau à l'objet global du process
 * Node — comme le ferait un `<script>` classique dans la page.
 *
 * Ce module est volontairement AUTONOME : contrairement à
 * `estimation-api.js`, il n'interroge ni `WIZARD_STEPS` ni `isFieldVisible`.
 * Il est chargé aussi bien par `/estimation` que par `/contact`, deux pages
 * qui n'ont pas le même code autour. Les tests le chargent donc seul, ce qui
 * vérifie aussi cette autonomie.
 *
 * Ce que ce fichier couvre :
 * - `buildEstimationLeadPayload` : typage des nombres, omission des champs
 *   facultatifs non renseignés (une énumération vide vaut 422 côté API), et
 *   surtout propagation de `estimationStatus` — c'est lui qui déclenche la
 *   mention « ESTIMATION NON CALCULEE » en tête de l'e-mail interne ;
 * - `buildContactLeadPayload` : sujet transmis en CODE et non en libellé,
 *   piège à robots transmis tel quel ;
 * - `requestLead` : succès, dry-run, 422, 429, 5xx, absence d'API, timeout,
 *   et surtout ABSENCE DE RETRY — rejouer un envoi d'e-mail produit un
 *   doublon ;
 * - `shouldUseLegacyFallback` : la règle anti-doublon qui décide si le repli
 *   EmailJS est autorisé.
 *
 * Usage : `node --test scripts/test-lead-api.mjs`
 *         (ou `npm run test:lead-api`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEAD_SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "lead-api.js");

const LEAD_SCRIPT = new vm.Script(readFileSync(LEAD_SCRIPT_PATH, "utf8"), {
  filename: "lead-api.js",
});

/** (Ré)exécute le module dans le realm courant et renvoie ses globales. */
function loadLeadModule() {
  LEAD_SCRIPT.runInThisContext();

  return {
    buildEstimationLeadPayload: globalThis.buildEstimationLeadPayload,
    buildContactLeadPayload: globalThis.buildContactLeadPayload,
    isLeadApiConfigured: globalThis.isLeadApiConfigured,
    shouldUseLegacyFallback: globalThis.shouldUseLegacyFallback,
    requestLead: globalThis.requestLead,
    LEAD_API_PATH: globalThis.LEAD_API_PATH,
    LEAD_API_TIMEOUT_MS: globalThis.LEAD_API_TIMEOUT_MS,
    LEAD_API_MAX_ATTEMPTS: globalThis.LEAD_API_MAX_ATTEMPTS,
  };
}

/**
 * Payload de soumission du wizard (`wizard.serializeForSubmit(estimation)`,
 * enrichi de `estimationStatus` par `finalizeSubmit`), surchargeable.
 */
function submitPayload(overrides) {
  return Object.assign(
    {
      id: 1750000000000,
      timestamp: "2026-08-20T09:00:00.000Z",
      propertyType: "maison",
      address: "12 avenue de la Senatorerie",
      postalCode: "23000",
      city: "Gueret",
      surface: 120,
      rooms: 5,
      dpe: "D",
      dpeRequest: "yes",
      isOwner: "yes",
      wantToSell: "maybe",
      hasTerrain: "yes",
      terrainSize: "600",
      floor: "",
      hasElevator: "",
      outdoor: "",
      condition: "good",
      name: "Jean Dupont",
      email: "jean.dupont@example.com",
      phone: "06 12 34 56 78",
      estimationStatus: "ok",
      estimation: {
        prixM2: 1850.4,
        estimationMin: 200000,
        estimationMoyenne: 222048,
        estimationMax: 244000,
        confidence: { score: 78 },
        method: { comparablesCount: 34 },
      },
    },
    overrides || {}
  );
}

/** Réponse HTTP bouchonnée, lisible par `readLeadResponse`. */
function jsonResponse(status, body, headers) {
  const lowered = {};
  Object.keys(headers || {}).forEach((key) => {
    lowered[key.toLowerCase()] = headers[key];
  });

  return {
    status: status,
    headers: {
      get(name) {
        const value = lowered[String(name).toLowerCase()];
        return value === undefined ? null : value;
      },
    },
    json() {
      return Promise.resolve(body === undefined ? null : body);
    },
  };
}

/** `fetch` bouchonné qui journalise ses appels et renvoie une réponse figée. */
function stubFetch(response) {
  const calls = [];
  const fetchImpl = function (url, init) {
    calls.push({
      url: url,
      method: init && init.method,
      headers: (init && init.headers) || {},
      body: init && init.body ? JSON.parse(init.body) : null,
    });
    return Promise.resolve(response);
  };
  return { fetchImpl: fetchImpl, calls: calls };
}

// ============================================================================
// buildEstimationLeadPayload — payload du lead d'estimation
// ============================================================================

test("buildEstimationLeadPayload — enveloppe complète : kind, coordonnées, bien, estimation", () => {
  const { buildEstimationLeadPayload } = loadLeadModule();
  const body = buildEstimationLeadPayload(submitPayload());

  assert.equal(body.kind, "estimation");
  assert.equal(body.name, "Jean Dupont");
  assert.equal(body.email, "jean.dupont@example.com");
  assert.equal(body.phone, "06 12 34 56 78");
  assert.deepEqual(Object.keys(body).sort(), ["email", "estimation", "kind", "name", "phone", "property"]);
});

test("buildEstimationLeadPayload — les coordonnées SONT transmises (contrairement à /v1/estimations)", () => {
  // Contrepoint explicite de `test-estimation-api.mjs`, qui vérifie l'inverse
  // pour l'endpoint de calcul. Les deux contrats sont opposés, et c'est le
  // sujet : le calcul ne doit jamais voir de PII, l'envoi d'e-mail ne peut
  // pas s'en passer.
  const { buildEstimationLeadPayload } = loadLeadModule();
  const body = buildEstimationLeadPayload(submitPayload());

  ["name", "email", "phone"].forEach((field) => {
    assert.ok(body[field], `${field} doit être transmis à /v1/leads`);
  });
});

test("buildEstimationLeadPayload — les nombres sont typés, pas des chaînes du DOM", () => {
  const { buildEstimationLeadPayload } = loadLeadModule();
  const body = buildEstimationLeadPayload(
    submitPayload({ surface: "85,5", rooms: "3", terrainSize: "600" })
  );

  assert.equal(body.property.surface, 85.5, "la virgule décimale française doit être acceptée");
  assert.equal(typeof body.property.surface, "number");
  assert.equal(body.property.rooms, 3);
  assert.equal(typeof body.property.rooms, "number");
  assert.equal(body.property.terrainSize, 600);
  assert.equal(typeof body.property.terrainSize, "number");
});

test("buildEstimationLeadPayload — les champs facultatifs vides sont OMIS, jamais envoyés vides", () => {
  const { buildEstimationLeadPayload } = loadLeadModule();
  const body = buildEstimationLeadPayload(
    submitPayload({
      floor: "",
      hasElevator: "",
      outdoor: "",
      condition: "",
      dpeRequest: "",
      isOwner: "",
      wantToSell: "",
    })
  );

  // La validation VineJS est stricte : une chaîne vide sur une énumération
  // vaut 422, alors que l'utilisateur n'a simplement rien renseigné.
  ["floor", "hasElevator", "outdoor", "condition", "dpeRequest", "isOwner", "wantToSell"].forEach(
    (field) => {
      assert.equal(field in body.property, false, `${field} ne doit pas être transmis vide`);
    }
  );
});

test("buildEstimationLeadPayload — une valeur hors énumération est écartée", () => {
  const { buildEstimationLeadPayload } = loadLeadModule();
  const body = buildEstimationLeadPayload(
    submitPayload({ outdoor: "piscine", condition: "neuf", propertyType: "chateau" })
  );

  assert.equal("outdoor" in body.property, false);
  assert.equal("condition" in body.property, false);
  assert.equal("propertyType" in body.property, false, "un type inconnu n'est pas inventé");
});

test("buildEstimationLeadPayload — un DPE inconnu retombe sur 'unknown' (champ requis côté API)", () => {
  const { buildEstimationLeadPayload } = loadLeadModule();
  assert.equal(buildEstimationLeadPayload(submitPayload({ dpe: "" })).property.dpe, "unknown");
  assert.equal(buildEstimationLeadPayload(submitPayload({ dpe: "Z" })).property.dpe, "unknown");
  assert.equal(buildEstimationLeadPayload(submitPayload({ dpe: "C" })).property.dpe, "C");
});

test("buildEstimationLeadPayload — sans terrain, la surface du terrain n'est pas transmise", () => {
  const { buildEstimationLeadPayload } = loadLeadModule();
  const body = buildEstimationLeadPayload(
    submitPayload({ hasTerrain: "no", terrainSize: "600" })
  );

  assert.equal(body.property.hasTerrain, "no");
  assert.equal("terrainSize" in body.property, false);
});

test("buildEstimationLeadPayload — un téléphone vide est omis plutôt qu'envoyé vide", () => {
  const { buildEstimationLeadPayload } = loadLeadModule();
  const body = buildEstimationLeadPayload(submitPayload({ phone: "" }));

  // Le champ est facultatif côté API, mais soumis à un format : une chaîne
  // vide (ou un « Non renseigné » de courtoisie) vaudrait 422.
  assert.equal("phone" in body, false);
});

test("buildEstimationLeadPayload — l'étage 0 (rez-de-chaussée) est transmis, pas confondu avec vide", () => {
  const { buildEstimationLeadPayload } = loadLeadModule();
  const body = buildEstimationLeadPayload(submitPayload({ propertyType: "appartement", floor: "0" }));

  assert.equal(body.property.floor, 0);
});

// ---------------------------------------------------------------------------
// Bloc `estimation` — c'est `status` qui déclenche la mention de mode dégradé
// en tête de l'e-mail interne. Le perdre, c'est faire annoncer au client un
// chiffre que personne n'a calculé sur des transactions réelles.
// ---------------------------------------------------------------------------

test("buildEstimationLeadPayload — estimation nominale : chiffres arrondis et métadonnées de confiance", () => {
  const { buildEstimationLeadPayload } = loadLeadModule();
  const block = buildEstimationLeadPayload(submitPayload()).estimation;

  assert.equal(block.status, "ok");
  assert.equal(block.prixM2, 1850, "les montants sont arrondis à l'entier");
  assert.equal(block.estimationMin, 200000);
  assert.equal(block.estimationMoyenne, 222048);
  assert.equal(block.estimationMax, 244000);
  assert.equal(block.confidenceScore, 78);
  assert.equal(block.comparablesCount, 34);
});

test("buildEstimationLeadPayload — repli statique : le statut suit, les chiffres aussi", () => {
  const { buildEstimationLeadPayload } = loadLeadModule();
  const block = buildEstimationLeadPayload(
    submitPayload({
      estimationStatus: "static-fallback",
      // Le calcul de repli ne produit ni confiance ni comparables.
      estimation: { prixM2: 1500, estimationMin: 170000, estimationMoyenne: 180000, estimationMax: 190000 },
    })
  ).estimation;

  assert.equal(block.status, "static-fallback");
  assert.equal(block.estimationMoyenne, 180000);
  assert.equal("confidenceScore" in block, false);
  assert.equal("comparablesCount" in block, false);
});

test("buildEstimationLeadPayload — estimation différée : statut seul, aucun chiffre inventé", () => {
  const { buildEstimationLeadPayload } = loadLeadModule();
  const block = buildEstimationLeadPayload(
    submitPayload({ estimationStatus: "deferred", estimation: null })
  ).estimation;

  assert.deepEqual(block, { status: "deferred" });
});

test("buildEstimationLeadPayload — un statut inconnu retombe sur 'deferred', jamais sur 'ok'", () => {
  const { buildEstimationLeadPayload } = loadLeadModule();
  const block = buildEstimationLeadPayload(
    submitPayload({ estimationStatus: "bizarre" })
  ).estimation;

  // Prudence délibérée : en cas de doute, le lead est signalé comme à
  // retraiter plutôt que présenté comme nominal.
  assert.equal(block.status, "deferred");
});

test("buildEstimationLeadPayload — tolère un payload vide sans lever", () => {
  const { buildEstimationLeadPayload } = loadLeadModule();
  const body = buildEstimationLeadPayload(undefined);

  assert.equal(body.kind, "estimation");
  assert.equal(body.name, "");
  assert.equal(body.property.dpe, "unknown");
  assert.equal(body.estimation.status, "ok");
});

// ============================================================================
// buildContactLeadPayload — payload du formulaire de contact
// ============================================================================

test("buildContactLeadPayload — kind contact, sujet transmis en CODE et non en libellé", () => {
  const { buildContactLeadPayload } = loadLeadModule();
  const body = buildContactLeadPayload({
    name: "Marie Martin",
    email: "marie@example.com",
    phone: "0612345678",
    subject: "partenariat",
    message: "Bonjour, je représente une agence.",
  });

  assert.equal(body.kind, "contact");
  assert.equal(body.name, "Marie Martin");
  assert.equal(body.email, "marie@example.com");
  assert.equal(body.phone, "0612345678");
  // C'est l'API qui produit « Devenir partenaire » : laisser la page fournir
  // le texte reviendrait à lui laisser décider du contenu de l'e-mail.
  assert.equal(body.subject, "partenariat");
  assert.equal(body.message, "Bonjour, je représente une agence.");
});

test("buildContactLeadPayload — téléphone et sujet vides sont omis", () => {
  const { buildContactLeadPayload } = loadLeadModule();
  const body = buildContactLeadPayload({
    name: "Marie Martin",
    email: "marie@example.com",
    phone: "",
    subject: "",
    message: "Bonjour",
  });

  assert.equal("phone" in body, false);
  assert.equal("subject" in body, false);
});

test("buildContactLeadPayload — le piège à robots n'est transmis que s'il est rempli", () => {
  const { buildContactLeadPayload } = loadLeadModule();

  const clean = buildContactLeadPayload({ name: "A B", email: "a@b.fr", message: "m" });
  assert.equal("website" in clean, false);

  const bot = buildContactLeadPayload({
    name: "A B",
    email: "a@b.fr",
    message: "m",
    website: "http://spam.example",
  });
  // Transmis tel quel : c'est l'API qui répond 200 sans envoyer, pour ne pas
  // apprendre au robot quel champ éviter au prochain passage.
  assert.equal(bot.website, "http://spam.example");
});

test("buildContactLeadPayload — les espaces parasites sont retirés", () => {
  const { buildContactLeadPayload } = loadLeadModule();
  const body = buildContactLeadPayload({
    name: "  Marie Martin  ",
    email: "  marie@example.com ",
    message: "  Bonjour  ",
  });

  assert.equal(body.name, "Marie Martin");
  assert.equal(body.email, "marie@example.com");
  assert.equal(body.message, "Bonjour");
});

// ============================================================================
// Provenance (bloc `acquisition`)
// ============================================================================

test("acquisition — la provenance est jointe au lead d'estimation", () => {
  const { buildEstimationLeadPayload } = loadLeadModule();
  const body = buildEstimationLeadPayload(submitPayload(), {
    gclid: "EAIaIQobCh",
    campaign: "gads_lead_proprietaire_idf_202608",
    landingPage: "/",
    referrer: "www.google.com",
  });

  assert.equal(body.acquisition.gclid, "EAIaIQobCh");
  assert.equal(body.acquisition.campaign, "gads_lead_proprietaire_idf_202608");
  assert.equal(body.acquisition.landingPage, "/");
});

test("acquisition — la provenance est jointe au message de contact", () => {
  const { buildContactLeadPayload } = loadLeadModule();
  const body = buildContactLeadPayload(
    { name: "Marie Martin", email: "marie@example.com", message: "Bonjour" },
    { source: "meta", medium: "paid_social" }
  );

  assert.equal(body.acquisition.source, "meta");
  assert.equal(body.acquisition.medium, "paid_social");
});

test("acquisition — un champ inconnu du mémo est ÉCARTÉ, jamais transmis", () => {
  const { buildEstimationLeadPayload } = loadLeadModule();
  const body = buildEstimationLeadPayload(submitPayload(), {
    source: "meta",
    // `sessionStorage` est éditable depuis la console : sans liste blanche, ce
    // champ ferait répondre 422 à l'API et le lead serait perdu.
    ga_client_id: "GA1.1.123456",
  });

  assert.equal(body.acquisition.source, "meta");
  assert.equal("ga_client_id" in body.acquisition, false);
});

test("acquisition — absente, aucun champ n'est envoyé", () => {
  const { buildEstimationLeadPayload, buildContactLeadPayload } = loadLeadModule();

  // La validation côté API est stricte : un objet vide vaut mieux qu'un bloc
  // rempli de chaînes vides, et l'absence de bloc vaut mieux qu'un objet vide.
  assert.equal("acquisition" in buildEstimationLeadPayload(submitPayload()), false);
  assert.equal("acquisition" in buildEstimationLeadPayload(submitPayload(), {}), false);
  assert.equal(
    "acquisition" in
      buildContactLeadPayload({ name: "Marie", email: "m@example.com", message: "Bonjour" }, null),
    false
  );
});

// ============================================================================
// isLeadApiConfigured
// ============================================================================

test("isLeadApiConfigured — vrai uniquement si une base URL est réellement posée", () => {
  const { isLeadApiConfigured } = loadLeadModule();

  assert.equal(isLeadApiConfigured({ BASE_URL: "https://api.estimer.co" }), true);
  assert.equal(isLeadApiConfigured({ BASE_URL: "" }), false);
  assert.equal(isLeadApiConfigured({ BASE_URL: "   " }), false);
  assert.equal(isLeadApiConfigured({}), false);
  assert.equal(isLeadApiConfigured(undefined), false);
});

// ============================================================================
// requestLead — appel réseau, ne rejette JAMAIS
// ============================================================================

test("requestLead — succès : POST JSON sur /v1/leads, statut ok et référence", async () => {
  const { requestLead, LEAD_API_PATH } = loadLeadModule();
  const stub = stubFetch(
    jsonResponse(200, { status: "sent", reference: "REF123456", acknowledgement: true })
  );

  const response = await requestLead(
    { kind: "contact" },
    { baseUrl: "https://api.test.local", fetchImpl: stub.fetchImpl }
  );

  assert.equal(response.status, "ok");
  assert.equal(response.mode, "sent");
  assert.equal(response.reference, "REF123456");
  assert.equal(response.httpStatus, 200);

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].url, "https://api.test.local" + LEAD_API_PATH);
  assert.equal(stub.calls[0].method, "POST");
  assert.equal(stub.calls[0].headers["Content-Type"], "application/json");
  assert.deepEqual(stub.calls[0].body, { kind: "contact" });
});

test("requestLead — la barre finale de la base URL ne produit pas de double slash", async () => {
  const { requestLead } = loadLeadModule();
  const stub = stubFetch(jsonResponse(200, { status: "sent" }));

  await requestLead({}, { baseUrl: "https://api.test.local///", fetchImpl: stub.fetchImpl });

  assert.equal(stub.calls[0].url, "https://api.test.local/v1/leads");
});

test("requestLead — dry-run : succès du parcours, mais AUCUN e-mail n'existe", async () => {
  const { requestLead } = loadLeadModule();
  const stub = stubFetch(jsonResponse(200, { status: "dry-run", reference: "REFDRY" }));

  const response = await requestLead({}, { baseUrl: "https://api.test.local", fetchImpl: stub.fetchImpl });

  assert.equal(response.status, "ok");
  // Distinction essentielle : le front doit pouvoir avertir en console que le
  // lead n'a été envoyé nulle part, sans pour autant bloquer l'utilisateur.
  assert.equal(response.mode, "dry-run");
  assert.equal(response.reference, "REFDRY");
});

test("requestLead — 422 : erreurs ramenées à des noms de champ du formulaire", async () => {
  const { requestLead } = loadLeadModule();
  const stub = stubFetch(
    jsonResponse(422, {
      code: "VALIDATION_ERROR",
      errors: [
        { field: "email", rule: "email", message: "Adresse e-mail invalide." },
        { field: "property.surface", rule: "min", message: "La surface est trop petite." },
        { field: "inconnu", rule: "unknown_field", message: "Champ non reconnu." },
      ],
    })
  );

  const response = await requestLead({}, { baseUrl: "https://api.test.local", fetchImpl: stub.fetchImpl });

  assert.equal(response.status, "invalid");
  assert.equal(response.httpStatus, 422);
  assert.equal(response.code, "VALIDATION_ERROR");
  assert.equal(response.errors.email, "Adresse e-mail invalide.");
  // Le préfixe d'objet est retiré : `surface` est l'`#id` de l'input du
  // wizard, ce qui permet à `wizard.setErrors()` de replacer l'utilisateur
  // sur le bon champ sans table de correspondance.
  assert.equal(response.errors.surface, "La surface est trop petite.");
  assert.equal(response.errors.inconnu, "Champ non reconnu.");
});

test("requestLead — 429 : délai lu dans le corps, message prêt à afficher", async () => {
  const { requestLead } = loadLeadModule();
  const stub = stubFetch(
    jsonResponse(429, { code: "RATE_LIMITED", message: "Trop de requêtes.", retryAfter: 42 })
  );

  const response = await requestLead({}, { baseUrl: "https://api.test.local", fetchImpl: stub.fetchImpl });

  assert.equal(response.status, "rate-limited");
  assert.equal(response.retryAfter, 42);
  assert.match(response.message, /42 secondes/);
});

test("requestLead — 429 : à défaut de corps, le délai est lu dans l'en-tête Retry-After", async () => {
  const { requestLead } = loadLeadModule();
  const stub = stubFetch(jsonResponse(429, { code: "RATE_LIMITED" }, { "Retry-After": "17" }));

  const response = await requestLead({}, { baseUrl: "https://api.test.local", fetchImpl: stub.fetchImpl });

  assert.equal(response.status, "rate-limited");
  assert.equal(response.retryAfter, 17);
});

test("requestLead — 502 MAIL_UNAVAILABLE : échec serveur explicite, référence conservée", async () => {
  const { requestLead } = loadLeadModule();
  const stub = stubFetch(
    jsonResponse(502, {
      code: "MAIL_UNAVAILABLE",
      message: "Votre demande n'a pas pu être transmise.",
      reference: "REF502",
    })
  );

  const response = await requestLead({}, { baseUrl: "https://api.test.local", fetchImpl: stub.fetchImpl });

  assert.equal(response.status, "failed");
  assert.equal(response.reason, "server");
  assert.equal(response.httpStatus, 502);
  assert.equal(response.code, "MAIL_UNAVAILABLE");
  assert.equal(response.reference, "REF502");
});

test("requestLead — 500 : UNE seule tentative, jamais de retry", async () => {
  const { requestLead, LEAD_API_MAX_ATTEMPTS } = loadLeadModule();
  const stub = stubFetch(jsonResponse(500, { code: "INTERNAL_ERROR" }));

  const response = await requestLead({}, { baseUrl: "https://api.test.local", fetchImpl: stub.fetchImpl });

  assert.equal(response.status, "failed");
  assert.equal(response.reason, "server");
  /*
   * LE test de non-régression du module. Rejouer une requête dont on n'a pas
   * lu la réponse, sur un endpoint qui envoie des e-mails, produit un second
   * e-mail chaque fois que la première avait en réalité abouti.
   */
  assert.equal(LEAD_API_MAX_ATTEMPTS, 1);
  assert.equal(stub.calls.length, 1, "aucun retry ne doit être tenté");
});

test("requestLead — 404 (front déployé avant l'API) : échec serveur, rien n'est parti", async () => {
  const { requestLead } = loadLeadModule();
  const stub = stubFetch(jsonResponse(404, { code: "NOT_FOUND", message: "Ressource introuvable." }));

  const response = await requestLead({}, { baseUrl: "https://api.test.local", fetchImpl: stub.fetchImpl });

  assert.equal(response.status, "failed");
  assert.equal(response.reason, "server");
  assert.equal(response.httpStatus, 404);
});

test("requestLead — sans base URL : aucune requête émise, raison 'no-config'", async () => {
  const { requestLead } = loadLeadModule();
  const stub = stubFetch(jsonResponse(200, { status: "sent" }));

  const response = await requestLead({}, { baseUrl: "", fetchImpl: stub.fetchImpl });

  assert.equal(response.status, "failed");
  assert.equal(response.reason, "no-config");
  assert.equal(stub.calls.length, 0, "aucun appel réseau sans PUBLIC_API_URL");
  assert.match(response.message, /PUBLIC_API_URL/);
});

test("requestLead — erreur réseau : jamais de rejet, raison 'network'", async () => {
  const { requestLead } = loadLeadModule();
  const fetchImpl = function () {
    return Promise.reject(new Error("hors ligne"));
  };

  const response = await requestLead({}, { baseUrl: "https://api.test.local", fetchImpl: fetchImpl });

  assert.equal(response.status, "failed");
  assert.equal(response.reason, "network");
});

test("requestLead — un fetch qui lève de façon synchrone est absorbé", async () => {
  const { requestLead } = loadLeadModule();
  const fetchImpl = function () {
    throw new Error("fetch cassé");
  };

  const response = await requestLead({}, { baseUrl: "https://api.test.local", fetchImpl: fetchImpl });

  assert.equal(response.status, "failed");
  assert.equal(response.reason, "network");
});

test("requestLead — timeout : la requête est avortée et la raison est 'timeout'", async () => {
  const { requestLead } = loadLeadModule();

  // `fetch` qui ne répond jamais, et qui rejette quand le signal est avorté —
  // exactement le comportement du vrai `fetch` avec un `AbortController`.
  let rejectPending = null;
  const fetchImpl = function () {
    return new Promise(function (_, reject) {
      rejectPending = reject;
    });
  };

  let aborted = false;
  function AbortControllerStub() {
    this.signal = {};
    this.abort = function () {
      aborted = true;
      if (rejectPending) rejectPending(new Error("AbortError"));
    };
  }

  const response = await requestLead(
    {},
    {
      baseUrl: "https://api.test.local",
      fetchImpl: fetchImpl,
      abortControllerImpl: AbortControllerStub,
      timeoutMs: 5,
    }
  );

  assert.equal(aborted, true, "la requête doit être réellement avortée");
  assert.equal(response.status, "failed");
  assert.equal(response.reason, "timeout");
  assert.match(response.message, /délai/);
});

test("requestLead — un corps illisible sur un 200 ne fait pas échouer l'envoi", async () => {
  const { requestLead } = loadLeadModule();
  const stub = stubFetch({
    status: 200,
    headers: {
      get() {
        return null;
      },
    },
    json() {
      return Promise.reject(new Error("JSON invalide"));
    },
  });

  const response = await requestLead({}, { baseUrl: "https://api.test.local", fetchImpl: stub.fetchImpl });

  // L'e-mail est parti côté serveur : c'est notre lecture de la réponse qui a
  // échoué. Traiter ce cas en échec déclencherait un repli, donc un doublon.
  assert.equal(response.status, "ok");
  assert.equal(response.mode, "sent");
  assert.equal(response.reference, null);
});

test("requestLead — le callback reçoit la réponse, et son exception ne rejette pas la promesse", async () => {
  const { requestLead } = loadLeadModule();
  const stub = stubFetch(jsonResponse(200, { status: "sent", reference: "REF1" }));
  const seen = [];

  const savedError = console.error;
  console.error = function () {};
  try {
    const response = await requestLead(
      {},
      { baseUrl: "https://api.test.local", fetchImpl: stub.fetchImpl },
      function (r) {
        seen.push(r);
        throw new Error("appelant fautif");
      }
    );
    assert.equal(response.status, "ok");
  } finally {
    console.error = savedError;
  }

  assert.equal(seen.length, 1);
  assert.equal(seen[0].reference, "REF1");
});

// ============================================================================
// shouldUseLegacyFallback — la règle anti-doublon
// ============================================================================
//
// Le repli EmailJS n'est autorisé que lorsque la réponse PROUVE qu'aucun
// e-mail n'est parti. Tout le reste est refusé, chacun pour sa raison : un
// timeout peut correspondre à un envoi en cours, un 422 à une saisie que
// l'API vient de refuser, un 429 à un quota qu'on ne contourne pas.

test("shouldUseLegacyFallback — autorisé quand aucun e-mail n'a pu partir", () => {
  const { shouldUseLegacyFallback } = loadLeadModule();

  assert.equal(shouldUseLegacyFallback({ status: "failed", reason: "no-config" }), true);
  assert.equal(shouldUseLegacyFallback({ status: "failed", reason: "network" }), true);
  assert.equal(shouldUseLegacyFallback({ status: "failed", reason: "server" }), true);
});

test("shouldUseLegacyFallback — REFUSÉ sur un succès (le doublon serait garanti)", () => {
  const { shouldUseLegacyFallback } = loadLeadModule();

  assert.equal(shouldUseLegacyFallback({ status: "ok", mode: "sent", reason: null }), false);
  assert.equal(shouldUseLegacyFallback({ status: "ok", mode: "dry-run", reason: null }), false);
});

test("shouldUseLegacyFallback — REFUSÉ sur timeout : l'envoi est peut-être en cours", () => {
  const { shouldUseLegacyFallback } = loadLeadModule();

  assert.equal(shouldUseLegacyFallback({ status: "failed", reason: "timeout" }), false);
});

test("shouldUseLegacyFallback — REFUSÉ sur 422 et 429", () => {
  const { shouldUseLegacyFallback } = loadLeadModule();

  // 422 : rejouer enverrait un lead que l'API vient de juger invalide, sans
  // que l'utilisateur ait rien corrigé.
  assert.equal(shouldUseLegacyFallback({ status: "invalid", reason: "http" }), false);
  // 429 : contourner un quota par un autre canal, c'est le supprimer.
  assert.equal(shouldUseLegacyFallback({ status: "rate-limited", reason: "http" }), false);
});

test("shouldUseLegacyFallback — tolère une réponse absente ou malformée", () => {
  const { shouldUseLegacyFallback } = loadLeadModule();

  assert.equal(shouldUseLegacyFallback(undefined), false);
  assert.equal(shouldUseLegacyFallback(null), false);
  assert.equal(shouldUseLegacyFallback({}), false);
});

// ============================================================================
// Bout en bout : le payload construit est bien celui qui part sur le réseau
// ============================================================================

test("intégration — le lead d'estimation part avec son statut de mode dégradé", async () => {
  const { buildEstimationLeadPayload, requestLead } = loadLeadModule();
  const stub = stubFetch(jsonResponse(200, { status: "sent", reference: "REF9" }));

  await requestLead(
    buildEstimationLeadPayload(submitPayload({ estimationStatus: "static-fallback" })),
    { baseUrl: "https://api.test.local", fetchImpl: stub.fetchImpl }
  );

  const sent = stub.calls[0].body;
  assert.equal(sent.kind, "estimation");
  assert.equal(sent.estimation.status, "static-fallback");
  assert.equal(sent.property.city, "Gueret");
  assert.equal(sent.email, "jean.dupont@example.com");
});
