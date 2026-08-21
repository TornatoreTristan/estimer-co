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
    if (declencheur.type !== "CUSTOM_EVENT") continue;
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

test("aucun déclencheur d'un type que GTM refuse à l'import", () => {
  /*
   * Constaté en conditions réelles : GTM rejette le fichier ENTIER sur
   * « Error deserializing enum type [EventType]. Unrecognized value [init] ».
   * Les déclencheurs d'initialisation ne se créent que dans l'interface, ils
   * ne se transportent pas dans un export.
   *
   * Le coût d'un type invalide n'est pas une entité manquante mais un import
   * qui échoue en bloc, sans rien dire de plus. D'où cette liste blanche.
   */
  /*
     * MAJUSCULES. Les types de déclencheur de l'export ne sont PAS ceux de
     * l'API v2 : GTM a refusé successivement `init`, puis `pageview`, avec le
     * même « Error deserializing enum type [EventType] ». L'indice était sous
     * les yeux — les types de condition (`EQUALS`, `MATCH_REGEX`) sont
     * majuscules et viennent de la même famille d'énumérations.
     */
    const TYPES_IMPORTABLES = new Set(["PAGEVIEW", "CUSTOM_EVENT", "DOM_READY", "WINDOW_LOADED"]);

  for (const declencheur of VERSION.trigger) {
    assert.ok(
      TYPES_IMPORTABLES.has(declencheur.type),
      `${declencheur.name} : type « ${declencheur.type} » — GTM refusera le fichier entier`
    );
  }
});

