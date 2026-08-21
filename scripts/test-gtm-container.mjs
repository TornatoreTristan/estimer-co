#!/usr/bin/env node
/**
 * Vérification du conteneur Google Tag Manager généré (lot T2 de
 * `specs/plan-taggage-conversions.md`).
 *
 * ---------------------------------------------------------------------------
 * CE QU'UN TEST PEUT ET NE PEUT PAS FAIRE ICI
 * ---------------------------------------------------------------------------
 * Il ne peut PAS valider que Google acceptera l'import : le schéma exact de
 * l'export GTM n'est pas publié sous forme vérifiable, et seule l'interface
 * fait autorité. `gtm/README.md` impose donc un import en espace de travail
 * neuf, suivi du mode Aperçu, avant toute publication.
 *
 * Il peut en revanche verrouiller tout ce qui est vérifiable sans Google, et
 * c'est là que vivent les vraies erreurs d'un conteneur :
 *
 *   1. **La dérive entre le code et le conteneur.** Le test relit les
 *      événements réellement poussés par `src/scripts/` et vérifie que le
 *      déclencheur GA4 les attrape TOUS. Ajouter un événement au site sans
 *      l'ajouter au conteneur, c'est une mesure qui n'existe pas et que
 *      personne ne voit manquer — le défaut que tout ce plan cherche à
 *      empêcher.
 *
 *   2. **Les références pendantes.** Une balise qui pointe un déclencheur
 *      supprimé, un `{{Nom de variable}}` mal orthographié : GTM ne s'en plaint
 *      pas toujours à l'import, et la balise ne tire simplement jamais.
 *
 *   3. **Le consentement des balises tierces.** Le Consent Mode est un
 *      mécanisme Google ; une balise HTML personnalisée s'exécute sans lui
 *      demander son avis. Ce test échoue si l'une d'elles n'exige pas les trois
 *      signaux publicitaires — c'est-à-dire s'il devient possible de charger le
 *      pixel Meta chez un visiteur qui a refusé.
 *
 *   4. **La dérive du fichier committé.** C'est le générateur qui fait foi ;
 *      le JSON n'est committé que parce que c'est lui qu'on importe.
 *
 * Usage : `node --test scripts/test-gtm-container.mjs` (ou `npm run test:gtm`).
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { JSON_CONTENEUR, SORTIE } from "./build-gtm-container.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.join(__dirname, "..");

const BRUT = readFileSync(SORTIE, "utf8");
const VERSION = JSON.parse(BRUT).containerVersion;

const nomsVariables = new Set([
  ...VERSION.variable.map((v) => v.name),
  ...VERSION.builtInVariable.map((v) => v.name),
  // Variable interne de GTM, utilisable dans les filtres de déclencheur.
  "_event",
]);

/** Toutes les valeurs de paramètre du conteneur, à plat. */
function valeursDeParametres(noeud, sortie = []) {
  if (Array.isArray(noeud)) {
    noeud.forEach((element) => valeursDeParametres(element, sortie));
  } else if (noeud && typeof noeud === "object") {
    if (typeof noeud.value === "string") sortie.push(noeud.value);
    Object.values(noeud).forEach((valeur) => valeursDeParametres(valeur, sortie));
  }
  return sortie;
}

// ===========================================================================
// 1. Dérive entre le code et le conteneur
// ===========================================================================

/**
 * Événements réellement poussés par le site.
 *
 * Relus dans les sources plutôt que recopiés ici : une liste tenue à la main
 * finirait par décrire un site qui n'existe plus, ce qui est exactement le
 * défaut contre lequel ce test protège.
 */
