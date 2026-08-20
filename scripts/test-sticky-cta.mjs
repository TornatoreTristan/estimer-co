#!/usr/bin/env node
/**
 * Vérification autonome de `src/scripts/sticky-cta.js` (barre d'appel à
 * l'action collée en bas de fenêtre, cf. `src/components/StickyCta.astro`).
 *
 * Même technique que les autres vérifications du front : le fichier est
 * exécuté tel qu'il sera injecté en production (script classique, aucun
 * import/export) via `vm.Script#runInThisContext()`, sur un bouchon de
 * `document` / `window` posé avant chaque exécution. Le script s'exécutant
 * entièrement au chargement, l'exécuter c'est déjà exercer son comportement.
 *
 * Ce qui est verrouillé ici, ce sont les quatre promesses faites au visiteur :
 *
 *   1. la barre ne s'affiche PAS tant que la hero est à l'écran — c'est toute
 *      la différence entre un rappel et une pop-up qui saute au visage ;
 *   2. elle s'efface quand le pied de page arrive, pour ne pas recouvrir les
 *      liens qui y répètent la même offre ;
 *   3. fermée, elle le reste — pour la session, et sans qu'un défilement
 *      ultérieur ne la ramène ;
 *   4. un `sessionStorage` indisponible (Safari en navigation privée, cookies
 *      bloqués) ne casse rien : la barre continue de fonctionner, elle oublie
 *      seulement la fermeture.
 *
 * Non couvert : le rendu (position, animation, `visibility`) — c'est du CSS,
 * il se vérifie à l'œil et dans `global.css`.
 *
 * Usage : `node scripts/test-sticky-cta.mjs` (ou `npm run test:sticky-cta`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, "..", "src", "scripts", "sticky-cta.js");

const SOURCE = readFileSync(SCRIPT_PATH, "utf8");
const SCRIPT = new vm.Script(SOURCE, { filename: "sticky-cta.js" });

const HAUTEUR_ECRAN = 900;

/** Élément minimal : attributs, écouteurs, géométrie pilotée par le scénario. */
function creerElement(nom, rect) {
  const element = {
    nom,
    attributs: {},
    ecouteurs: {},
    parentNode: null,
    rect: rect || { top: 0, bottom: 0 },
    setAttribute(cle, valeur) {
      this.attributs[cle] = String(valeur);
    },
    getAttribute(cle) {
      return Object.prototype.hasOwnProperty.call(this.attributs, cle)
        ? this.attributs[cle]
        : null;
    },
    getBoundingClientRect() {
      return this.rect;
    },
    addEventListener(type, handler) {
      (this.ecouteurs[type] = this.ecouteurs[type] || []).push(handler);
    },
    declencher(type) {
      (this.ecouteurs[type] || []).forEach((handler) => handler({ type }));
    },
    querySelector() {
      return null;
    },
  };
  return element;
}

/**
 * Monte le bouchon, exécute `sticky-cta.js`, passe le pilotage à `scenario`,
 * puis restaure le realm.
 *
 * @param {{
 *   ancre?: boolean,        // false = page sans hero ni `.page-head`
 *   pied?: boolean,
 *   ferme?: boolean,        // fermeture déjà mémorisée pour la session
 *   stockage?: 'ok'|'ko',   // 'ko' = `sessionStorage` qui lève (Safari privé)
 *   raf?: boolean,          // false = pas de `requestAnimationFrame`
 * }} options
 */
function withStickyCta(options, scenario) {
  const opts = options || {};
  const avecAncre = opts.ancre !== false;
  const avecPied = opts.pied !== false;

  // La hero commence sous le haut de l'écran, le pied de page est loin en bas :
  // l'état initial est « en haut de page ».
  const barre = creerElement("barre");
  const fermeture = creerElement("fermeture");
  barre.querySelector = (selecteur) =>
    selecteur === "[data-sticky-cta-close]" ? fermeture : null;

  const ancre = creerElement("ancre", { top: 0, bottom: 700 });
  const pied = creerElement("pied", { top: 4000, bottom: 4600 });

  const retires = [];
  barre.parentNode = {
    removeChild(enfant) {
      retires.push(enfant);
    },
  };

  const elements = {
    "[data-sticky-cta]": barre,
    "[data-sticky-cta-anchor]": null,
    ".hero": avecAncre ? ancre : null,
    ".page-head": null,
    ".site-footer": avecPied ? pied : null,
  };

  const magasin = new Map();
  if (opts.ferme) magasin.set("emb.sticky-cta.ferme", "1");
  const stockageKo = opts.stockage === "ko";
  const sessionStorage = {
    getItem(cle) {
      if (stockageKo) throw new Error("SecurityError");
      return magasin.has(cle) ? magasin.get(cle) : null;
    },
    setItem(cle, valeur) {
      if (stockageKo) throw new Error("SecurityError");
      magasin.set(cle, String(valeur));
    },
  };

  const ecouteurs = {};
  const fenetre = {
    innerHeight: HAUTEUR_ECRAN,
    scrollY: 0,
    sessionStorage,
    addEventListener(type, handler) {
      (ecouteurs[type] = ecouteurs[type] || []).push(handler);
    },
    removeEventListener(type, handler) {
      ecouteurs[type] = (ecouteurs[type] || []).filter((inscrit) => inscrit !== handler);
    },
  };
  // Exécution synchrone : le test n'a alors qu'à déclencher l'événement pour
  // observer l'état résultant.
  if (opts.raf !== false) fenetre.requestAnimationFrame = (rappel) => rappel(0);

  const saved = {
    document: globalThis.document,
    window: globalThis.window,
  };

  globalThis.document = {
    querySelector(selecteur) {
      return Object.prototype.hasOwnProperty.call(elements, selecteur)
        ? elements[selecteur]
        : null;
    },
  };
  globalThis.window = fenetre;

  try {
    SCRIPT.runInThisContext();

    scenario({
      barre,
      fermeture,
      ancre,
      pied,
      retires,
      magasin,
      /** Positionne la page : `y` = pixels défilés depuis le haut. */
      defiler(y) {
        fenetre.scrollY = y;
        ancre.rect = { top: -y, bottom: 700 - y };
        pied.rect = { top: 4000 - y, bottom: 4600 - y };
        (ecouteurs.scroll || []).forEach((handler) => handler({ type: "scroll" }));
      },
      etat() {
        return barre.getAttribute("data-state");
      },
      nbEcouteurs(type) {
        return (ecouteurs[type] || []).length;
      },
    });
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
  }
}

