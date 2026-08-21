#!/usr/bin/env node
/**
 * Vérification de `src/scripts/tracking.js` — socle de mesure (lot T0 de
 * `specs/plan-taggage-conversions.md`).
 *
 * Même technique que les autres vérifications du front : le fichier est
 * exécuté tel qu'il sera injecté en production (script classique, aucun
 * import/export) via `vm.Script#runInThisContext()`, qui attache ses fonctions
 * à `globalThis`, sur un bouchon de `document` / `window` posé avant chaque
 * exécution.
 *
 * ---------------------------------------------------------------------------
 * CE QUI EST VERROUILLÉ ICI
 * ---------------------------------------------------------------------------
 * 1. **Aucune donnée personnelle ne peut atteindre le dataLayer.** C'est le
 *    test le plus important du fichier, et le seul qui protège d'une faute
 *    plutôt que d'un bug : le dataLayer est lisible par n'importe quelle
 *    extension installée chez le visiteur, un e-mail qui y transite est une
 *    divulgation. Le jour où quelqu'un ajoutera `email: data.email` à un
 *    événement — parce que « ce serait pratique pour recouper » — ce test doit
 *    échouer bruyamment, en CI, avant la revue.
 *
 * 2. **La mesure ne prend jamais le pas sur le parcours.** Aucun clic tracké
 *    n'appelle `preventDefault()` : un lien partenaire s'ouvre exactement comme
 *    si ce fichier n'existait pas. Et `embTrack` ne lève jamais, quoi qu'on lui
 *    passe.
 *
 * 3. **Les dérivations sont stables.** `embDepartement` et `embSurfaceBucket`
 *    alimentent des dimensions GA4 : leur sortie devient un historique. Une
 *    correction de frontière un an plus tard couperait les rapports en deux,
 *    d'où des bornes verrouillées ici une bonne fois.
 *
 * Non couvert : le rendu des attributs `data-*` dans les pages `.astro` — c'est
 * du gabarit, et `scripts/test-consent-banner.mjs` montre le prix d'un test qui
 * construit le site pour vérifier une chaîne.
 *
 * Usage : `node --test scripts/test-tracking.mjs` (ou `npm run test:tracking`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "tracking.js");

const SOURCE = readFileSync(SCRIPT_PATH, "utf8");
const SCRIPT = new vm.Script(SOURCE, { filename: "tracking.js" });

// ---------------------------------------------------------------------------
// Bouchons
// ---------------------------------------------------------------------------

/** Élément minimal : attributs, texte, chaînage vers le parent. */
function creerElement(attributs, options) {
  const opts = options || {};
  return {
    attributs: attributs || {},
    textContent: opts.texte || "",
    parentNode: opts.parent || null,
    getAttribute(cle) {
      return Object.prototype.hasOwnProperty.call(this.attributs, cle)
        ? this.attributs[cle]
        : null;
    },
  };
}

/**
 * Monte le bouchon, exécute `tracking.js`, passe le pilotage à `scenario`,
 * puis restaure le realm.
 *
 * @param {{
 *   chemin?: string,
 *   pushLeve?: boolean,
 *   sansWindow?: boolean,
 *   crypto?: object,   // défaut : un bouchon SANS `subtle`, soit une page en HTTP
 * }} options
 */
