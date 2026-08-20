#!/usr/bin/env node
/**
 * Vérification autonome de `src/scripts/google-places.js`.
 *
 * Même technique que `scripts/test-estimation-wizard.mjs` : le fichier est
 * exécuté tel qu'il sera injecté en production (script classique, aucun
 * import/export) via `vm.Script#runInThisContext()`, qui attache ses
 * déclarations de premier niveau à l'objet global du process Node.
 *
 * Périmètre : les deux fonctions pures du fichier.
 * - `parseGooglePlace` : tests repris tels quels de
 *   `test-estimation-wizard.mjs`, d'où la fonction a été déplacée quand le
 *   champ d'adresse du hero de l'accueil a eu besoin du même adaptateur ;
 * - `parseAddressQuery` : assainissement des paramètres d'URL transmis par ce
 *   formulaire d'accueil au wizard (`/estimation?address=...`).
 *
 * `loadGoogleMapsScript` est couvert en fin de fichier sur un `document`
 * bouchonné (2 méthodes : `createElement` et `head.appendChild`). Ce qui s'y
 * joue n'est pas cosmétique : un build sans `PUBLIC_GOOGLE_MAPS_API_KEY`
 * produit `CONFIG.GOOGLE === {}` — une variable d'environnement absente vaut
 * `undefined` et disparaît du JSON sérialisé par `ClientConfig.astro`. Le
 * contrat verrouillé ici est qu'aucune URL Google n'est alors demandée (pas de
 * `key=undefined`), que le `false` renvoyé permet à l'appelant de basculer
 * tout de suite sur son repli manuel, et qu'un avertissement nomme la variable
 * manquante — sans quoi la panne est parfaitement muette en console.
 *
 * Usage : `node scripts/test-google-places.mjs` (ou `npm run test:google-places`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "google-places.js");

const SOURCE = readFileSync(SCRIPT_PATH, "utf8");
const SCRIPT = new vm.Script(SOURCE, { filename: "google-places.js" });

function loadGooglePlacesModule() {
  SCRIPT.runInThisContext();
  return {
    parseGooglePlace: globalThis.parseGooglePlace,
    parseAddressQuery: globalThis.parseAddressQuery,
    ADDRESS_QUERY_KEYS: globalThis.ADDRESS_QUERY_KEYS,
    loadGoogleMapsScript: globalThis.loadGoogleMapsScript,
    readGoogleMapsApiKey: globalThis.readGoogleMapsApiKey,
  };
}

/**
 * Exécute `scenario` avec un `document` minimal et un `CONFIG` donné, puis
 * remet le realm Node exactement dans l'état où il était.
 *
 * @param {{config?: object|undefined, withDocument?: boolean}} options
 *   `config` omis (`undefined`) = pas de global `CONFIG` du tout (cas d'une
 *   page servie sans `ClientConfig.astro`) ; `withDocument: false` = contexte
 *   sans DOM.
 */
function withGoogleEnv(options, scenario) {
  const opts = options || {};
  const appendedScripts = [];
  const warnings = [];

  const saved = {
    document: globalThis.document,
    CONFIG: globalThis.CONFIG,
    consoleWarn: console.warn,
  };

  if (opts.withDocument === false) {
    delete globalThis.document;
  } else {
    globalThis.document = {
      createElement(tagName) {
        return { tagName: String(tagName).toUpperCase(), src: "", async: false, defer: false };
      },
      head: {
        appendChild(node) {
          appendedScripts.push(node);
        },
      },
    };
  }

  if (Object.prototype.hasOwnProperty.call(opts, "config") && opts.config === undefined) {
    delete globalThis.CONFIG;
  } else {
    globalThis.CONFIG = opts.config;
  }

  console.warn = function () {
    warnings.push(Array.prototype.join.call(arguments, " "));
  };

  try {
    const module = loadGooglePlacesModule();
    return scenario({
      loadGoogleMapsScript: module.loadGoogleMapsScript,
      readGoogleMapsApiKey: module.readGoogleMapsApiKey,
      appendedScripts: appendedScripts,
      warnings: warnings,
    });
  } finally {
    console.warn = saved.consoleWarn;
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
    if (saved.CONFIG === undefined) delete globalThis.CONFIG;
    else globalThis.CONFIG = saved.CONFIG;
  }
}

// ============================================================================
// parseGooglePlace
// ============================================================================

test("parseGooglePlace — place complète avec locality", () => {
  const { parseGooglePlace } = loadGooglePlacesModule();
  const place = {
    place_id: "abc123",
    address_components: [
      { long_name: "12", types: ["street_number"] },
      { long_name: "Rue de la Paix", types: ["route"] },
      { long_name: "Paris", types: ["locality"] },
      { long_name: "Paris", types: ["administrative_area_level_2"] },
      { long_name: "75001", types: ["postal_code"] },
      { long_name: "France", types: ["country"] },
    ],
  };
  const result = parseGooglePlace(place);
  assert.deepEqual(result, { postalCode: "75001", city: "Paris", placeId: "abc123" });
});

