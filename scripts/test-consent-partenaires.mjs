#!/usr/bin/env node
/**
 * Intégrité du registre de consentement à la transmission partenaire.
 *
 * ---------------------------------------------------------------------------
 * CE QUE CE FICHIER PROTÈGE, ET POURQUOI ÇA VAUT UN TEST À PART
 * ---------------------------------------------------------------------------
 * Le texte de la case à cocher existe en DEUX exemplaires :
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
 * Le fichier vérifie aussi les quatre propriétés du formulaire dont dépend la
 * validité juridique de l'accord (case jamais pré-cochée, jamais requise,
 * libellé nu, version issue du registre) — voir les tests eux-mêmes.
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
});

test("le texte nomme chacun des destinataires qu'il autorise", () => {
  // Un accord n'est « éclairé » que si la personne a lu les noms. Une liste
  // tenue à côté du texte, mais absente du texte, ne vaut rien.
  for (const partenaire of REGISTRE_FRONT.partenaires) {
    assert.ok(
      REGISTRE_FRONT.texte.includes(partenaire),
      `Le texte de la case ne cite pas « ${partenaire} », qu'il autorise pourtant.`
    );
  }
});

test("le texte couvre explicitement le démarchage téléphonique", () => {
  /*
   * Depuis le 11 août 2026, un professionnel ne peut appeler un consommateur
   * qu'avec son consentement préalable. Un lead transmis sans cette mention
   * est inexploitable par le partenaire qui le reçoit : autant le savoir en
   * test qu'en réclamation.
   */
  assert.match(
    REGISTRE_FRONT.texte,
    /téléphone/,
    "Le texte n'évoque pas l'appel téléphonique : l'accord ne couvre pas le démarchage."
  );
});

test("la case n'est jamais pré-cochée", () => {
  // CJUE, Planet49 (C-673/17) : une case pré-cochée n'est pas un consentement.
  const bloc = SOURCE_PAGE.slice(
    SOURCE_PAGE.indexOf('id="partnerOptIn"'),
    SOURCE_PAGE.indexOf("consent-optin__note")
  );

  assert.ok(bloc.length > 0, "Bloc d'opt-in introuvable dans estimation.astro.");
  assert.ok(!/\bchecked\b/.test(bloc), "La case d'opt-in partenaires est pré-cochée.");
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
    /<label for="partnerOptIn">\{CONSENT_PARTENAIRES\.texte\}<\/label>/,
    "Le libellé doit être le texte du registre, seul et sans balisage : c'est lui qui fait preuve."
  );
});

test("cocher n'est pas une condition d'accès au service", () => {
  /*
   * RGPD art. 7.4 : un consentement exigé pour accéder à un service n'est pas
   * libre, donc n'est pas un consentement. `partnerOptIn` doit rester hors de
   * `requiredFields`, sans quoi tous les accords recueillis seraient nuls.
   */
  const etape5 = SOURCE_WIZARD.slice(
    SOURCE_WIZARD.indexOf('key: "contact"'),
    SOURCE_WIZARD.indexOf("];", SOURCE_WIZARD.indexOf('key: "contact"'))
  );
  const requis = etape5.slice(etape5.indexOf("requiredFields:"));

  assert.ok(
    !requis.includes("partnerOptIn"),
    "`partnerOptIn` est devenu un champ requis : l'accord n'est plus libre."
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
