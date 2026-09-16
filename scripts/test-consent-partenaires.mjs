#!/usr/bin/env node
/**
 * Intégrité du registre de consentement à la transmission partenaire.
 *
 * ---------------------------------------------------------------------------
 * CE QUE CE FICHIER PROTÈGE, ET POURQUOI ÇA VAUT UN TEST À PART
 * ---------------------------------------------------------------------------
 * La mention d'accord (et le libellé du bouton qui vaut accord) existe en
 * DEUX exemplaires :
 *
 *   - `src/data/consent-partenaires.json`, que la page affiche ;
 *   - `api/app/lib/partner_consent.ts`, que le serveur archive comme preuve.
 *
 * La duplication est subie : l'image Docker de l'API se construit depuis
 * `./api` et ne peut pas lire `src/`. Mais elle a une conséquence qu'aucun
 * typage ne rattrape — le jour où les deux copies divergent, `partner_consents`
 * contient la preuve d'un accord à un texte que PERSONNE n'a jamais lu. Ce
 * n'est pas une preuve affaiblie, c'est une preuve fausse.
 *
 * D'où une comparaison caractère par caractère, y compris sur la ponctuation :
 * un tiret cadratin remplacé par un tiret court suffit à faire diverger deux
 * chaînes que l'œil lit identiques.
 *
 * Le fichier vérifie aussi que la page affiche ces libellés tels quels, avec
 * la version issue du registre — voir les tests eux-mêmes.
 *
 * Usage : `node --test scripts/test-consent-partenaires.mjs`
 *         (ou `npm run test:consent-partenaires`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.join(__dirname, "..");

const REGISTRE_FRONT = JSON.parse(
  readFileSync(path.join(RACINE, "src", "data", "consent-partenaires.json"), "utf8")
);

const SOURCE_API = readFileSync(
  path.join(RACINE, "api", "app", "lib", "partner_consent.ts"),
  "utf8"
);

const SOURCE_PAGE = readFileSync(
  path.join(RACINE, "src", "pages", "estimation.astro"),
  "utf8"
);

const SOURCE_WIZARD = readFileSync(
  path.join(RACINE, "src", "scripts", "estimation-wizard.js"),
  "utf8"
);

/**
 * Extrait le tableau du registre côté API.
 *
 * Le bloc est encadré de deux commentaires sentinelles et ne contient que du
 * JavaScript littéral (contrat écrit dans `partner_consent.ts`) : il s'évalue
 * donc tel quel, sans compilateur TypeScript ni dépendance de test.
 */
function lireRegistreApi() {
  const debut = SOURCE_API.indexOf("/* REGISTRE-DEBUT */");
  const fin = SOURCE_API.indexOf("/* REGISTRE-FIN */");
  assert.ok(debut !== -1 && fin > debut, "Sentinelles REGISTRE-DEBUT/FIN introuvables.");

  const litteral = SOURCE_API.slice(debut + "/* REGISTRE-DEBUT */".length, fin).trim();

  /*
   * Le contexte `vm` a ses propres `Array`/`Object` : un `deepStrictEqual`
   * comparerait deux tableaux au contenu identique et échouerait sur leurs
   * prototypes. Le passage par JSON ramène la valeur dans le realm courant —
   * et vérifie au passage qu'elle ne contient rien d'autre que des données.
   */
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${litteral})`)));
}

test("le registre de l'API contient la version affichée par le site", () => {
  const registreApi = lireRegistreApi();
  const versions = registreApi.map((entree) => entree.version);

  assert.ok(
    versions.includes(REGISTRE_FRONT.version),
    `La version affichée (${REGISTRE_FRONT.version}) est absente du registre de l'API : ` +
      "le serveur refuserait d'écrire la preuve de tous les accords donnés depuis cette page."
  );
});

test("texte et destinataires sont identiques des deux côtés, au caractère près", () => {
  const entree = lireRegistreApi().find(
    (candidate) => candidate.version === REGISTRE_FRONT.version
  );

  assert.equal(
    entree.texte,
    REGISTRE_FRONT.texte,
    "Le texte archivé comme preuve diffère de celui affiché à la personne."
  );
  assert.deepEqual(
    entree.partenaires,
    REGISTRE_FRONT.partenaires,
    "La liste des destinataires archivée diffère de celle affichée."
  );
  assert.equal(
    entree.bouton,
    REGISTRE_FRONT.bouton,
    "Le libellé du bouton archivé diffère de celui affiché."
  );
});

test("le bouton qui vaut accord annonce le rappel téléphonique", () => {
  /*
   * Depuis le 11 août 2026, un professionnel ne peut appeler un consommateur
   * qu'avec son consentement préalable. Le clic sur ce bouton est le geste
   * d'accord : c'est son libellé, archivé avec la mention, qui couvre l'appel.
   */
  assert.match(REGISTRE_FRONT.bouton, /rappel/);
});

test("la case à cocher a disparu de la page", () => {
  assert.ok(!SOURCE_PAGE.includes('id="partnerOptIn"'), "La case d'opt-in est toujours présente.");
});

test("la page lit la version dans le registre plutôt qu'en dur", () => {
  assert.match(
    SOURCE_PAGE,
    /data-consent-version=\{CONSENT_PARTENAIRES\.version\}/,
    "La version transmise à l'API doit venir du registre, sans quoi elle peut désigner " +
      "un texte autre que celui réellement affiché."
  );
  assert.match(
    SOURCE_PAGE,
    /id="partnerConsentMention"[^>]*>\{CONSENT_PARTENAIRES\.texte\}<\/p>/,
    "La mention doit être le texte du registre, seul et sans balisage : c'est lui qui fait preuve."
  );
  assert.match(
    SOURCE_PAGE,
    /<span>\{CONSENT_PARTENAIRES\.bouton\}<\/span>/,
    "Le bouton d'envoi doit afficher le libellé du registre : il est archivé comme preuve."
  );
});

test("l'accord n'est pas restauré depuis le stockage de session", () => {
  /*
   * `getPersistableFieldNames()` ne retient que les étapes 1 à 4. Le test
   * vérifie le résultat, pas la règle : c'est l'appartenance de `partnerOptIn`
   * à l'étape 5 qui l'exclut, et un déplacement de champ passerait autrement
   * inaperçu. Un accord repêché dans un sessionStorage — éditable depuis la
   * console — ne serait pas un accord.
   */
  const persistables = SOURCE_WIZARD.slice(
    SOURCE_WIZARD.indexOf("function getPersistableFieldNames()"),
    SOURCE_WIZARD.indexOf("function safeSessionStorageGet")
  );

  assert.match(persistables, /step\.id <= 4/);
  assert.ok(!persistables.includes("partnerOptIn"));
});