test("parseGooglePlace — sans locality => repli sur administrative_area_level_2", () => {
  const { parseGooglePlace } = loadGooglePlacesModule();
  const place = {
    place_id: "def456",
    address_components: [
      { long_name: "45", types: ["street_number"] },
      { long_name: "Avenue Foch", types: ["route"] },
      { long_name: "Corse-du-Sud", types: ["administrative_area_level_2"] },
      { long_name: "20000", types: ["postal_code"] },
      { long_name: "France", types: ["country"] },
    ],
  };
  const result = parseGooglePlace(place);
  assert.deepEqual(result, { postalCode: "20000", city: "Corse-du-Sud", placeId: "def456" });
});

test("parseGooglePlace — locality présent AVANT administrative_area_level_2 dans le tableau : locality gagne quand même", () => {
  const { parseGooglePlace } = loadGooglePlacesModule();
  const place = {
    place_id: "ghi789",
    address_components: [
      { long_name: "Lyon", types: ["locality"] },
      { long_name: "Rhône", types: ["administrative_area_level_2"] },
      { long_name: "69001", types: ["postal_code"] },
    ],
  };
  const result = parseGooglePlace(place);
  assert.equal(result.city, "Lyon");
});

test("parseGooglePlace — sans address_components => null (US-3, repli manuel)", () => {
  const { parseGooglePlace } = loadGooglePlacesModule();
  assert.equal(parseGooglePlace({ name: "Un lieu sans détails" }), null);
  assert.equal(parseGooglePlace(null), null);
  assert.equal(parseGooglePlace(undefined), null);
});

// ============================================================================
// parseAddressQuery — pré-remplissage /estimation depuis l'accueil
// ============================================================================

test("parseAddressQuery — adresse complète issue d'une suggestion Google", () => {
  const { parseAddressQuery } = loadGooglePlacesModule();
  const result = parseAddressQuery(
    "?address=12%20rue%20de%20la%20Paix%2C%20Paris&postalCode=75001&city=Paris&addressSource=autocomplete"
  );
  assert.deepEqual(result, {
    address: "12 rue de la Paix, Paris",
    postalCode: "75001",
    city: "Paris",
    addressSource: "autocomplete",
  });
});

test("parseAddressQuery — fonctionne avec ou sans '?' initial", () => {
  const { parseAddressQuery } = loadGooglePlacesModule();
  assert.deepEqual(
    parseAddressQuery("address=Rue%20Neuve&city=Lyon&postalCode=69001&addressSource=autocomplete"),
    parseAddressQuery("?address=Rue%20Neuve&city=Lyon&postalCode=69001&addressSource=autocomplete")
  );
});

test("parseAddressQuery — sans adresse exploitable => null", () => {
  const { parseAddressQuery } = loadGooglePlacesModule();
  assert.equal(parseAddressQuery(""), null);
  assert.equal(parseAddressQuery("?postalCode=75001&city=Paris"), null);
  assert.equal(parseAddressQuery("?address=%20%20%20"), null); // que des espaces
  assert.equal(parseAddressQuery(undefined), null);
});

test("parseAddressQuery — code postal invalide ignoré (même règle que validateStep 1)", () => {
  const { parseAddressQuery } = loadGooglePlacesModule();
  const result = parseAddressQuery(
    "?address=12%20rue%20de%20la%20Paix&postalCode=7500&city=Paris&addressSource=autocomplete"
  );
  assert.equal(result.postalCode, "");
  // Sans code postal valide, la provenance ne peut plus être "autocomplete" :
  // le récapitulatif d'adresse du wizard prétendrait à une sélection Google
  // qui n'a pas abouti.
  assert.equal(result.addressSource, "manual");
});

test("parseAddressQuery — addressSource inventé => 'manual', jamais cru sur parole", () => {
  const { parseAddressQuery } = loadGooglePlacesModule();
  const result = parseAddressQuery(
    "?address=12%20rue%20de%20la%20Paix&postalCode=75001&city=Paris&addressSource=n%27importe%20quoi"
  );
  assert.equal(result.addressSource, "manual");
});

test("parseAddressQuery — adresse seule : ni CP, ni ville, ni provenance", () => {
  const { parseAddressQuery } = loadGooglePlacesModule();
  const result = parseAddressQuery("?address=12%20rue%20de%20la%20Paix");
  assert.deepEqual(result, {
    address: "12 rue de la Paix",
    postalCode: "",
    city: "",
    addressSource: "",
  });
});

test("parseAddressQuery — valeurs bornées en longueur", () => {
  const { parseAddressQuery } = loadGooglePlacesModule();
  const longAddress = "a".repeat(500);
  const longCity = "b".repeat(500);
  const result = parseAddressQuery(
    "?address=" + longAddress + "&city=" + longCity + "&postalCode=75001"
  );
  assert.equal(result.address.length, 200);
  assert.equal(result.city.length, 100);
});

