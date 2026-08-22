#!/usr/bin/env node
/**
 * Vérification autonome de `src/scripts/acquisition.js` — provenance du
 * visiteur, mémorisée le temps de sa visite.
 *
 * Même technique que `scripts/test-lead-api.mjs` : le fichier est exécuté
 * EXACTEMENT tel qu'il sera injecté en production (script classique, aucun
 * import/export) via `vm.Script#runInThisContext()`.
 *
 * Ce que ce fichier couvre :
 * - `embParseAcquisition` : renommage des paramètres UTM vers le contrat de
 *   l'API, `gclid` seul pour Google Ads, référent réduit à son nom d'hôte et
 *   ignoré s'il est interne, troncature des valeurs fabriquées ;
 * - le MÉMO de session : la dernière campagne identifiée gagne, un simple
 *   passage d'une page à l'autre ne l'écrase pas, et un stockage indisponible
 *   ne casse rien — c'est le cas Safari en navigation privée ;
 * - l'absence de donnée personnelle : jamais l'URL complète du référent, qui
 *   peut porter la requête tapée dans un moteur de recherche.
 *
 * Usage : `node --test scripts/test-acquisition.mjs`
 *         (ou `npm run test:acquisition`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "acquisition.js");

const SCRIPT = new vm.Script(readFileSync(SCRIPT_PATH, "utf8"), {
  filename: "acquisition.js",
});

/**
 * Faux `sessionStorage`, avec l'option de lever comme le fait Safari en
 * navigation privée — le comportement que le code doit absorber.
 */
function fakeStorage({ throwing = false } = {}) {
  const data = new Map();
  return {
    getItem(key) {
      if (throwing) throw new Error("stockage indisponible");
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      if (throwing) throw new Error("stockage indisponible");
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    _data: data,
  };
}

/**
 * (Ré)exécute le module dans le realm courant, après avoir posé un
 * environnement de navigateur minimal.
 */
function loadAcquisitionModule({ href, referrer = "", storage = fakeStorage() } = {}) {
  if (href) {
    const url = new URL(href);
    globalThis.window = { location: { href: url.href, hostname: url.hostname } };
    globalThis.document = { referrer };
  } else {
    delete globalThis.window;
    delete globalThis.document;
  }
  globalThis.sessionStorage = storage;

  SCRIPT.runInThisContext();

  return {
    embParseAcquisition: globalThis.embParseAcquisition,
    embIsPaidTouch: globalThis.embIsPaidTouch,
    embRememberAcquisition: globalThis.embRememberAcquisition,
    embAcquisition: globalThis.embAcquisition,
    storage,
  };
}

test("les paramètres UTM sont renommés vers le contrat de l'API", () => {
  const { embParseAcquisition } = loadAcquisitionModule();

  const block = embParseAcquisition(
    "https://estimer.co/estimation?utm_source=meta&utm_medium=paid_social" +
      "&utm_campaign=meta_lead_proprietaire_idf_202608&utm_content=video_a&utm_id=1234",
    "",
    "estimer.co"
  );

  assert.equal(block.source, "meta");
  assert.equal(block.medium, "paid_social");
  assert.equal(block.campaign, "meta_lead_proprietaire_idf_202608");
  assert.equal(block.content, "video_a");
  assert.equal(block.campaignId, "1234");
  assert.equal(block.landingPage, "/estimation");
});

test("Google Ads se reconnaît à son seul gclid (aucun UTM, cf. plan §10.1)", () => {
  const { embParseAcquisition, embIsPaidTouch } = loadAcquisitionModule();

  const block = embParseAcquisition("https://estimer.co/?gclid=EAIaIQobCh", "", "estimer.co");

  assert.equal(block.gclid, "EAIaIQobCh");
  assert.equal(block.source, undefined);
  assert.equal(embIsPaidTouch(block), true);
});

test("le référent est réduit à son nom d'hôte, jamais l'URL complète", () => {
  const { embParseAcquisition } = loadAcquisitionModule();

  const block = embParseAcquisition(
    "https://estimer.co/",
    "https://www.google.com/search?q=prix+m2+rennes+appartement",
    "estimer.co"
  );

  // La requête tapée est du contenu saisi par le visiteur : elle n'a rien à
  // faire dans un lead.
  assert.equal(block.referrer, "www.google.com");
  assert.equal(JSON.stringify(block).includes("prix+m2"), false);
});

test("une navigation interne n'est pas une provenance", () => {
  const { embParseAcquisition } = loadAcquisitionModule();

  const block = embParseAcquisition("https://estimer.co/estimation", "https://estimer.co/", "estimer.co");

  assert.equal(block.referrer, undefined);
  assert.equal(block.landingPage, "/estimation");
});

test("une valeur fabriquée est tronquée", () => {
  const { embParseAcquisition } = loadAcquisitionModule();

  const block = embParseAcquisition(
    "https://estimer.co/?utm_campaign=" + "x".repeat(500),
    "",
    "estimer.co"
  );

  // Au-delà, l'API refuse le champ (422) et le lead serait perdu pour une
  // question de mesure.
  assert.equal(block.campaign.length, 120);
});

test("une URL illisible ne fait pas lever", () => {
  const { embParseAcquisition } = loadAcquisitionModule();

  assert.equal(embParseAcquisition("pas-une-url", "", "estimer.co"), null);
});

test("le mémo retient la première visite de la session", () => {
  const { embAcquisition, storage } = loadAcquisitionModule({
    href: "https://estimer.co/?utm_source=newsletter&utm_medium=email",
    referrer: "",
  });

  const block = embAcquisition();
  assert.equal(block.source, "newsletter");
  assert.equal(storage._data.has("emb_acquisition"), true);
});

test("passer d'une page à l'autre n'écrase pas la campagne d'arrivée", () => {
  const storage = fakeStorage();

  loadAcquisitionModule({
    href: "https://estimer.co/?gclid=EAIaIQobCh",
    referrer: "https://www.google.com/",
    storage,
  });

  // Deuxième page vue : plus aucun paramètre dans l'URL. C'est exactement la
  // situation au moment où le formulaire est soumis, quatre navigations plus
  // loin — sans le mémo, tout lead payant serait compté « accès direct ».
  const { embAcquisition } = loadAcquisitionModule({
    href: "https://estimer.co/estimation",
    referrer: "https://estimer.co/",
    storage,
  });

  assert.equal(embAcquisition().gclid, "EAIaIQobCh");
});

test("une nouvelle campagne dans la même session prend le dessus", () => {
  const storage = fakeStorage();

  loadAcquisitionModule({ href: "https://estimer.co/", referrer: "", storage });

  const { embAcquisition } = loadAcquisitionModule({
    href: "https://estimer.co/?utm_source=meta&utm_medium=paid_social",
    referrer: "https://l.facebook.com/",
    storage,
  });

  // Le commercial veut savoir si ce rappel a été payé : la dernière campagne
  // identifiée est la bonne réponse.
  assert.equal(embAcquisition().source, "meta");
});

test("un stockage indisponible ne casse ni le chargement ni la soumission", () => {
  const { embAcquisition } = loadAcquisitionModule({
    href: "https://estimer.co/?utm_source=meta",
    referrer: "",
    storage: fakeStorage({ throwing: true }),
  });

  // Safari en navigation privée lève sur la simple LECTURE du stockage. La
  // provenance est perdue, le parcours ne l'est pas.
  const block = embAcquisition();
  assert.equal(block.source, "meta");
});

test("hors navigateur, le module se charge sans lever", () => {
  const { embAcquisition } = loadAcquisitionModule();

  assert.equal(embAcquisition(), null);
});
