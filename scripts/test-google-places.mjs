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
 * `loadGoogleMapsScript` n'est pas couvert : il ne fait qu'injecter un
 * `<script>` dans le `document` (rien de pur à vérifier sans DOM ; il sort
 * d'ailleurs immédiatement quand `document` est absent, comme ici).
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
  };
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
