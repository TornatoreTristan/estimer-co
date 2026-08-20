#!/usr/bin/env node
/**
 * Vérification du bandeau de consentement et du socle Consent Mode v2
 * (`src/components/Analytics.astro`, `src/components/ConsentBanner.astro`,
 * `src/lib/analytics.ts`).
 *
 * ---------------------------------------------------------------------------
 * POURQUOI CE TEST CONSTRUIT LE SITE AU LIEU D'EXÉCUTER UN SCRIPT
 * ---------------------------------------------------------------------------
 * Les autres vérifications du front exécutent un fichier de `src/scripts/` sur
 * un bouchon de `document`. Ce n'est pas transposable ici : ce qui doit être
 * garanti n'est pas le comportement d'une fonction, c'est **ce qui atterrit
 * dans la page livrée** — l'ordre des scripts dans le `<head>`, l'absence de
 * tout traceur quand rien n'est configuré, la bascule du texte légal. Autant
 * de choses qu'un bouchon ne dirait pas, et qu'une régression de configuration
 * casserait sans toucher à une seule ligne de JavaScript.
 *
 * Le site est donc construit deux fois, dans un répertoire temporaire, une
 * fois dans chaque état de l'interrupteur décrit en tête de `lib/analytics.ts`.
 *
 * Ce qui est verrouillé, ce sont les promesses faites au visiteur et à la
 * CNIL, reprises des scénarios B4/B5 de `specs/cms-seo-tracking.md` :
 *
 *   1. sans conteneur de tags, la page ne contient AUCUN script Google, aucun
 *      bandeau, et la politique de confidentialité l'affirme ;
 *   2. avec un conteneur, tous les signaux de consentement valent `denied`
 *      AVANT que le conteneur ne soit chargé — l'ordre est le fond du sujet,
 *      un défaut posé après le conteneur ne protège rien ;
 *   3. aucune catégorie n'est précochée, et refuser est présenté au même
 *      niveau qu'accepter ;
 *   4. le choix est révocable, et sa durée annoncée dans la politique est
 *      celle réellement appliquée par le bandeau.
 *
 * Usage : `node --test scripts/test-consent-banner.mjs`
 *         (ou `npm run test:consent`).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.join(__dirname, "..");

const CONTENEUR_FICTIF = "GTM-TESTXYZ";

/**
 * Construit le site dans un répertoire jetable et rend ses fichiers lisibles.
 *
 * `ESTIMATION_ALLOW_NO_API=1` neutralise le garde-fou d'`astro.config.mjs` :
 * ce test parle de traceurs, pas de l'API d'estimation, et il doit passer sur
 * une machine sans `.env`.
 */
function construire(variables) {
  const sortie = mkdtempSync(path.join(os.tmpdir(), "emb-consent-"));

  execFileSync("npx", ["astro", "build", "--outDir", sortie], {
    cwd: RACINE,
    env: {
      ...process.env,
      ESTIMATION_ALLOW_NO_API: "1",
      PUBLIC_GTM_CONTAINER_ID: "",
      PUBLIC_GTM_SERVER_URL: "",
      ...variables,
    },
    stdio: "pipe",
  });

  const lire = (relatif) => readFileSync(path.join(sortie, relatif), "utf8");

  /** Concatène tous les fichiers d'un type — pour chercher dans les bundles. */
  const lireBundles = (extension) => {
    const dossier = path.join(sortie, "_astro");
    return readdirSync(dossier)
      .filter((nom) => nom.endsWith(extension))
      .map((nom) => readFileSync(path.join(dossier, nom), "utf8"))
      .join("\n");
  };

  return {
    accueil: lire("index.html"),
    politique: lire("politique-de-confidentialite/index.html"),
    js: lireBundles(".js"),
    nettoyer: () => rmSync(sortie, { recursive: true, force: true }),
  };
}

// Les deux constructions sont faites une seule fois pour tout le fichier :
// chacune coûte quelques secondes, et aucun test ne modifie leur résultat.
const SANS = construire({});
const AVEC = construire({ PUBLIC_GTM_CONTAINER_ID: CONTENEUR_FICTIF });

process.on("exit", () => {
  SANS.nettoyer();
  AVEC.nettoyer();
});

