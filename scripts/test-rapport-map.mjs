#!/usr/bin/env node
/**
 * Vérification autonome de `src/scripts/rapport-map.js` (carte de localisation
 * de `/rapport`).
 *
 * Même technique que les autres scripts de vérification du front : le fichier
 * est exécuté tel qu'il sera injecté en production (script classique, aucun
 * import/export) via `vm.Script#runInThisContext()`. Particularité de
 * celui-ci : il n'expose pas que des fonctions, il APPELLE `loadGoogleMapsAPI()`
 * à son dernier ligne. L'exécuter, c'est donc déjà exercer le comportement au
 * chargement de la page — d'où le bouchon de `document`/`localStorage`/`CONFIG`
 * posé AVANT chaque exécution.
 *
 * Ce qui est verrouillé ici est la panne observée en production : un build sans
 * `PUBLIC_GOOGLE_MAPS_API_KEY` produit `CONFIG.GOOGLE === {}` (une variable
 * d'environnement absente vaut `undefined` et disparaît du JSON sérialisé par
 * `ClientConfig.astro`). Le code demandait alors
 * `maps.googleapis.com/...?key=undefined`, ce qui donne un cadre gris muet et
 * une `InvalidKeyMapError` opaque, indiscernable d'une panne côté Google.
 *
 * Non couvert : le rendu de la carte elle-même (`initMap`), qui suppose un
 * `google.maps` complet — à vérifier en recette, avec une vraie clé.
 *
 * Usage : `node scripts/test-rapport-map.mjs` (ou `npm run test:rapport-map`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "rapport-map.js");

const SOURCE = readFileSync(SCRIPT_PATH, "utf8");
const SCRIPT = new vm.Script(SOURCE, { filename: "rapport-map.js" });

const ESTIMATION = {
  address: "12 rue de la Paix",
  postalCode: "75001",
  city: "paris",
  propertyType: "appartement",
};

/**
 * Monte le bouchon, exécute `rapport-map.js` (donc son `loadGoogleMapsAPI()`
 * final), passe le résultat à `scenario`, puis restaure le realm.
 *
 * @param {{apiKey?: string, stored?: string|null, config?: object}} options
 *   `apiKey` omis = build sans clé. `stored` est la valeur BRUTE de
 *   `localStorage.lastEstimation` (permet d'injecter du JSON corrompu).
 */
function withReportMap(options, scenario) {
  const opts = options || {};
  const appendedScripts = [];
  const warnings = [];

  const propertyMap = { id: "propertyMap", innerHTML: "" };
  const mapFullAddress = { id: "mapFullAddress", textContent: "Chargement de l'adresse..." };
  const elements = { propertyMap, mapFullAddress };

  const stored = Object.prototype.hasOwnProperty.call(opts, "stored")
    ? opts.stored
    : JSON.stringify(ESTIMATION);

  const saved = {
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    CONFIG: globalThis.CONFIG,
    consoleWarn: console.warn,
  };

  globalThis.document = {
    getElementById(id) {
      return Object.prototype.hasOwnProperty.call(elements, id) ? elements[id] : null;
    },
    createElement(tagName) {
      return { tagName: String(tagName).toUpperCase(), src: "", async: false, defer: false };
    },
    head: {
      appendChild(node) {
        appendedScripts.push(node);
      },
    },
  };

  globalThis.localStorage = {
    getItem(key) {
      return key === "lastEstimation" ? stored : null;
    },
  };

  globalThis.CONFIG = Object.prototype.hasOwnProperty.call(opts, "config")
    ? opts.config
    : { GOOGLE: opts.apiKey ? { API_KEY: opts.apiKey } : {} };

  console.warn = function () {
    warnings.push(Array.prototype.join.call(arguments, " "));
  };

  try {
    SCRIPT.runInThisContext();
    return scenario({
      appendedScripts: appendedScripts,
      warnings: warnings,
      propertyMap: propertyMap,
      mapFullAddress: mapFullAddress,
      loadGoogleMapsAPI: globalThis.loadGoogleMapsAPI,
    });
  } finally {
    console.warn = saved.consoleWarn;
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
    if (saved.localStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = saved.localStorage;
    if (saved.CONFIG === undefined) delete globalThis.CONFIG;
    else globalThis.CONFIG = saved.CONFIG;
  }
}

// ============================================================================
// Build SANS clé — la régression de production
// ============================================================================

test("sans clé : aucune requête n'est faite à Google", () => {
  withReportMap({}, ({ appendedScripts }) => {
    assert.deepEqual(appendedScripts, []);
  });
});

test("sans clé : jamais d'URL `key=undefined` injectée", () => {
  // Formulation redondante avec le test précédent, et volontairement : c'est
  // la formulation LITTÉRALE du défaut corrigé. Si un jour l'injection revient
  // sous une autre forme, ce test nomme précisément ce qui ne doit pas
  // réapparaître.
  withReportMap({}, ({ appendedScripts }) => {
    appendedScripts.forEach((node) => {
      assert.doesNotMatch(String(node.src), /key=(undefined|null|&|$)/);
    });
  });
});

test("sans clé : la carte est remplacée par un message lisible", () => {
  withReportMap({}, ({ propertyMap }) => {
    // Sans ce message, l'utilisateur voit un cadre vide de 22rem et peut
    // croire que tout le rapport est cassé.
    assert.match(propertyMap.innerHTML, /pas disponible/i);
  });
});

test("sans clé : l'adresse du bien reste affichée sous la carte", () => {
  withReportMap({}, ({ mapFullAddress }) => {
    // La carte est un agrément ; l'adresse, elle, fait partie du rapport.
    assert.equal(mapFullAddress.textContent, "12 rue de la Paix, 75001 paris, France");
  });
});

test("sans clé : un avertissement nomme la variable manquante", () => {
  withReportMap({}, ({ warnings }) => {
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /PUBLIC_GOOGLE_MAPS_API_KEY/);
    assert.match(warnings[0], /BUILD/);
  });
});