function withTracking(options, scenario) {
  const opts = options || {};
  const pousses = [];
  const avertissements = [];

  const dataLayer = [];
  dataLayer.push = function (charge) {
    if (opts.pushLeve) throw new Error("dataLayer indisponible");
    pousses.push(charge);
    return Array.prototype.push.call(this, charge);
  };

  const ecouteurs = {};

  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    warn: console.warn,
  };

  globalThis.document = {
    addEventListener(type, handler, options) {
      (ecouteurs[type] = ecouteurs[type] || []).push({ handler, options });
    },
  };

  globalThis.window = {
    dataLayer,
    location: { pathname: opts.chemin || "/" },
    /*
     * Par défaut, un bouchon SANS `subtle` : c'est l'état d'une page servie en
     * HTTP, où la Web Crypto n'existe pas. Le socle doit y fonctionner en
     * renonçant aux empreintes, pas en levant. Les tests qui exercent
     * réellement le hachage passent la vraie implémentation de Node.
     */
    crypto: opts.crypto || {
      // Déterministe : ce test vérifie la FORME de l'identifiant et son
      // unicité d'appel en appel, pas la qualité de l'aléa de la plateforme.
      getRandomValues(tableau) {
        for (let i = 0; i < tableau.length; i++) tableau[i] = (i * 17 + 3) % 256;
        return tableau;
      },
    },
  };

  console.warn = (...args) => avertissements.push(args.join(" "));

  const restaurer = () => {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    console.warn = saved.warn;
  };

  try {
    SCRIPT.runInThisContext();

    if (opts.sansWindow) delete globalThis.window;

    const resultat = scenario({
      pousses,
      avertissements,
      /** Rejoue un clic sur `element` à travers la délégation posée sur `document`. */
      cliquer(element) {
        const evenement = { target: element, defautEmpeche: false };
        evenement.preventDefault = () => {
          evenement.defautEmpeche = true;
        };
        (ecouteurs.click || []).forEach(({ handler }) => handler(evenement));
        return evenement;
      },
      /** Options d'inscription de l'écouteur délégué (capture / passive). */
      optionsEcouteur() {
        return (ecouteurs.click || [])[0] && (ecouteurs.click || [])[0].options;
      },
    });

    /*
     * Scénario asynchrone : sans cette branche, le `finally` restaurerait le
     * realm dès que `scenario()` a rendu SA PROMESSE, c'est-à-dire avant que
     * son corps ait fini de s'exécuter. Le test s'exécuterait alors sur le
     * `window` du realm voisin, et échouerait pour une raison qui n'apprend
     * rien sur le code mesuré.
     */
    if (resultat && typeof resultat.then === "function") {
      return resultat.then(
        (valeur) => {
          restaurer();
          return valeur;
        },
        (erreur) => {
          restaurer();
          throw erreur;
        }
      );
    }

    restaurer();
    return resultat;
  } catch (erreur) {
    restaurer();
    throw erreur;
  }
}

// ===========================================================================
// 1. embTrack — le contrat public
// ===========================================================================

test("embTrack pousse l'événement et ses paramètres", () => {
  withTracking({}, ({ pousses }) => {
    assert.equal(embTrack("generate_lead", { lead_type: "estimation", value: 300 }), true);
    assert.deepEqual(pousses, [
      { event: "generate_lead", lead_type: "estimation", value: 300 },
    ]);
  });
});

test("embTrack écarte les valeurs vides plutôt que de les pousser", () => {
  withTracking({}, ({ pousses }) => {
    embTrack("estimation_submit", {
      property_type: "maison",
      rooms: "",
      dpe: null,
      floor: undefined,
      confidence_score: Number.NaN,
      comparables_count: Infinity,
      // Un zéro est une valeur, pas une absence : il doit passer.
      position: 0,
    });

    assert.deepEqual(pousses[0], {
      event: "estimation_submit",
      property_type: "maison",
      position: 0,
    });
  });
});

test("embTrack refuse un nom d'événement inexploitable", () => {
  withTracking({}, ({ pousses }) => {
    assert.equal(embTrack(""), false);
    assert.equal(embTrack(null), false);
    assert.equal(embTrack(42), false);
    assert.equal(pousses.length, 0);
  });
});

test("embTrack ne lève jamais, même si le dataLayer est cassé", () => {
  withTracking({ pushLeve: true }, () => {
    assert.doesNotThrow(() => {
      assert.equal(embTrack("generate_lead", { value: 1 }), false);
    });
  });
});

test("embTrack ne lève pas en l'absence de window", () => {
  withTracking({ sansWindow: true }, () => {
    assert.doesNotThrow(() => {
      assert.equal(embTrack("generate_lead"), false);
    });
  });
});

// ===========================================================================
// 2. Garde-fou anti-donnée personnelle — cf. l'en-tête, point 1
// ===========================================================================