test("les balises de configuration se déclenchent sur toutes les pages", () => {
  // Faute de déclencheur d'initialisation importable (voir ci-dessus), c'est
  // « Toutes les pages » qui porte la configuration. Montage classique,
  // antérieur aux déclencheurs d'initialisation : la différence tient à
  // quelques millisecondes, et le signal de consentement par défaut est de
  // toute façon posé par `Analytics.astro`, avant le conteneur lui-même.
  const toutesPages = VERSION.trigger.find((t) => t.type === "PAGEVIEW");
  assert.ok(toutesPages, "un déclencheur « toutes les pages » doit exister");

  for (const nom of ["GA4 — Configuration", "Ads — Configuration"]) {
    const balise = VERSION.tag.find((t) => t.name === nom);
    assert.deepEqual(balise.firingTriggerId, [toutesPages.triggerId], nom);
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
// 3bis. Durée des traceurs — le conteneur doit tenir la promesse de la page
// ===========================================================================

test("le cookie GA4 ne dure pas plus que ce que la politique annonce", () => {
  /*
   * GA4 pose `_ga` pour DEUX ANS par défaut. La politique de confidentialité
   * annonce « 13 mois maximum » pour les traceurs. Sans réglage explicite, le
   * site déposerait donc un traceur d'une durée que sa propre politique
   * interdit — un écart qui ne se voit ni dans l'interface de GTM, ni dans le
   * code du site, et que seul un contrôle révélerait.
   *
   * La durée attendue est RELUE dans la politique plutôt qu'écrite ici : le
   * jour où quelqu'un change l'une, ce test réclame l'autre.
   */
  const politique = readFileSync(
    path.join(RACINE, "src", "pages", "politique-de-confidentialite.astro"),
    "utf8"
  );
  const annonce = politique.match(/(\d+)\s*mois maximum pour les traceurs/);
  assert.ok(annonce, "la politique doit annoncer une durée maximale pour les traceurs");

  const plafondSecondes = Number(annonce[1]) * 30.4 * 24 * 60 * 60;

  const config = VERSION.tag.find((t) => t.name === "GA4 — Configuration");
  const table = config.parameter.find((p) => p.key === "configSettingsTable");
  assert.ok(table, "la balise de configuration GA4 doit régler la durée du cookie");

  const ligne = table.list.find(
    (l) => l.map.find((p) => p.key === "parameter").value === "cookie_expires"
  );
  assert.ok(ligne, "`cookie_expires` absent : GA4 retomberait sur ses deux ans par défaut");

  const duree = Number(ligne.map.find((p) => p.key === "parameterValue").value);
  assert.ok(duree > 0, "durée de cookie inexploitable");
  assert.ok(
    duree <= plafondSecondes,
    `le cookie dure ${Math.round(duree / 86400)} jours, la politique en promet ${annonce[1]} mois`
  );
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

test("les conversions améliorées ne sont activées que là où le site fournit des empreintes", () => {
  /*
   * Seules les deux conversions nées d'un formulaire disposent d'une adresse
   * e-mail et d'un téléphone (cf. `embUserData`). Les activer ailleurs
   * enverrait des champs vides et laisserait un diagnostic en erreur permanent
   * dans Google Ads — un voyant rouge qu'on finit par ne plus regarder, et
   * derrière lequel une vraie panne passerait inaperçue.
   */
  const AVEC_EMPREINTES = ["Ads — Conversion : estimation", "Ads — Conversion : contact"];

  for (const balise of VERSION.tag.filter((t) => t.type === "awct")) {
    const attendu = AVEC_EMPREINTES.includes(balise.name);
    const active = balise.parameter.find((p) => p.key === "enableEnhancedConversions");
    assert.equal(active.value, String(attendu), balise.name);

    const source = balise.parameter.find((p) => p.key === "userDataVariable");
    if (attendu) {
      assert.equal(
        source && source.value,
        "{{UD — Données fournies par l'utilisateur}}",
        `${balise.name} : conversions améliorées activées sans source de données`
      );
    } else {
      assert.equal(source, undefined, `${balise.name} : source de données sans objet`);
    }
  }
});

test("les empreintes de contact ne partent qu'aux conversions améliorées", () => {
  // Elles n'ont rien à faire ailleurs : ni dans GA4 (déjà vérifié plus haut),
  // ni dans une balise Meta, ni dans le remarketing.
  const source = VERSION.variable.find(
    (v) => v.name === "UD — Données fournies par l'utilisateur"
  );
  assert.ok(source, "la variable de données fournies par l'utilisateur doit exister");
  assert.equal(
    source.parameter.find((p) => p.key === "mode").value,
    "MANUAL",
    "le mode automatique ferait parcourir le DOM par Google, donc lire l'e-mail en clair"
  );

  const autorisees = new Set(["Ads — Conversion : estimation", "Ads — Conversion : contact"]);
  for (const balise of VERSION.tag) {
    if (autorisees.has(balise.name)) continue;
    const contenu = JSON.stringify(balise);
    assert.equal(
      contenu.includes("user_data.sha256") || contenu.includes("UD — Données"),
      false,
      `${balise.name} : aucune donnée de contact, même hachée, n'a à transiter ici`
    );
  }
});

test("chaque identifiant de compte a la forme de sa plateforme", () => {
  /*
   * On vérifie la FORME, pas la présence d'un gabarit : ces identifiants
   * figurent de toute façon en clair dans le HTML livré, les versionner ne
   * divulgue rien et évite de les ressaisir à chaque import.
   *
   * Ce que ce test attrape vraiment, c'est le mauvais identifiant au mauvais
   * endroit — et surtout le `AW-` collé dans l'identifiant de conversion, que
   * les balises `awct` et `sp` attendent en NOMBRE SEUL. Avec le préfixe, la
   * balise passe la validation de GTM et ne remonte jamais rien : panne
   * parfaitement silencieuse, et plusieurs jours de budget dépensés à l'aveugle
   * avant que quelqu'un s'en aperçoive.
   *
   * `0…` reste accepté : c'est un compte pas encore créé.
   */
  const formats = {
    "CONST — GA4 Measurement ID": /^(G-[A-Z0-9]{6,12}|0+)$/,
    "CONST — Google Ads Conversion ID": /^\d{9,12}$/,
    "CONST — Meta Pixel ID": /^\d{15,16}$/,
  };

  for (const [nom, motif] of Object.entries(formats)) {
    const variable = VERSION.variable.find((v) => v.name === nom);
    assert.ok(variable, `constante manquante : ${nom}`);

    const valeur = variable.parameter.find((p) => p.key === "value").value;
    assert.match(valeur, motif, `${nom} : « ${valeur} » n'a pas la forme attendue`);
  }

  const ads = VERSION.variable.find((v) => v.name === "CONST — Google Ads Conversion ID");
  assert.equal(
    ads.parameter.find((p) => p.key === "value").value.startsWith("AW-"),
    false,
    "l'identifiant de conversion se donne SANS le préfixe AW-, que la balise ajoute elle-même"
  );
});

test("le préfixe AW- est mis là où il faut, et nulle part ailleurs", () => {
  /*
   * Asymétrie déroutante mais réelle, et source de pannes silencieuses : la
   * balise Google (`googtag`) veut `AW-18402972391`, les balises de conversion
   * (`awct`) et de remarketing (`sp`) veulent `18402972391`. Une seule
   * constante porte la valeur, chacun la préfixe selon son besoin — et ce test
   * verrouille qui préfixe quoi.
   */
  const config = VERSION.tag.find((t) => t.name === "Ads — Configuration");
  assert.ok(config, "la balise Google de Google Ads doit exister");
  assert.equal(
    config.parameter.find((p) => p.key === "tagId").value,
    "AW-{{CONST — Google Ads Conversion ID}}"
  );

  for (const balise of VERSION.tag.filter((t) => t.type === "awct" || t.type === "sp")) {
    const id = balise.parameter.find((p) => p.key === "conversionId").value;
    assert.equal(
      id,
      "{{CONST — Google Ads Conversion ID}}",
      `${balise.name} : avec le préfixe, cette balise passe la validation de GTM et ne remonte jamais rien`
    );
  }
});

test("les balises de configuration ne comptent aucune conversion", () => {
  // `googtag` configure, `awct` mesure. Confondre les deux, c'est le double
  // comptage. Les deux balises de configuration se déclenchent à
  // l'initialisation et ne portent ni libellé, ni valeur, ni identifiant de
  // transaction.
  for (const nom of ["GA4 — Configuration", "Ads — Configuration"]) {
    const balise = VERSION.tag.find((t) => t.name === nom);
    assert.equal(balise.type, "googtag", nom);
    for (const interdit of ["conversionLabel", "conversionValue", "orderId"]) {
      assert.equal(
        balise.parameter.some((p) => p.key === interdit),
        false,
        `${nom} : « ${interdit} » n'a rien à faire sur une balise de configuration`
      );
    }
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

test("le mode opératoire annonce le bon inventaire", () => {
  // Ce compteur a déjà dérivé deux fois. Un README qui annonce 13 balises
  // quand le conteneur en porte 14 n'est pas une coquille : c'est la première
  // chose que lira celui qui vérifiera l'aperçu d'import, et un écart le
  // laissera croire que l'import a échoué.
  const readme = readFileSync(path.join(RACINE, "gtm", "README.md"), "utf8");
  const annonce = readme.match(
    /\((\d+) variables, (\d+) déclencheurs, (\d+) balises, (\d+) dossiers\)/
  );
  assert.ok(annonce, "gtm/README.md doit annoncer l'inventaire du conteneur");

  assert.deepEqual(
    annonce.slice(1, 5).map(Number),
    [
      VERSION.variable.length,
      VERSION.trigger.length,
      VERSION.tag.length,
      VERSION.folder.length,
    ],
    "inventaire annoncé dans gtm/README.md et contenu réel du conteneur désaccordés"
  );
});

// ===========================================================================
// 8. Libellés de conversion et balises en pause
// ===========================================================================

/** Nom de l'événement sur lequel une balise se déclenche. */
function evenementDeclencheur(balise) {
  const declencheur = VERSION.trigger.find((t) => t.triggerId === balise.firingTriggerId[0]);
  if (!declencheur || !declencheur.customEventFilter) return null;
  return declencheur.customEventFilter[0].parameter.find((p) => p.key === "arg1").value;
}

test("aucune conversion active ne porte un libellé gabarit", () => {
  /*
   * Une balise de conversion qui tire avec `LABEL_ESTIMATION` au lieu du vrai
   * libellé ne remonte rien, sans lever la moindre erreur. C'est la panne la
   * plus coûteuse du dispositif : les campagnes tournent, le budget part, et
   * la colonne « Conversions » reste à zéro sans qu'on sache pourquoi.
   *
   * Les balises EN PAUSE y échappent : leur libellé viendra le jour où
   * l'action correspondante sera créée côté Ads.
   */
  const enGabarit = VERSION.tag
    .filter((t) => t.type === "awct" && !t.paused)
    .filter((t) => /^LABEL_/.test(t.parameter.find((p) => p.key === "conversionLabel").value))
    .map((t) => t.name);

  assert.deepEqual(
    enGabarit,
    [],
    "ces conversions sont actives mais leur libellé n'a jamais été renseigné"
  );
});

test("deux conversions sur un même événement ont deux libellés distincts", () => {
  /*
   * « Contact - message » et « Contact - partenariat » sont deux actions Ads
   * différentes déclenchées par le MÊME événement `contact_lead`, séparées par
   * le sujet du message. C'est ce cas qui a fait retirer la table de
   * correspondance indexée par événement : elle leur aurait servi le même
   * libellé, donc compté les candidatures de partenaires comme des demandes de
   * contact.
   */
  const parEvenement = new Map();

  for (const balise of VERSION.tag.filter((t) => t.type === "awct")) {
    const evenement = evenementDeclencheur(balise);
    const libelle = balise.parameter.find((p) => p.key === "conversionLabel").value;
    if (!parEvenement.has(evenement)) parEvenement.set(evenement, new Set());
    parEvenement.get(evenement).add(libelle);
  }

  for (const [evenement, libelles] of parEvenement) {
    const balises = VERSION.tag.filter(
      (t) => t.type === "awct" && evenementDeclencheur(t) === evenement
    );
    assert.equal(
      libelles.size,
      balises.length,
      `${evenement} : ${balises.length} conversions pour ${libelles.size} libellé(s) — deux actions Ads ne peuvent pas partager un libellé`
    );
  }
});

test("toute balise en pause l'est pour une raison lisible", () => {
  /*
   * Deux raisons légitimes, et deux seulement :
   *
   *   - la conversion a été REPORTÉE (l'action n'existe pas encore côté Ads) ;
   *   - son libellé n'est pas encore renseigné, donc elle ne peut rien remonter.
   *
   * Une balise en pause pour aucune de ces raisons est une balise qu'on a
   * oublié de réveiller — et une mesure qu'on croit avoir alors qu'elle
   * n'existe pas.
   */
  const REPORTEES = ["Ads — Conversion : PDF", "Ads — Conversion : micro étape 3"];

  for (const balise of VERSION.tag.filter((t) => t.paused)) {
    const libelle = balise.parameter.find((p) => p.key === "conversionLabel");
    const sansLibelle = libelle && /^LABEL_/.test(libelle.value);
    assert.ok(
      REPORTEES.includes(balise.name) || sansLibelle,
      `${balise.name} : en pause sans raison — reportée ? libellé manquant ?`
    );
  }

  // Et l'inverse : une conversion reportée ne doit pas être active.
  for (const nom of REPORTEES) {
    const balise = VERSION.tag.find((t) => t.name === nom);
    assert.ok(balise, `balise manquante : ${nom}`);
    assert.equal(balise.paused, true, `${nom} : reportée mais active`);
  }
});

test("la table de correspondance par événement a bien disparu", () => {
  // Elle reposait sur « un événement = une action de conversion », hypothèse
  // fausse depuis la création de deux actions sur `contact_lead`. La
  // réintroduire ramènerait le défaut.
  assert.equal(
    VERSION.variable.some((v) => v.type === "smm"),
    false,
    "aucune table de correspondance ne doit indexer les libellés par événement"
  );
});

test("un libellé actif a la forme d'un vrai libellé Google Ads", () => {
  /*
   * Complément du test précédent : « pas un gabarit » ne suffit pas. Un
   * libellé tronqué à la copie, ou saisi avec un caractère de trop, produit
   * exactement la même panne silencieuse — la balise tire, Google ne
   * reconnaît rien, la colonne « Conversions » reste à zéro.
   *
   * Les libellés Ads sont des chaînes base64-URL d'une vingtaine de
   * caractères. Ce contrôle n'attrape pas une confusion `l`/`I` — seul un
   * test en conditions réelles (mode Aperçu, puis diagnostic Ads sous 48 h)
   * la révélera.
   */
  for (const balise of VERSION.tag.filter((t) => t.type === "awct" && !t.paused)) {
    const libelle = balise.parameter.find((p) => p.key === "conversionLabel").value;
    assert.match(
      libelle,
      /^[A-Za-z0-9_-]{10,40}$/,
      `${balise.name} : « ${libelle} » n'a pas la forme d'un libellé de conversion`
    );
  }
});

test("les trois conversions issues d'un formulaire sont actives", () => {
  // Ce sont elles qui portent la mesure : si l'une repassait en pause sans
  // qu'on l'ait voulu, les campagnes tourneraient sans rien remonter.
  for (const nom of [
    "Ads — Conversion : estimation",
    "Ads — Conversion : contact",
    "Ads — Conversion : partenariat",
  ]) {
    const balise = VERSION.tag.find((t) => t.name === nom);
    assert.ok(balise, `balise manquante : ${nom}`);
    assert.notEqual(balise.paused, true, `${nom} : en pause alors qu'elle doit mesurer`);
  }
});