// ---------------------------------------------------------------------------
// 1. Aucun conteneur configuré : le site est muet
// ---------------------------------------------------------------------------

test("sans conteneur, aucun script Google n'atteint la page", () => {
  for (const marqueur of [
    "googletagmanager",
    "gtm.js",
    "gtag(",
    "ads_data_redaction",
    "dataLayer",
  ]) {
    assert.ok(
      !SANS.accueil.includes(marqueur),
      `« ${marqueur} » ne devrait pas figurer dans une page sans conteneur de tags`
    );
  }
});

test("sans conteneur, aucun bandeau n'est proposé ni téléchargé", () => {
  assert.ok(
    !SANS.accueil.includes("show-preferencesModal"),
    "le pied de page ne doit pas proposer de gérer des cookies inexistants"
  );
  assert.ok(
    !SANS.accueil.includes("cookieconsent"),
    "la feuille de style du bandeau ne doit pas être chargée"
  );
  // Le poids mort est le vrai risque ici : un import statique laisserait la
  // bibliothèque entière dans le bundle de chaque page (cf. l'en-tête de
  // `ConsentBanner.astro`). On vérifie que le fragment n'est pas demandé.
  const scripts = SANS.accueil.match(/<script[^>]*src="([^"]*)"/g) || [];
  assert.ok(
    !scripts.some((balise) => balise.includes("cookieconsent")),
    "la bibliothèque de consentement ne doit pas être téléchargée"
  );
});

test("sans conteneur, la politique de confidentialité dit la vérité", () => {
  assert.ok(
    SANS.politique.includes("aucun de ces traceurs n'est actif"),
    "la politique doit annoncer l'absence de traceur tant qu'aucun n'est configuré"
  );
});

// ---------------------------------------------------------------------------
// 2. Conteneur configuré : le socle Consent Mode v2
// ---------------------------------------------------------------------------

test("le conteneur déclaré est bien celui chargé", () => {
  assert.ok(AVEC.accueil.includes(CONTENEUR_FICTIF));
  assert.ok(AVEC.accueil.includes("gtm.js?id="));
});

test("tous les signaux de consentement valent « denied » par défaut", () => {
  const defaut = AVEC.accueil.slice(
    AVEC.accueil.indexOf("gtag('consent', 'default'"),
    AVEC.accueil.indexOf("ads_data_redaction")
  );

  // Les quatre signaux exigés par le Consent Mode v2, plus la
  // personnalisation. Un seul oublié, et le tag correspondant s'autorise le
  // stockage avant tout choix du visiteur.
  for (const signal of [
    "ad_storage",
    "ad_user_data",
    "ad_personalization",
    "analytics_storage",
    "personalization_storage",
  ]) {
    assert.match(
      defaut,
      new RegExp(`'${signal}':\\s*'denied'`),
      `${signal} doit valoir « denied » par défaut`
    );
  }
});

test("le défaut « denied » précède le chargement du conteneur", () => {
  const positionDefaut = AVEC.accueil.indexOf("gtag('consent', 'default'");
  const positionConteneur = AVEC.accueil.indexOf("gtm.js?id=");

  assert.ok(positionDefaut > -1 && positionConteneur > -1);
  assert.ok(
    positionDefaut < positionConteneur,
    "un défaut posé après le conteneur ne protège rien : c'est tout l'enjeu de l'ordre"
  );
});

test("l'attribution publicitaire sans cookie est activée", () => {
  // Les deux réglages qui rendent le dispositif utilisable pour la publicité
  // sans rien écrire chez le visiteur qui refuse.
  assert.ok(AVEC.accueil.includes("'ads_data_redaction', true"));
  assert.ok(AVEC.accueil.includes("'url_passthrough', true"));
});

test("aucune iframe GTM de repli n'est posée", () => {
  // Sans JavaScript le bandeau ne peut pas s'afficher : cette iframe serait le
  // seul traceur du site à partir sans possibilité de refus.
  assert.ok(
    !AVEC.accueil.includes("ns.html"),
    "le <noscript> de GTM déclencherait un traceur sans consentement possible"
  );
});

// ---------------------------------------------------------------------------
// 3. Le bandeau lui-même
// ---------------------------------------------------------------------------