test("aucune donnée personnelle ne peut atteindre le dataLayer", () => {
  withTracking({}, ({ pousses, avertissements }) => {
    embTrack("generate_lead", {
      address: "12 rue de la Paix",
      adresse: "12 rue de la Paix",
      name: "Jean Dupont",
      nom: "Dupont",
      prenom: "Jean",
      firstname: "Jean",
      lastname: "Dupont",
      email: "jean@example.com",
      Mail: "jean@example.com",
      courriel: "jean@example.com",
      phone: "0612345678",
      TEL: "0612345678",
      telephone: "0612345678",
      message: "Rappelez-moi",
      lead_id: "abc-123",
    });

    assert.deepEqual(
      pousses[0],
      { event: "generate_lead", lead_id: "abc-123" },
      "seuls les paramètres non identifiants doivent survivre"
    );
    assert.equal(
      avertissements.length,
      14,
      "chaque champ écarté doit être signalé en console : c'est une erreur à corriger"
    );
  });
});

test("le filtre porte sur la clé exacte, pas sur une sous-chaîne", () => {
  withTracking({}, ({ pousses }) => {
    embTrack("partner_click_out", {
      partner_name: "Century 21",
      cta_label: "Nous contacter",
      // Contre-exemple volontaire : `page_path` contient « path », pas « tel ».
      page_path: "/partenaires",
    });

    assert.deepEqual(pousses[0], {
      event: "partner_click_out",
      partner_name: "Century 21",
      cta_label: "Nous contacter",
      page_path: "/partenaires",
    });
  });
});

// ===========================================================================
// 3. Dérivations — bornes verrouillées
// ===========================================================================

test("embSurfaceBucket range les surfaces dans des tranches triables", () => {
  withTracking({}, () => {
    const attendu = [
      [1, "000-029"],
      [29, "000-029"],
      [30, "030-059"],
      [59, "030-059"],
      [60, "060-089"],
      [89, "060-089"],
      [90, "090-119"],
      [119, "090-119"],
      [120, "120-199"],
      [199, "120-199"],
      [200, "200+"],
      [1200, "200+"],
    ];
    for (const [surface, libelle] of attendu) {
      assert.equal(embSurfaceBucket(surface), libelle, `surface ${surface}`);
      assert.equal(embSurfaceBucket(String(surface)), libelle, `surface "${surface}"`);
    }

    // Le wizard rend des chaînes, virgule décimale comprise.
    assert.equal(embSurfaceBucket("45,5"), "030-059");

    for (const invalide of ["", null, undefined, 0, -10, "abc"]) {
      assert.equal(embSurfaceBucket(invalide), "", `entrée invalide : ${invalide}`);
    }
  });
});

test("embSurfaceBucket produit des libellés qui se trient correctement", () => {
  withTracking({}, () => {
    // Le zéro-préfixage n'est pas cosmétique : GA4 trie les valeurs de
    // dimension par ordre alphabétique. Sans lui, « 120-199 » se placerait
    // avant « 30-59 » dans tous les rapports.
    const libelles = [200, 30, 120, 90, 10, 60].map(embSurfaceBucket);
    assert.deepEqual(
      libelles.slice().sort(),
      ["000-029", "030-059", "060-089", "090-119", "120-199", "200+"]
    );
  });
});

test("embDepartement traite la Corse, l'outre-mer et le cas général", () => {
  withTracking({}, () => {
    const attendu = [
      ["75011", "75"],
      ["01000", "01"],
      [69001, "69"],
      ["14000", "14"],
      // Corse : 20000-20199 en Corse-du-Sud, au-delà en Haute-Corse.
      ["20000", "2A"],
      ["20137", "2A"],
      ["20190", "2A"],
      ["20200", "2B"],
      ["20220", "2B"],
      ["20250", "2B"],
      ["20600", "2B"],
      // Outre-mer et collectivités : trois chiffres, comme le `codeInsee` des
      // collections de contenu.
      ["97400", "974"],
      ["97100", "971"],
      ["98800", "988"],
    ];
    for (const [codePostal, departement] of attendu) {
      assert.equal(embDepartement(codePostal), departement, `CP ${codePostal}`);
    }

    for (const invalide of ["", "1234", "123456", "abcde", "7501a", null, undefined]) {
      assert.equal(embDepartement(invalide), "", `entrée invalide : ${invalide}`);
    }
  });
});