test("ADDRESS_QUERY_KEYS — noms de paramètres partagés émetteur/consommateur", () => {
  const { ADDRESS_QUERY_KEYS } = loadGooglePlacesModule();
  assert.deepEqual(ADDRESS_QUERY_KEYS, {
    address: "address",
    postalCode: "postalCode",
    city: "city",
    source: "addressSource",
  });
});

// ============================================================================
// loadGoogleMapsScript — build SANS clé (régression : la panne observée en prod)
// ============================================================================

test("readGoogleMapsApiKey — CONFIG.GOOGLE vide (build sans la variable) => ''", () => {
  // Forme EXACTE produite par ClientConfig.astro quand la variable
  // d'environnement manque au build : la clé disparaît du JSON, `GOOGLE`
  // reste un objet vide. C'est le cas de production à couvrir.
  withGoogleEnv({ config: { GOOGLE: {} } }, ({ readGoogleMapsApiKey }) => {
    assert.equal(readGoogleMapsApiKey(), "");
  });
});

test("readGoogleMapsApiKey — absence totale de CONFIG ou de CONFIG.GOOGLE => ''", () => {
  withGoogleEnv({ config: undefined }, ({ readGoogleMapsApiKey }) => {
    assert.equal(readGoogleMapsApiKey(), "");
  });
  withGoogleEnv({ config: { EMAILJS: {} } }, ({ readGoogleMapsApiKey }) => {
    assert.equal(readGoogleMapsApiKey(), "");
  });
});

test("readGoogleMapsApiKey — clé blanche traitée comme absente", () => {
  withGoogleEnv({ config: { GOOGLE: { API_KEY: "   " } } }, ({ readGoogleMapsApiKey }) => {
    assert.equal(readGoogleMapsApiKey(), "");
  });
});

test("loadGoogleMapsScript — sans clé : AUCUNE URL Google n'est demandée", () => {
  withGoogleEnv({ config: { GOOGLE: {} } }, ({ loadGoogleMapsScript, appendedScripts }) => {
    const requested = loadGoogleMapsScript("initAutocomplete");
    // Le `false` est le signal qui permet à l'appelant de basculer TOUT DE
    // SUITE sur son repli manuel (cf. estimation-ui.js).
    assert.equal(requested, false);
    // Régression : une URL `key=undefined` ne produit qu'un InvalidKeyMapError
    // opaque, indiscernable d'une panne côté Google.
    assert.deepEqual(appendedScripts, []);
  });
});

test("loadGoogleMapsScript — sans clé : un avertissement nomme la variable manquante", () => {
  withGoogleEnv({ config: { GOOGLE: {} } }, ({ loadGoogleMapsScript, warnings }) => {
    loadGoogleMapsScript("initAutocomplete");
    assert.equal(warnings.length, 1);
    // Sans ce message, le symptôme est « l'autocomplétion ne marche pas » et
    // la console est parfaitement vide : rien ne pointe vers le build.
    assert.match(warnings[0], /PUBLIC_GOOGLE_MAPS_API_KEY/);
    assert.match(warnings[0], /BUILD/);
  });
});

test("loadGoogleMapsScript — avec clé : script injecté, clé et callback dans l'URL", () => {
  withGoogleEnv(
    { config: { GOOGLE: { API_KEY: "cle-de-test" } } },
    ({ loadGoogleMapsScript, appendedScripts, warnings }) => {
      const requested = loadGoogleMapsScript("initAutocomplete");
      assert.equal(requested, true);
      assert.equal(appendedScripts.length, 1);

      const src = appendedScripts[0].src;
      assert.match(src, /^https:\/\/maps\.googleapis\.com\/maps\/api\/js\?/);
      assert.match(src, /key=cle-de-test/);
      assert.match(src, /libraries=places/);
      assert.match(src, /callback=initAutocomplete/);
      assert.doesNotMatch(src, /key=undefined/);

      assert.equal(appendedScripts[0].async, true);
      assert.equal(appendedScripts[0].defer, true);
      assert.deepEqual(warnings, []);
    }
  );
});

test("loadGoogleMapsScript — `onerror` du script relaie vers le repli de l'appelant", () => {
  withGoogleEnv(
    { config: { GOOGLE: { API_KEY: "cle-de-test" } } },
    ({ loadGoogleMapsScript, appendedScripts }) => {
      let fallbackCalls = 0;
      loadGoogleMapsScript("initAutocomplete", () => {
        fallbackCalls += 1;
      });
      // Bloqueur de pub, réseau coupé : Google n'appellera jamais le callback,
      // c'est `onerror` qui doit rendre la main au repli manuel.
      appendedScripts[0].onerror();
      assert.equal(fallbackCalls, 1);
    }
  );
});

test("loadGoogleMapsScript — hors navigateur (pas de `document`) => false, sans throw", () => {
  withGoogleEnv(
    { withDocument: false, config: { GOOGLE: { API_KEY: "cle-de-test" } } },
    ({ loadGoogleMapsScript }) => {
      assert.equal(loadGoogleMapsScript("initAutocomplete"), false);
    }
  );
});