function evenementsDuSite() {
  const trouves = new Set();

  const dossierScripts = path.join(RACINE, "src", "scripts");
  const fichiers = readdirSync(dossierScripts)
    .filter((nom) => nom.endsWith(".js"))
    .map((nom) => path.join(dossierScripts, nom));
  fichiers.push(path.join(RACINE, "src", "components", "ConsentBanner.astro"));

  for (const fichier of fichiers) {
    const source = readFileSync(fichier, "utf8");

    // `embTrack("nom_evenement", …)` et son relais local `mesurer("…", …)`.
    for (const [, nom] of source.matchAll(/\b(?:embTrack|mesurer)\(\s*"([a-z0-9_]+)"/g)) {
      trouves.add(nom);
    }
    // Poussée directe dans le dataLayer (bandeau de consentement).
    for (const [, nom] of source.matchAll(/\bevent:\s*['"]([a-z0-9_]+)['"]/g)) {
      trouves.add(nom);
    }
  }

  return [...trouves].sort();
}

/** Expression régulière du déclencheur qui alimente la balise d'événement GA4. */
function regexDeclencheurGa4() {
  const declencheur = VERSION.trigger.find((t) => t.name === "CE — Tous événements métier");
  assert.ok(declencheur, "le déclencheur GA4 générique doit exister");
  const filtre = declencheur.customEventFilter[0];
  assert.equal(filtre.type, "MATCH_REGEX");
  return new RegExp(filtre.parameter.find((p) => p.key === "arg1").value);
}

test("le déclencheur GA4 attrape tous les événements poussés par le site", () => {
  const evenements = evenementsDuSite();
  const regex = regexDeclencheurGa4();

  // Le harnais doit être crédible : s'il ne trouvait aucun événement, le test
  // passerait à vide.
  assert.ok(evenements.length >= 15, `seulement ${evenements.length} événements relevés`);
  assert.ok(evenements.includes("generate_lead"));
  assert.ok(evenements.includes("consent_update"));

  const manquants = evenements.filter((nom) => !regex.test(nom));
  assert.deepEqual(
    manquants,
    [],
    "ces événements sont poussés par le site mais aucune balise GA4 ne les recevra"
  );
});

test("le déclencheur GA4 ignore les événements internes de Google Tag Manager", () => {
  const regex = regexDeclencheurGa4();
  for (const interne of ["gtm.js", "gtm.dom", "gtm.load", "gtm.click", "gtm.scrollDepth"]) {
    assert.equal(regex.test(interne), false, `« ${interne} » ne doit pas remonter à GA4`);
  }
});

test("chaque conversion a bien son déclencheur dédié", () => {
  // Les balises Ads et Meta ne passent PAS par le déclencheur générique : une
  // conversion doit tirer sur un événement exact, jamais sur une famille.
  const attendus = [
    "CE — generate_lead",
    "CE — contact_lead (hors partenariat)",
    "CE — contact_lead (partenariat)",
    "CE — report_pdf_download",
    "CE — report_view",
    "CE — micro : étape 3 atteinte",
  ];
  const noms = VERSION.trigger.map((t) => t.name);
  for (const attendu of attendus) {
    assert.ok(noms.includes(attendu), `déclencheur manquant : ${attendu}`);
  }

  for (const declencheur of VERSION.trigger) {
    if (declencheur.type !== "customEvent") continue;
    if (declencheur.name === "CE — Tous événements métier") continue;
    assert.equal(
      declencheur.customEventFilter[0].type,
      "EQUALS",
      `${declencheur.name} : une conversion se déclenche sur un événement exact`
    );
  }
});

// ===========================================================================
// 2. Références pendantes
// ===========================================================================

test("toute référence {{…}} pointe une variable qui existe", () => {
  const inconnues = new Set();

  for (const valeur of valeursDeParametres(VERSION)) {
    for (const [, nom] of valeur.matchAll(/\{\{([^}]+)\}\}/g)) {
      if (!nomsVariables.has(nom)) inconnues.add(nom);
    }
  }

  assert.deepEqual([...inconnues], [], "variables référencées mais jamais définies");
});

test("toute balise pointe des déclencheurs et des dossiers qui existent", () => {
  const idsDeclencheurs = new Set(VERSION.trigger.map((t) => t.triggerId));
  const idsDossiers = new Set(VERSION.folder.map((f) => f.folderId));
  const nomsBalises = new Set(VERSION.tag.map((t) => t.name));

  for (const balise of VERSION.tag) {
    assert.ok(
      balise.firingTriggerId.length > 0,
      `${balise.name} : une balise sans déclencheur ne tire jamais`
    );
    for (const id of balise.firingTriggerId) {
      assert.ok(idsDeclencheurs.has(id), `${balise.name} : déclencheur ${id} introuvable`);
    }
    if (balise.parentFolderId) {
      assert.ok(idsDossiers.has(balise.parentFolderId), `${balise.name} : dossier introuvable`);
    }
    for (const setup of balise.setupTag || []) {
      assert.ok(
        nomsBalises.has(setup.tagName),
        `${balise.name} : balise de configuration « ${setup.tagName} » introuvable`
      );
    }
  }

  for (const variable of VERSION.variable) {
    if (variable.parentFolderId) {
      assert.ok(idsDossiers.has(variable.parentFolderId), `${variable.name} : dossier introuvable`);
    }
  }
});

test("aucun identifiant ni nom en double", () => {
  const collections = [
    ["variable", VERSION.variable, "variableId"],
    ["trigger", VERSION.trigger, "triggerId"],
    ["tag", VERSION.tag, "tagId"],
    ["folder", VERSION.folder, "folderId"],
  ];

  for (const [libelle, entites, cle] of collections) {
    const ids = entites.map((e) => e[cle]);
    const noms = entites.map((e) => e.name);
    assert.equal(new Set(ids).size, ids.length, `${libelle} : identifiants en double`);
    assert.equal(new Set(noms).size, noms.length, `${libelle} : noms en double`);
  }
});

test("chaque variable de couche de données lit bien la version 2", () => {
  const dlv = VERSION.variable.filter((v) => v.type === "v");
  assert.ok(dlv.length >= 40, `seulement ${dlv.length} variables de couche de données`);

  for (const variable of dlv) {
    const version = variable.parameter.find((p) => p.key === "dataLayerVersion");
    assert.equal(version.value, "2", `${variable.name} : la version 1 ne lit pas les clés pointées`);

    const defaut = variable.parameter.find((p) => p.key === "setDefaultValue");
    assert.equal(
      defaut.value,
      "false",
      `${variable.name} : une valeur par défaut remplit les rapports de « (not set) »`
    );
  }
});

test("les paramètres GA4 pointent tous une variable de couche de données", () => {
  const settings = VERSION.variable.find((v) => v.name === "SETTINGS — Params communs");
  const table = settings.parameter.find((p) => p.key === "eventSettingsTable").list;

  assert.ok(table.length >= 40, `seulement ${table.length} paramètres transmis à GA4`);

  for (const ligne of table) {
    const nom = ligne.map.find((p) => p.key === "parameter").value;
    const valeur = ligne.map.find((p) => p.key === "parameterValue").value;
    assert.equal(valeur, `{{DLV — ${nom}}}`, `${nom} : paramètre et variable désaccordés`);
  }

  // Les coordonnées hachées vont aux conversions améliorées de Google Ads,
  // pas dans les rapports GA4.
  const nomsTransmis = table.map((l) => l.map.find((p) => p.key === "parameter").value);
  assert.ok(
    nomsTransmis.every((nom) => !nom.startsWith("user_data.")),
    "aucune donnée de contact, même hachée, ne doit partir dans GA4"
  );
});

// ===========================================================================
// 3. Consentement
// ===========================================================================

test("toute balise tierce exige les trois signaux publicitaires", () => {
  const tierces = VERSION.tag.filter((t) => t.type === "html");
  assert.ok(tierces.length >= 4, "les balises Meta doivent être présentes");

  for (const balise of tierces) {
    const reglage = balise.consentSettings;
    assert.equal(
      reglage.consentStatus,
      "NEEDED",
      `${balise.name} : sans consentement déclaré, cette balise se charge chez qui a refusé`
    );
    const signaux = reglage.consentType.list.map((c) => c.value).sort();
    assert.deepEqual(signaux, ["ad_personalization", "ad_storage", "ad_user_data"]);
  }
});

test("aucune balise tierce ne se charge à l'initialisation", () => {
  // Les déclencheurs d'initialisation tirent AVANT que le bandeau ait pu
  // remonter un choix mémorisé. Une balise Google y survit (le Consent Mode
  // la met en attente) ; une balise HTML, non.
  const idsInit = new Set(
    VERSION.trigger.filter((t) => t.type === "init").map((t) => t.triggerId)
  );

  for (const balise of VERSION.tag.filter((t) => t.type === "html")) {
    for (const id of balise.firingTriggerId) {
      assert.equal(idsInit.has(id), false, `${balise.name} : déclenchement trop précoce`);
    }
  }
});

test("le pixel Meta ne pose pas d'iframe de repli", () => {
  // Même raison que l'absence de `<noscript>` dans `Analytics.astro` : sans
  // JavaScript, le bandeau ne peut pas s'afficher, donc aucun refus n'est
  // possible — ce serait le seul traceur du site à partir sans consentement.
  for (const balise of VERSION.tag.filter((t) => t.type === "html")) {
    const html = balise.parameter.find((p) => p.key === "html").value;
    assert.equal(/<noscript/i.test(html), false, `${balise.name} : iframe de repli interdite`);
  }
});

// ===========================================================================
// 4. Conversions Google Ads
// ===========================================================================

test("chaque conversion Ads porte le lead_id comme clé de déduplication", () => {
  const conversions = VERSION.tag.filter((t) => t.type === "awct");
  assert.equal(conversions.length, 5);

  for (const balise of conversions) {
    const orderId = balise.parameter.find((p) => p.key === "orderId");
    assert.equal(
      orderId.value,
      "{{DLV — lead_id}}",
      `${balise.name} : sans transaction_id, un rechargement facture une conversion de plus`
    );
    assert.equal(balise.parameter.find((p) => p.key === "currencyCode").value, "EUR");
  }
});

test("les conversions améliorées restent désactivées tant que rien ne les alimente", () => {
  // Lot T3. Les activer maintenant enverrait des champs vides et laisserait un
  // diagnostic en erreur permanent dans Google Ads — un voyant rouge qu'on
  // finit par ne plus regarder.
  for (const balise of VERSION.tag.filter((t) => t.type === "awct")) {
    const ameliorees = balise.parameter.find((p) => p.key === "enableEnhancedConversions");
    assert.equal(ameliorees.value, "false", `${balise.name}`);
  }
});

test("les identifiants de compte sont des gabarits, pas des valeurs réelles", () => {
  // Un identifiant réel committé par mégarde enverrait les conversions d'une
  // recette dans un compte de production. Les gabarits sont invalides à
  // dessein : une balise mal configurée ne remonte rien, ce qui se voit.
  const gabarits = {
    "CONST — GA4 Measurement ID": /^G-X+$/,
    "CONST — Google Ads Conversion ID": /^0+$/,
    "CONST — Meta Pixel ID": /^0+$/,
  };

  for (const [nom, motif] of Object.entries(gabarits)) {
    const variable = VERSION.variable.find((v) => v.name === nom);
    assert.ok(variable, `constante manquante : ${nom}`);
    const valeur = variable.parameter.find((p) => p.key === "value").value;
    assert.match(valeur, motif, `${nom} : identifiant réel committé ?`);
  }
});

// ===========================================================================
// 5. Dérive du fichier committé
// ===========================================================================

test("le JSON committé est bien celui que produit le générateur", () => {
  assert.equal(
    BRUT,
    JSON_CONTENEUR,
    "gtm/container-estimer-co.json a divergé : relancer `npm run gtm:build`"
  );
});

test("le conteneur cible est bien celui du site", () => {
  assert.equal(VERSION.container.publicId, "GTM-5TB8F4CS");
  assert.deepEqual(VERSION.container.usageContext, ["WEB"]);
  // Un horodatage rendrait le fichier différent à chaque génération, donc
  // impossible à comparer d'un commit à l'autre.
  assert.equal(JSON.parse(BRUT).exportTime, "");
});