test("embLeadQuality sépare le vendeur du curieux", () => {
  withTracking({}, () => {
    assert.equal(embLeadQuality("yes", "yes"), "hot");
    assert.equal(embLeadQuality("yes", "maybe"), "warm");
    assert.equal(embLeadQuality("yes", "no"), "cold");
    assert.equal(embLeadQuality("no", "yes"), "cold", "un non-propriétaire n'est jamais chaud");
    assert.equal(embLeadQuality("no", "maybe"), "cold");
    assert.equal(embLeadQuality("", ""), "cold");
    assert.equal(embLeadQuality(undefined, undefined), "cold");
  });
});

test("embLeadValue hiérarchise les leads selon l'intention déclarée", () => {
  withTracking({}, () => {
    // Bien de référence (250 000 €) : le coefficient de prix vaut 1, ne
    // restent que les coefficients de qualification.
    assert.equal(embLeadValue("yes", "yes", 250000), 300);
    assert.equal(embLeadValue("yes", "maybe", 250000), 150);
    assert.equal(embLeadValue("yes", "no", 250000), 50);
    // Un non-propriétaire ne vaut pas un propriétaire indécis, alors que
    // `embLeadQuality` les range tous deux en « cold ».
    assert.equal(embLeadValue("no", "yes", 250000), 20);
    assert.equal(embLeadValue("no", "no", 250000), 20);
  });
});

test("embLeadValue suit le prix du bien, sans se laisser emporter", () => {
  withTracking({}, () => {
    assert.equal(embLeadValue("yes", "yes", 125000), 150, "moitié prix, moitié valeur");
    assert.equal(embLeadValue("yes", "yes", 500000), 600);
    // Plafond à 2,5 : sans lui, un bien à 3 M€ pèserait autant que trente
    // leads ordinaires dans l'apprentissage des enchères.
    assert.equal(embLeadValue("yes", "yes", 625000), 750);
    assert.equal(embLeadValue("yes", "yes", 3000000), 750);
  });
});

test("embLeadValue reste neutre quand aucune estimation n'a abouti", () => {
  withTracking({}, () => {
    // Repli statique ou calcul différé : le coefficient de prix vaut 1. On
    // n'extrapole pas un prix pour ne pas laisser la case vide — ce serait
    // apprendre aux enchères une valeur qu'on a inventée.
    for (const absente of [undefined, null, "", 0, -1, "abc", Number.NaN]) {
      assert.equal(embLeadValue("yes", "yes", absente), 300, `valeur absente : ${absente}`);
    }
  });
});

test("embContactValue neutralise la candidature partenaire", () => {
  withTracking({}, () => {
    assert.equal(embContactValue("estimation"), 50);
    assert.equal(embContactValue("information"), 50);
    assert.equal(embContactValue("autre"), 50);
    assert.equal(embContactValue(""), 50);
    // Lead B2B : autre budget, autres campagnes, donc une valeur nettement
    // plus basse. Ce qui l'empêche de peser sur les enchères n'est pas sa
    // valeur mais son statut de conversion secondaire côté Ads. La valeur
    // s'aligne sur celle réglée dans le compte, où « ne pas utiliser de
    // valeur » n'est pas proposé pour cette catégorie d'action.
    assert.equal(embContactValue("partenariat"), 10);
    assert.equal(embContactValue("Partenariat"), 10);
    assert.ok(embContactValue("partenariat") < embContactValue("estimation"));
  });
});

test("embPageType qualifie les pages existantes", () => {
  withTracking({}, () => {
    assert.equal(embPageType("/"), "accueil");
    assert.equal(embPageType(""), "accueil");
    assert.equal(embPageType("/partenaires/"), "partenaires_index");
    assert.equal(embPageType("/partenaires/century-21/"), "partenaire_detail");
    assert.equal(embPageType("/estimation/"), "estimation");
    assert.equal(embPageType("/rapport/"), "rapport");
    assert.equal(embPageType("/carte/"), "carte");
    assert.equal(embPageType("/contact/"), "contact");
    assert.equal(embPageType("/pages/guide-dpe/"), "page_libre");
    assert.equal(embPageType("/mentions-legales/"), "autre");
  });
});