test("clé blanche (`'   '`) traitée comme absente", () => {
  withReportMap({ apiKey: "   " }, ({ appendedScripts, propertyMap }) => {
    assert.deepEqual(appendedScripts, []);
    assert.match(propertyMap.innerHTML, /pas disponible/i);
  });
});

test("CONFIG absent de la page : aucun throw, repli identique", () => {
  withReportMap({ config: undefined }, ({ appendedScripts, propertyMap }) => {
    assert.deepEqual(appendedScripts, []);
    assert.match(propertyMap.innerHTML, /pas disponible/i);
  });
});

// ============================================================================
// Build AVEC clé — non-régression du chemin nominal
// ============================================================================

test("avec clé : le script Google est injecté une fois, avec `callback=initMap`", () => {
  withReportMap({ apiKey: "cle-de-test" }, ({ appendedScripts, warnings }) => {
    assert.equal(appendedScripts.length, 1);

    const src = appendedScripts[0].src;
    assert.match(src, /^https:\/\/maps\.googleapis\.com\/maps\/api\/js\?/);
    assert.match(src, /key=cle-de-test/);
    assert.match(src, /callback=initMap/);

    assert.equal(appendedScripts[0].async, true);
    assert.equal(appendedScripts[0].defer, true);
    assert.deepEqual(warnings, []);
  });
});

test("avec clé : la carte n'est PAS écrasée par un message avant le chargement", () => {
  withReportMap({ apiKey: "cle-de-test" }, ({ propertyMap }) => {
    assert.equal(propertyMap.innerHTML, "");
  });
});

test("avec clé : l'adresse est affichée sans attendre le retour de Google", () => {
  // `renderMapAddress` est appelée AVANT l'injection du script : l'adresse ne
  // doit pas dépendre d'un aller-retour réseau.
  withReportMap({ apiKey: "cle-de-test" }, ({ mapFullAddress }) => {
    assert.equal(mapFullAddress.textContent, "12 rue de la Paix, 75001 paris, France");
  });
});

test("avec clé : `onerror` (bloqueur, réseau) affiche un message au lieu d'un cadre vide", () => {
  withReportMap({ apiKey: "cle-de-test" }, ({ appendedScripts, propertyMap }) => {
    appendedScripts[0].onerror();
    assert.match(propertyMap.innerHTML, /pas pu être chargée/i);
  });
});

// ============================================================================
// Absence / corruption de `lastEstimation`
// ============================================================================

test("sans `lastEstimation` : rien n'est demandé ni affiché (rapport-report.js redirige)", () => {
  withReportMap(
    { apiKey: "cle-de-test", stored: null },
    ({ appendedScripts, propertyMap, mapFullAddress }) => {
      assert.deepEqual(appendedScripts, []);
      // Aucun message ne doit clignoter avant la redirection vers /estimation/.
      assert.equal(propertyMap.innerHTML, "");
      assert.equal(mapFullAddress.textContent, "Chargement de l'adresse...");
    }
  );
});

test("`lastEstimation` corrompu : aucun throw au chargement de la page", () => {
  // Un JSON invalide en localStorage ne doit pas faire exploser le script au
  // premier appel : le `<script is:inline>` suivant ne s'exécuterait pas.
  assert.doesNotThrow(() => {
    withReportMap({ apiKey: "cle-de-test", stored: "{ ceci n'est pas du JSON" }, ({
      appendedScripts,
    }) => {
      assert.deepEqual(appendedScripts, []);
    });
  });
});