test("aucune catégorie n'est précochée hors strictement nécessaires", () => {
  // `enabled: true` n'apparaît que sur `necessary`, qui est aussi le seul en
  // lecture seule. Une case précochée ne vaut pas consentement.
  const occurrences = AVEC.js.match(/enabled\s*:\s*!0|enabled\s*:\s*true/g) || [];
  assert.equal(
    occurrences.length,
    1,
    "une seule catégorie peut être active d'office : « strictement nécessaires »"
  );
  assert.match(AVEC.js, /readOnly\s*:\s*(!0|true)/);
});

test("refuser est présenté au même niveau qu'accepter", () => {
  assert.ok(AVEC.js.includes("Tout refuser"), "le refus doit être un bouton de premier niveau");
  assert.ok(AVEC.js.includes("Tout accepter"));
  // `equalWeightButtons` interdit à la bibliothèque de délaver le refus.
  const egalite = AVEC.js.match(/equalWeightButtons\s*:\s*(!0|true)/g) || [];
  assert.equal(egalite.length, 2, "exigé sur le bandeau ET sur le panneau de préférences");
});

test("le bandeau ne bloque pas la consultation du site", () => {
  // Disposition `inline` : ni voile assombri, ni piège au clavier — la CNIL
  // proscrit le cookie wall.
  //
  // Le délimiteur de chaîne est laissé libre : le minifieur réécrit les
  // guillemets en accents graves, et une assertion qui en dépendrait casserait
  // au prochain changement d'outil sans que rien de réel ait bougé.
  assert.ok(
    /layout\s*:\s*["'`]box inline["'`]/.test(AVEC.js),
    "le bandeau doit rester en disposition « inline » : pas de cookie wall"
  );
});

test("le retrait du consentement efface les traceurs déjà déposés", () => {
  // `autoClear` sur les familles réellement susceptibles d'être posées.
  for (const motif of ["_ga", "_gcl", "_gac", "_fbp", "_fbc"]) {
    assert.ok(
      AVEC.js.includes(motif),
      `${motif} doit figurer dans les cookies effacés au retrait du consentement`
    );
  }
});

test("le choix se modifie depuis le pied de page", () => {
  assert.ok(AVEC.accueil.includes('data-cc="show-preferencesModal"'));
  assert.ok(AVEC.accueil.includes("Gestion des cookies"));
});

test("un choix met à jour les signaux Google sans rechargement", () => {
  // `onConsent` ET `onChange` : le premier couvre le choix initial et le choix
  // mémorisé retrouvé au chargement, le second la modification a posteriori.
  assert.ok(AVEC.js.includes("onConsent"));
  assert.ok(AVEC.js.includes("onChange"));
  assert.ok(AVEC.js.includes("granted"), "le passage à « granted » doit être émis");
});

// ---------------------------------------------------------------------------
// 4. Cohérence entre le code et ce que la politique annonce
// ---------------------------------------------------------------------------

test("la durée annoncée au visiteur est celle réellement appliquée", async () => {
  const source = readFileSync(path.join(RACINE, "src", "lib", "analytics.ts"), "utf8");
  const jours = Number(source.match(/CONSENT_EXPIRE_JOURS\s*=\s*(\d+)/)[1]);

  assert.ok(jours > 0 && jours <= 395, "la CNIL plafonne à 13 mois (395 jours)");

  const mois = Math.round(jours / 30.44);
  assert.ok(
    AVEC.politique.includes(`${mois} mois`),
    `la politique doit annoncer ${mois} mois, la valeur effectivement appliquée`
  );
  assert.ok(
    AVEC.js.includes(String(jours)),
    "la durée compilée dans le bandeau doit être celle de lib/analytics.ts"
  );
});

test("avec un conteneur, la politique décrit les traceurs actifs", () => {
  assert.ok(
    !AVEC.politique.includes("aucun de ces traceurs n'est actif"),
    "la politique ne peut pas nier des traceurs qui sont chargés"
  );
  assert.ok(
    AVEC.politique.includes("emb_consentement"),
    "le cookie de consentement doit être nommé au visiteur"
  );
  assert.ok(AVEC.politique.includes("Refuser est aussi simple qu'accepter"));
});