test("embLeadId produit un identifiant unique et exploitable", () => {
  withTracking({}, () => {
    const premier = embLeadId();
    assert.match(
      premier,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      "le repli getRandomValues doit produire un UUID v4 valide"
    );
    // `crypto.randomUUID` absent du bouchon : c'est bien le repli qui répond.
    assert.equal(typeof embLeadId(), "string");
  });
});

// ===========================================================================
// 4. Délégation des clics
// ===========================================================================

test("un clic sur un lien partenaire émet partner_click_out", () => {
  withTracking({ chemin: "/partenaires/" }, ({ pousses, cliquer }) => {
    const lien = creerElement({
      "data-partner-slug": "century-21",
      "data-partner-name": "Century 21",
      "data-partner-position": "5",
      href: "https://www.century21.fr",
    });

    cliquer(lien);

    assert.deepEqual(pousses[0], {
      event: "partner_click_out",
      partner_slug: "century-21",
      partner_name: "Century 21",
      page_type: "partenaires_index",
      page_path: "/partenaires",
      link_url: "https://www.century21.fr",
      position: 5,
    });
  });
});

test("le clic est capté même sur un enfant du lien", () => {
  withTracking({ chemin: "/partenaires/" }, ({ pousses, cliquer }) => {
    const lien = creerElement({ "data-partner-slug": "orpi", href: "https://www.orpi.com" });
    // Une icône ou un `<span>` à l'intérieur du lien : c'est LUI que le
    // navigateur désigne comme cible, pas le `<a>`.
    const icone = creerElement({}, { parent: lien });

    cliquer(icone);

    assert.equal(pousses.length, 1);
    assert.equal(pousses[0].partner_slug, "orpi");
  });
});

test("la mesure n'empêche jamais la navigation", () => {
  withTracking({ chemin: "/partenaires/" }, ({ cliquer, optionsEcouteur }) => {
    const lien = creerElement({ "data-partner-slug": "iad-france", href: "https://www.iadfrance.fr" });
    const evenement = cliquer(lien);

    assert.equal(
      evenement.defautEmpeche,
      false,
      "un lien partenaire doit s'ouvrir comme si la mesure n'existait pas"
    );
    assert.deepEqual(
      optionsEcouteur(),
      { capture: true, passive: true },
      "capture pour survivre à un stopPropagation, passif car on n'annule jamais"
    );
  });
});

test("une position absente ou nulle n'est pas poussée", () => {
  withTracking({ chemin: "/partenaires/" }, ({ pousses, cliquer }) => {
    cliquer(creerElement({ "data-partner-slug": "safti", href: "https://www.safti.fr" }));
    assert.equal("position" in pousses[0], false);

    cliquer(
      creerElement({
        "data-partner-slug": "safti",
        "data-partner-position": "0",
        href: "https://www.safti.fr",
      })
    );
    assert.equal("position" in pousses[1], false);
  });
});

test("un data-page-type déclaré l'emporte sur la déduction par l'URL", () => {
  withTracking({ chemin: "/estimation-immobiliere/paris-75/" }, ({ pousses, cliquer }) => {
    const section = creerElement({ "data-page-type": "departement" });
    const lien = creerElement(
      { "data-partner-slug": "foncia", href: "https://www.foncia.com" },
      { parent: section }
    );

    cliquer(lien);

    assert.equal(pousses[0].page_type, "departement");
  });
});

test("un clic sur un CTA émet cta_click", () => {
  withTracking({ chemin: "/carte/" }, ({ pousses, cliquer }) => {
    const cta = creerElement(
      { "data-cta": "carte", href: "/estimation/" },
      { texte: "  Estimer\n  mon bien  " }
    );

    cliquer(cta);

    assert.deepEqual(pousses[0], {
      event: "cta_click",
      cta_id: "carte",
      cta_label: "Estimer mon bien",
      cta_destination: "/estimation/",
      page_path: "/carte",
    });
  });
});