// ============================================================================
// 1. Apparition après la hero
// ============================================================================

test("la barre reste masquée tant que la hero est à l'écran", () => {
  withStickyCta({}, (page) => {
    assert.equal(page.etat(), null, "aucun état posé avant le moindre défilement");

    page.defiler(300); // le bas de la hero est encore à 400 px sous le haut
    assert.notEqual(page.etat(), "visible");
  });
});

test("la barre apparaît une fois le bas de la hero franchi", () => {
  withStickyCta({}, (page) => {
    page.defiler(750);
    assert.equal(page.etat(), "visible");
  });
});

test("revenir en haut de page la remasque", () => {
  withStickyCta({}, (page) => {
    page.defiler(750);
    assert.equal(page.etat(), "visible");

    page.defiler(0);
    assert.equal(page.etat(), "hidden");
  });
});

// ============================================================================
// 2. Effacement devant le pied de page
// ============================================================================

test("la barre s'efface dès que le pied de page entre à l'écran", () => {
  withStickyCta({}, (page) => {
    page.defiler(750);
    assert.equal(page.etat(), "visible");

    // Pied de page à 4000 px du haut du document, écran de 900 px : il entre
    // dans le viewport à partir de 3100 px défilés.
    page.defiler(3150);
    assert.equal(page.etat(), "hidden");
  });
});

// ============================================================================
// 3. Fermeture
// ============================================================================

test("fermer la barre la masque, la mémorise et coupe l'écoute du défilement", () => {
  withStickyCta({}, (page) => {
    page.defiler(750);
    assert.equal(page.etat(), "visible");

    page.fermeture.declencher("click");
    assert.equal(page.etat(), "hidden");
    assert.equal(page.magasin.get("emb.sticky-cta.ferme"), "1");
    assert.equal(page.nbEcouteurs("scroll"), 0, "plus rien ne doit la ramener");
    assert.equal(page.nbEcouteurs("resize"), 0);

    page.defiler(1200);
    assert.equal(page.etat(), "hidden");
  });
});

test("une fermeture déjà mémorisée retire la barre sans rien écouter", () => {
  withStickyCta({ ferme: true }, (page) => {
    assert.deepEqual(page.retires, [page.barre]);
    assert.equal(page.nbEcouteurs("scroll"), 0);
  });
});

// ============================================================================
// 4. Garde-fous
// ============================================================================

test("un sessionStorage qui lève ne casse ni l'affichage ni la fermeture", () => {
  withStickyCta({ stockage: "ko" }, (page) => {
    page.defiler(750);
    assert.equal(page.etat(), "visible");

    page.fermeture.declencher("click");
    assert.equal(page.etat(), "hidden");
  });
});

test("sans hero ni en-tête de page, le repli est un seuil de 80 % d'écran", () => {
  withStickyCta({ ancre: false }, (page) => {
    page.defiler(0.7 * HAUTEUR_ECRAN);
    assert.notEqual(page.etat(), "visible");

    page.defiler(0.9 * HAUTEUR_ECRAN);
    assert.equal(page.etat(), "visible");
  });
});

test("sans requestAnimationFrame, la barre bascule quand même", () => {
  withStickyCta({ raf: false }, (page) => {
    page.defiler(750);
    assert.equal(page.etat(), "visible");
  });
});

test("sans pied de page dans la page, la barre reste affichée", () => {
  withStickyCta({ pied: false }, (page) => {
    page.defiler(3150);
    assert.equal(page.etat(), "visible");
  });
});