test("data-cta-label l'emporte sur le texte du bouton", () => {
  withTracking({ chemin: "/" }, ({ pousses, cliquer }) => {
    const cta = creerElement(
      { "data-cta": "hero_form", "data-cta-label": "Soumission hero" },
      { texte: "Estimer mon bien" }
    );

    cliquer(cta);

    assert.equal(pousses[0].cta_label, "Soumission hero");
  });
});

test("un lien partenaire l'emporte sur un data-cta ancêtre", () => {
  withTracking({ chemin: "/partenaires/" }, ({ pousses, cliquer }) => {
    const carte = creerElement({ "data-cta": "carte_partenaire" });
    const lien = creerElement(
      { "data-partner-slug": "orpi", href: "https://www.orpi.com" },
      { parent: carte }
    );

    cliquer(lien);

    assert.equal(pousses.length, 1, "un clic, un événement — jamais les deux");
    assert.equal(pousses[0].event, "partner_click_out");
  });
});

test("un clic hors de tout élément tracké ne pousse rien", () => {
  withTracking({ chemin: "/" }, ({ pousses, cliquer }) => {
    cliquer(creerElement({}, { texte: "Un paragraphe" }));
    cliquer({ target: null });
    assert.equal(pousses.length, 0);
  });
});

// ===========================================================================
// 5. Conversions améliorées — empreintes des coordonnées (lot T3)
// ===========================================================================
//
// Le hachage se fait DANS LE NAVIGATEUR, avant tout envoi. Google accepterait
// les coordonnées en clair et les hacherait lui-même — ce serait plus simple, et
// l'adresse e-mail transiterait alors par un `dataLayer` que n'importe quelle
// extension installée chez le visiteur peut lire.

/** Empreinte SHA-256 hexadécimale, calculée indépendamment du code testé. */
async function empreinteAttendue(texte) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(texte, "utf8").digest("hex");
}

/** `withTracking` avec la Web Crypto de Node : `embHash` doit vraiment calculer. */
function withCrypto(scenario) {
  return withTracking({ crypto: nodeWebCrypto() }, scenario);
}

function nodeWebCrypto() {
  return globalThis.crypto;
}

test("embHash produit bien un SHA-256 hexadécimal", async () => {
  await withCrypto(async () => {
    const empreinte = await embHash("jean.dupont@example.com");
    assert.equal(empreinte, await empreinteAttendue("jean.dupont@example.com"));
    assert.match(empreinte, /^[0-9a-f]{64}$/);
  });
});

test("embHash rend une chaîne vide plutôt que de lever", async () => {
  // Contexte non sécurisé (page servie en HTTP), navigateur ancien, valeur
  // absente : aucun de ces cas ne doit interrompre la conversion.
  await withCrypto(async () => {
    assert.equal(await embHash(""), "");
    assert.equal(await embHash(null), "");
    assert.equal(await embHash(undefined), "");
  });

  await withTracking({}, async () => {
    // `window.crypto.subtle` absent du bouchon : c'est le cas HTTP.
    assert.equal(await embHash("jean@example.com"), "");
  });
});

test("la normalisation des e-mails suit celle de Google", async () => {
  await withCrypto(() => {
    assert.equal(embNormaliserEmail("  Jean.Dupont@Example.COM "), "jean.dupont@example.com");
    // Les points d'une adresse gmail sont CONSERVÉS : Google ne les retire que
    // pour Customer Match. Les enlever ici produirait une empreinte que rien
    // ne rapprocherait jamais.
    assert.equal(embNormaliserEmail("jean.dupont@gmail.com"), "jean.dupont@gmail.com");
    for (const invalide of ["", "   ", "pas-une-adresse", "@example.com", null, undefined]) {
      assert.equal(embNormaliserEmail(invalide), "", `entrée invalide : ${invalide}`);
    }
  });
});

test("les téléphones sont ramenés au format E.164", async () => {
  await withCrypto(() => {
    // Un « 06 12 34 56 78 » envoyé tel quel produit une empreinte que rien ne
    // rapprochera jamais, et l'échec est silencieux. D'où cette conversion.
    assert.equal(embNormaliserTelephone("06 12 34 56 78"), "+33612345678");
    assert.equal(embNormaliserTelephone("06.12.34.56.78"), "+33612345678");
    assert.equal(embNormaliserTelephone("0612345678"), "+33612345678");
    assert.equal(embNormaliserTelephone("+33 6 12 34 56 78"), "+33612345678");
    assert.equal(embNormaliserTelephone("0033612345678"), "+33612345678");
    assert.equal(embNormaliserTelephone("33612345678"), "+33612345678");

    // Inexploitable : mieux vaut ne rien envoyer qu'une empreinte fausse.
    for (const invalide of ["", "12", "abcdef", null, undefined]) {
      assert.equal(embNormaliserTelephone(invalide), "", `entrée invalide : ${invalide}`);
    }
  });
});

test("embUserData ne rend que des empreintes, jamais du clair", async () => {
  await withCrypto(async () => {
    const donnees = await embUserData("Jean.Dupont@Example.com", "06 12 34 56 78");

    assert.deepEqual(Object.keys(donnees).sort(), [
      "sha256_email_address",
      "sha256_phone_number",
    ]);
    assert.equal(donnees.sha256_email_address, await empreinteAttendue("jean.dupont@example.com"));
    assert.equal(donnees.sha256_phone_number, await empreinteAttendue("+33612345678"));
  });
});

test("embUserData omet ce qu'elle ne peut pas hacher, sans rejeter", async () => {
  await withCrypto(async () => {
    assert.deepEqual(await embUserData("jean@example.com", ""), {
      sha256_email_address: await empreinteAttendue("jean@example.com"),
    });
    assert.deepEqual(await embUserData("", ""), {});
    assert.deepEqual(await embUserData(null, undefined), {});
  });

  // Sans Web Crypto (page en HTTP), la promesse se résout quand même : une
  // conversion sans conversion améliorée reste une conversion.
  await withTracking({}, async () => {
    assert.deepEqual(await embUserData("jean@example.com", "0612345678"), {});
  });
});

// ===========================================================================
// 6. Le filtre anti-PII face à l'objet imbriqué
// ===========================================================================

test("user_data ne laisse passer que ce qui ressemble à une empreinte", () => {
  withTracking({}, ({ pousses, avertissements }) => {
    const empreinte = "a".repeat(64);

    embTrack("generate_lead", {
      user_data: {
        sha256_email_address: empreinte,
        // Erreur de câblage : la valeur en clair au lieu de son empreinte.
        // Elle ne ressemble pas à un SHA-256, elle est écartée bruyamment.
        sha256_phone_number: "0612345678",
      },
    });

    assert.deepEqual(pousses[0], {
      event: "generate_lead",
      user_data: { sha256_email_address: empreinte },
    });
    assert.equal(avertissements.length, 1);
  });
});

test("un user_data entièrement invalide n'est pas poussé du tout", () => {
  withTracking({}, ({ pousses }) => {
    embTrack("generate_lead", {
      lead_id: "abc",
      user_data: { sha256_email_address: "jean.dupont@example.com" },
    });

    assert.deepEqual(pousses[0], { event: "generate_lead", lead_id: "abc" });
  });
});

test("aucun autre objet imbriqué n'est accepté", () => {
  withTracking({}, ({ pousses, avertissements }) => {
    // Le `lastEstimation` d'où viennent la plupart des paramètres contient nom,
    // e-mail, téléphone et adresse : un objet recopié sans contrôle est un
    // objet dont personne ne relit le contenu.
    embTrack("generate_lead", {
      lead_id: "abc",
      donnees: { email: "jean@example.com" },
      user_data: ["a".repeat(64)],
    });

    assert.deepEqual(pousses[0], { event: "generate_lead", lead_id: "abc" });
    assert.equal(avertissements.length, 2);
  });
});

test("un user_data absent ou vide ne crée pas de clé", () => {
  withTracking({}, ({ pousses }) => {
    embTrack("contact_lead", { lead_id: "abc", user_data: {} });
    embTrack("contact_lead", { lead_id: "def", user_data: null });

    assert.equal("user_data" in pousses[0], false);
    assert.equal("user_data" in pousses[1], false);
  });
});
