#!/usr/bin/env node
/**
 * Vérification autonome du rendu de `/rapport` (`src/scripts/rapport-report.js`)
 * et des sections correspondantes du PDF (`src/scripts/pdf-report.js`).
 *
 * Même technique que les autres suites (`vm.Script`) : les
 * fichiers sont exécutés tels qu'ils seront injectés en production — scripts
 * classiques, aucun `import`/`export`, tout en portée globale — dans l'ordre
 * réel de la page `/rapport` : `pdf-report.js` (helpers `formatPrice`,
 * `capitalizeWords`, `capitalizeFirst`), puis `estimation-api.js` (bouton
 * « Relancer le calcul »), enfin `rapport-report.js`.
 *
 * `rapport-report.js` s'exécute intégralement au chargement (il lit
 * `localStorage.lastEstimation` et écrit dans le DOM) : on lui fournit donc un
 * faux `document` dont `getElementById` crée les éléments à la demande, ce qui
 * permet d'inspecter ensuite le `innerHTML`/`textContent` réellement produit
 * pour chaque carte.
 *
 * Chaque scénario tourne dans un CONTEXTE `vm` NEUF (et non
 * `runInThisContext`, comme les suites du wizard) : `rapport-report.js`
 * déclare `const lastEstimation` en portée globale, ce qu'un même realm ne
 * peut évaluer deux fois. Un contexte par rendu, c'est aussi l'assurance
 * qu'aucun test n'hérite de l'état d'un autre.
 *
 * Ce que cette suite verrouille :
 * - US-6 / §8.2 : AUCUNE mention DVF/DGFiP sur un rapport `reference-table`
 *   (territoires du Livre foncier : Bas-Rhin, Haut-Rhin, Moselle, Mayotte) —
 *   la contradiction « Ventes réelles enregistrées par la DGFiP » au-dessus
 *   d'un état vide « Références départementales (hors base DVF) » relevée en
 *   revue QA ;
 * - l'échappement HTML des valeurs venues de `localStorage` ;
 * - l'ajustement temporel n'est affiché QUE si un indice INSEE-Notaires a
 *   réellement servi (`dataSource.priceIndexQuarter`) ;
 * - la lecture DÉFENSIVE de `method.coefficientSources` (champ d'API à venir) :
 *   le rendu doit être correct avec ET sans ce champ.
 *
 * Usage : `node --test scripts/test-rapport-report.mjs`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadScript(name) {
  const file = path.join(__dirname, "..", "src", "scripts", name);
  return new vm.Script(readFileSync(file, "utf8"), { filename: name });
}

const PDF_SCRIPT = loadScript("pdf-report.js");
const API_SCRIPT = loadScript("estimation-api.js");
const REPORT_SCRIPT = loadScript("rapport-report.js");
const TRACKING_SCRIPT = loadScript("tracking.js");

// ============================================================================
// Faux DOM minimal
// ============================================================================

/**
 * Éléments portant l'attribut `hidden` dans `src/pages/rapport.astro` : leur
 * état initial fait partie du comportement testé (une carte n'apparaît que si
 * le script la révèle explicitement).
 */
const HIDDEN_BY_DEFAULT = [
  "estimationStatusBanner",
  "rangeNote",
  "estimationWarnings",
  "dataSourceBanner",
  "confidenceCard",
  "comparablesCard",
  "methodologyCard",
  "cityAnalysis",
];

function makeElement(id) {
  const listeners = {};
  return {
    id: id,
    innerHTML: "",
    textContent: "",
    hidden: HIDDEN_BY_DEFAULT.indexOf(id) !== -1,
    disabled: false,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dispatch(type, event) {
      (listeners[type] || []).forEach(function (fn) {
        fn(event || {});
      });
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
  };
}

/**
 * `lastEstimation` nominal (mode `comparables`, Paris), auquel chaque test
 * applique ses variantes. Reproduit la forme réellement écrite par
 * `estimation-ui.js` : les clés historiques à plat, plus l'objet `estimation`
 * enrichi par l'API.
 */
function baseLastEstimation(overrides) {
  return Object.assign(
    {
      propertyType: "appartement",
      address: "12 rue de la Paix",
      postalCode: "75001",
      city: "paris",
      surface: 85,
      rooms: 3,
      dpe: "C",
      isOwner: "yes",
      wantToSell: "yes",
      estimationStatus: "ok",
      estimation: {
        prixM2: 10000,
        estimationMin: 765000,
        estimationMax: 935000,
        estimationMoyenne: 850000,
        confidence: { score: 78, label: "high" },
        display: { confidenceLabelFr: "Élevé" },
        range: { low: 765000, high: 935000, halfWidthPct: 0.1, basis: "iqr" },
        method: {
          kind: "comparables",
          level: "radius",
          radiusM: 500,
          comparablesCount: 24,
          windowMonths: 24,
          surfaceTolerancePct: 20,
          medianPriceM2Raw: 9800,
          timeAdjustmentFactor: 1,
          coefficients: { surface: 1.02, dpe: 0.97, total: 0.99 },
        },
        comparables: [
          {
            street: "rue de rivoli",
            distanceM: 220,
            date: "2025-03",
            propertyType: "appartement",
            surface: 82,
            pricePerSqm: 9900,
          },
        ],
        dataSource: {
          dataCoverage: "full",
          priceIndexQuarter: null,
          attributionFr: "Source : DVF (DGFiP), publiées le 1er octobre 2025.",
          disclaimerFr: "Cette estimation ne constitue pas une expertise.",
        },
      },
    },
    overrides || {}
  );
}

/**
 * Rapport « Strasbourg » : territoire du Livre foncier, donc AUCUNE
 * transaction DVF — l'API répond `kind: 'reference-table'`, `comparables: []`,
 * `dataCoverage: 'no-dvf'` (cf. specs/estimation-donnees-reelles.md §3.2).
 */
function strasbourgLastEstimation() {
  const data = baseLastEstimation({
    postalCode: "67000",
    city: "strasbourg",
  });
  data.estimation.method = {
    kind: "reference-table",
    level: "departement-reference",
    comparablesCount: 0,
    windowMonths: 24,
    timeAdjustmentFactor: 1,
    coefficients: { surface: 1.02, dpe: 0.97, total: 0.99 },
  };
  data.estimation.comparables = [];
  data.estimation.confidence = { score: 34, label: "low" };
  data.estimation.dataSource = {
    dataCoverage: "no-dvf",
    priceIndexQuarter: null,
    attributionFr:
      "Source : références départementales internes, hors base publique DVF.",
    disclaimerFr: "Cette estimation ne constitue pas une expertise.",
  };
  return data;
}

/**
 * Exécute `rapport-report.js` sur un `lastEstimation` donné et renvoie les
 * éléments produits.
 *
 * @param {object} lastEstimation
 * @param {{ store?: Map<string,string>, mesure?: boolean }} [options]
 *   `store` partagé entre deux appels = deux chargements de `/rapport` dans le
 *   MÊME navigateur (rechargement, retour arrière). `mesure` charge en plus
 *   `tracking.js`, comme le fait `Tracking.astro` dans le `<head>`.
 *   `sansWebCrypto` simule une page servie en HTTP, où le hachage est
 *   impossible.
 */
function renderReport(lastEstimation, options) {
  const opts = options || {};
  const elements = new Map();
  const store = opts.store || new Map();
  store.set("lastEstimation", JSON.stringify(lastEstimation));

  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    setTimeout: function () {},
    clearTimeout: function () {},
    // Vrais minuteurs : `embAttendreConsentement` scrute le dataLayer, et on
    // veut exercer ce chemin plutôt que son repli sur erreur.
    setInterval: setInterval,
    clearInterval: clearInterval,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
      },
      querySelector() {
        return null;
      },
    },
    window: {
      location: { href: "" },
      addEventListener() {},
      // La vraie Web Crypto de Node : le hachage des coordonnées doit être
      // réellement exercé, pas contourné par un bouchon complaisant.
      crypto: opts.sansWebCrypto ? {} : globalThis.crypto,
      /*
       * Consentement DÉJÀ connu, sauf demande contraire : c'est le cas d'un
       * visiteur revenant sur le site, dont le choix stocké est restitué au
       * chargement. Sans cette amorce, `embAttendreConsentement` scruterait
       * pendant deux secondes à chaque test.
       */
      dataLayer: opts.consentementInconnu ? [] : [{ event: "consent_update" }],
    },
    TextEncoder,
    localStorage: {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(key, String(value));
      },
      removeItem(key) {
        store.delete(key);
      },
    },
    CONFIG: { API: { BASE_URL: "https://api.test.local" } },
  };
  vm.createContext(sandbox);

  // Ordre de production de la page `/rapport` (cf. rapport.astro) : le socle
  // de mesure d'abord — il est écrit dans le `<head>`, avant tout script de
  // page —, puis les scripts de la page.
  if (opts.mesure) TRACKING_SCRIPT.runInContext(sandbox);
  PDF_SCRIPT.runInContext(sandbox);
  API_SCRIPT.runInContext(sandbox);
  REPORT_SCRIPT.runInContext(sandbox);

  return {
    sandbox: sandbox,
    /** Événements réellement poussés dans le dataLayer par ce chargement. */
    pousses() {
      return sandbox.window.dataLayer || [];
    },
    get(id) {
      return elements.get(id) || null;
    },
    /** Texte + HTML de toutes les cartes VISIBLES (celles qui ne sont pas `hidden`). */
    visibleHtml() {
      let html = "";
      elements.forEach(function (element) {
        if (element.hidden) return;
        html += " " + element.textContent + " " + element.innerHTML;
      });
      return html;
    },
  };
}

// ============================================================================
// US-6 / §8.2 — aucune mention DVF/DGFiP hors base DVF
// ============================================================================

test("reference-table (Strasbourg) — la carte des comparables ne s'affiche pas du tout", () => {
  const report = renderReport(strasbourgLastEstimation());

  assert.equal(
    report.get("comparablesCard").hidden,
    true,
    "une carte « Ventes réelles… » sans aucune vente réelle n'a pas lieu d'être"
  );
});

test("reference-table (Strasbourg) — le titre « Ventes réelles enregistrées par la DGFiP » n'est jamais posé", () => {
  const report = renderReport(strasbourgLastEstimation());
  const title = report.get("comparablesTitle");

  assert.equal(
    title.textContent,
    "",
    "le titre du markup (« Transactions comparables ») ne doit pas être réécrit en mention DGFiP"
  );
});

test("reference-table (Strasbourg) — aucune mention DGFiP/DVF dans le contenu affiché, sauf l'explication Livre foncier", () => {
  const report = renderReport(strasbourgLastEstimation());

  // La seule mention légitime : le bandeau qui EXPLIQUE pourquoi ces
  // transactions ne figurent PAS dans DVF, et la ligne de méthodologie
  // « Références départementales (hors base DVF) ». Aucune ne présente le
  // chiffre comme issu de DVF.
  const banner = report.get("estimationStatusBanner").innerHTML;
  assert.match(banner, /Territoire relevant du Livre foncier/);
  assert.match(banner, /ne figurent pas dans la base publique DVF de la DGFiP/);

  assert.equal(
    report.get("comparablesContent").innerHTML,
    "",
    "aucun état vide sous un titre DGFiP"
  );

  const source = report.get("dataSourceBanner").innerHTML;
  assert.match(source, /références départementales internes, hors base publique DVF/);
  assert.equal(
    /Ventes réelles enregistrées/.test(report.visibleHtml()),
    false,
    "la formule « Ventes réelles enregistrées » ne doit apparaître nulle part"
  );
});

test("comparables (Paris) — non-régression : le titre DGFiP et le tableau restent affichés", () => {
  const report = renderReport(baseLastEstimation());

  assert.equal(report.get("comparablesCard").hidden, false);
  assert.equal(
    report.get("comparablesTitle").textContent,
    "Ventes réelles enregistrées par la DGFiP"
  );
  assert.match(report.get("comparablesContent").innerHTML, /Rue de Rivoli/);
  assert.match(report.get("comparablesContent").innerHTML, /mars 2025/);
});

test("static-fallback — la carte des comparables reste masquée (non-régression)", () => {
  const data = baseLastEstimation({ estimationStatus: "static-fallback" });
  const report = renderReport(data);

  assert.equal(report.get("comparablesCard").hidden, true);
  assert.equal(
    /DGFiP/.test(report.visibleHtml()),
    false,
    "un repli interne ne cite jamais la DGFiP"
  );
});

// ============================================================================
// Échappement HTML des valeurs venues de localStorage
// ============================================================================

test("détails du bien — adresse, code postal et ville sont échappés", () => {
  const report = renderReport(
    baseLastEstimation({
      address: '<img src=x onerror="alert(1)">',
      city: "<script>alert(2)</script>",
      postalCode: "<b>75001</b>",
    })
  );

  const html = report.get("propertyDetails").innerHTML;
  assert.equal(html.includes("<img"), false, "aucune balise injectée depuis l'adresse");
  assert.equal(html.includes("<script"), false, "aucune balise injectée depuis la ville");
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;b&gt;75001&lt;\/b&gt;/);
});

test("détails du bien — les valeurs normales restent lisibles telles quelles", () => {
  const report = renderReport(baseLastEstimation());
  const html = report.get("propertyDetails").innerHTML;

  assert.match(html, /12 rue de la Paix/);
  assert.match(html, /75001 Paris/);
  assert.match(html, /Appartement/);
  assert.match(html, /85 m²/);
  assert.match(html, /3 pièces/);
  assert.match(html, /Classe C/);
});

// ============================================================================
// Ajustement temporel — pas de correction affichée tant qu'il n'y en a pas
// ============================================================================

test("méthodologie — aucun « Ajustement temporel » tant que priceIndexQuarter est null (Lot 4 non livré)", () => {
  const report = renderReport(baseLastEstimation());

  assert.equal(
    report.get("methodologyContent").innerHTML.includes("Ajustement temporel"),
    false,
    "afficher ×1,00 suggérerait une correction qui n'a pas eu lieu"
  );
});

test("méthodologie — l'ajustement temporel s'affiche dès que l'indice INSEE est renseigné", () => {
  const data = baseLastEstimation();
  data.estimation.dataSource.priceIndexQuarter = "2025-T2";
  data.estimation.method.timeAdjustmentFactor = 1.031;
  const report = renderReport(data);

  const html = report.get("methodologyContent").innerHTML;
  assert.match(html, /Ajustement temporel médian/);
  assert.match(html, /×1,03/);
  assert.match(html, /indice INSEE-Notaires 2025-T2/);
});

// ============================================================================
// method.coefficientSources — champ d'API à venir, lecture défensive
// ============================================================================

test("coefficients — sans `coefficientSources`, les libellés d'origine sont conservés", () => {
  const report = renderReport(baseLastEstimation());
  const html = report.get("methodologyContent").innerHTML;

  assert.match(html, /Surface du bien/);
  assert.match(html, /Dégressivité du prix au m²/);
  assert.match(html, /Diagnostic énergétique/);
  assert.match(html, /Coefficients de valeur verte de référence/);
});

test("coefficients — avec `coefficientSources`, c'est le libellé de l'API qui s'affiche", () => {
  const data = baseLastEstimation();
  data.estimation.method.coefficientSources = [
    {
      key: "dpe",
      label: "Diagnostic de performance énergétique",
      sourceLabel:
        "Valeur provisoire de la spécification produit, à calibrer au Lot 5.",
      sourceUrl: "https://www.notaires.fr/fr/valeur-verte",
      dateSource: "2025-11",
    },
  ];
  const report = renderReport(data);
  const html = report.get("methodologyContent").innerHTML;

  assert.match(
    html,
    /Valeur provisoire de la spécification produit, à calibrer au Lot 5\./,
    "la mention honnête portée par la base doit atteindre l'écran"
  );
  assert.match(html, /Diagnostic de performance énergétique/);
  assert.match(html, /\(2025-11\)/);
  assert.match(html, /<a href="https:\/\/www\.notaires\.fr\/fr\/valeur-verte"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.equal(
    html.includes("Coefficients de valeur verte de référence"),
    false,
    "le libellé écrit en dur doit céder la place à celui de l'API"
  );
  // Les coefficients NON couverts par `coefficientSources` gardent le leur.
  assert.match(html, /Dégressivité du prix au m²/);
});

test("coefficients — une `sourceUrl` non http(s) n'est jamais transformée en lien", () => {
  const data = baseLastEstimation();
  data.estimation.method.coefficientSources = [
    {
      key: "surface",
      sourceLabel: "Barème interne",
      sourceUrl: "javascript:alert(1)",
    },
  ];
  const report = renderReport(data);
  const html = report.get("methodologyContent").innerHTML;

  assert.match(html, /Barème interne/);
  assert.equal(html.includes("javascript:"), false);
  assert.equal(html.includes("<a href"), false);
});

test("coefficients — un `coefficientSources` mal formé n'empêche pas le rendu", () => {
  const data = baseLastEstimation();
  data.estimation.method.coefficientSources = { pas: "un tableau" };
  const report = renderReport(data);

  assert.equal(report.get("methodologyCard").hidden, false);
  assert.match(report.get("methodologyContent").innerHTML, /Dégressivité du prix au m²/);
});

// ============================================================================
// PDF — mêmes règles, même garde (src/scripts/pdf-report.js)
// ============================================================================

/**
 * Charge `pdf-report.js` et remplace ses primitives de mise en page par des
 * collecteurs : on observe CE QUI serait imprimé, sans avoir besoin de jsPDF
 * ni d'analyser un binaire PDF.
 */
function withPdfPrimitivesStubbed(scenario) {
  const sandbox = { console: { log() {}, error() {}, warn() {} } };
  vm.createContext(sandbox);
  PDF_SCRIPT.runInContext(sandbox);

  const emitted = [];

  sandbox.pdfHeading = function (layout, text) {
    emitted.push({ type: "heading", text: String(text) });
  };
  sandbox.pdfParagraph = function (layout, text) {
    emitted.push({ type: "paragraph", text: String(text) });
  };
  sandbox.pdfDataGrid = function (layout, rows) {
    (rows || []).forEach(function (row) {
      (row || []).forEach(function (cell) {
        emitted.push({ type: "fact", text: cell.label + " : " + cell.value });
      });
    });
  };
  sandbox.pdfNote = function (layout, options) {
    emitted.push({ type: "note", text: String((options && options.text) || "") });
  };
  sandbox.pdfStatBand = function () {};

  const layout = {
    doc: {},
    x: 16,
    y: 40,
    width: 178,
    space() {},
    reserve() {},
  };

  scenario({
    layout: layout,
    emitted: emitted,
    comparablesSection(ctx) {
      sandbox.pdfComparablesSection(layout, ctx);
    },
    methodologySection(ctx) {
      sandbox.pdfMethodologySection(layout, ctx);
    },
  });

  return emitted;
}

/** Contexte PDF (`pdfBuildContext`) réduit à ce que lisent les deux sections. */
function pdfContext(overrides) {
  return Object.assign(
    {
      method: {
        kind: "comparables",
        level: "radius",
        radiusM: 500,
        comparablesCount: 24,
        windowMonths: 24,
        medianPriceM2Raw: 9800,
        timeAdjustmentFactor: 1,
        coefficients: { surface: 1.02, dpe: 0.97, total: 0.99 },
      },
      comparables: [],
      dataSource: { dataCoverage: "full", priceIndexQuarter: null },
      isStaticFallback: false,
      isDeferred: false,
    },
    overrides || {}
  );
}

test("PDF — `reference-table` : la section « Ventes réelles enregistrées par la DGFiP » n'est pas imprimée", () => {
  const emitted = withPdfPrimitivesStubbed(function (pdf) {
    pdf.comparablesSection(
      pdfContext({
        method: { kind: "reference-table", level: "departement-reference", comparablesCount: 0 },
        dataSource: { dataCoverage: "no-dvf", priceIndexQuarter: null },
      })
    );
  });

  assert.deepEqual(emitted, [], "aucun titre, aucun paragraphe : la section disparaît");
});

test("PDF — `comparables` sans aucune vente listable : le titre reste, avec son état vide", () => {
  const emitted = withPdfPrimitivesStubbed(function (pdf) {
    pdf.comparablesSection(pdfContext());
  });

  assert.equal(emitted[0].type, "heading");
  assert.equal(emitted[0].text, "Ventes réelles enregistrées par la DGFiP");
  assert.match(emitted[1].text, /Aucune vente comparable/);
});

test("PDF — méthodologie : pas d'« Ajustement temporel » sans indice INSEE", () => {
  const emitted = withPdfPrimitivesStubbed(function (pdf) {
    pdf.methodologySection(pdfContext());
  });

  assert.equal(
    emitted.some(function (entry) {
      return entry.text.indexOf("Ajustement temporel") !== -1;
    }),
    false
  );
});

test("PDF — méthodologie : l'ajustement temporel apparaît avec son trimestre d'indice", () => {
  const emitted = withPdfPrimitivesStubbed(function (pdf) {
    const ctx = pdfContext();
    ctx.method.timeAdjustmentFactor = 1.031;
    ctx.dataSource.priceIndexQuarter = "2025-T2";
    pdf.methodologySection(ctx);
  });

  const fact = emitted.find(function (entry) {
    return entry.text.indexOf("Ajustement temporel") !== -1;
  });
  assert.ok(fact, "la ligne doit exister");
  assert.match(fact.text, /x1,03 \(2025-T2\)/);
});

test("PDF — méthodologie : `coefficientSources` remplace les libellés écrits en dur", () => {
  const emitted = withPdfPrimitivesStubbed(function (pdf) {
    const ctx = pdfContext();
    ctx.method.coefficientSources = [
      {
        key: "dpe",
        label: "Diagnostic de performance énergétique",
        sourceLabel: "valeur provisoire de la spécification produit, à calibrer au Lot 5",
        dateSource: "2025-11",
      },
    ];
    pdf.methodologySection(ctx);
  });

  const line = emitted.find(function (entry) {
    return entry.text.indexOf("Diagnostic de performance énergétique") !== -1;
  });
  assert.ok(line, "le libellé de l'API doit être utilisé");
  assert.match(line.text, /valeur provisoire de la spécification produit, à calibrer au Lot 5 \(2025-11\)/);
  assert.equal(
    emitted.some(function (entry) {
      return entry.text.indexOf("coefficients de valeur verte de référence") !== -1;
    }),
    false
  );
});

test("PDF — méthodologie : sans `coefficientSources`, rien ne change (non-régression)", () => {
  const emitted = withPdfPrimitivesStubbed(function (pdf) {
    pdf.methodologySection(pdfContext());
  });

  assert.ok(
    emitted.some(function (entry) {
      return entry.text.indexOf("coefficients de valeur verte de référence") !== -1;
    })
  );
  assert.ok(
    emitted.some(function (entry) {
      return entry.text.indexOf("dégressivité du prix au m²") !== -1;
    })
  );
});

// ============================================================================
// Mesure de la conversion — specs/plan-taggage-conversions.md §2.3, §9.3
// ============================================================================
//
// La conversion principale du site est émise ICI et non au clic « Envoyer »,
// parce que `finalizeSubmit()` redirige immédiatement et qu'un événement poussé
// juste avant la navigation est une course perdue d'avance avec le navigateur.
// La contrepartie est le double comptage, que ces tests verrouillent.

/**
 * Laisse se vider la file de micro-tâches.
 *
 * Depuis le lot T3, `generate_lead` part APRÈS le hachage SHA-256 des
 * coordonnées, qui passe par la Web Crypto — donc de façon asynchrone. Sans
 * cette attente, le test inspecterait le dataLayer avant que la conversion
 * n'y soit. Elle modélise aussi la réalité : trois chargements successifs de
 * la page, et non trois rendus simultanés.
 */
const attendreConversion = () => new Promise((resolve) => setImmediate(resolve));

/** Événements d'un nom donné parmi ceux poussés dans le dataLayer. */
function evenements(rendu, nom) {
  return rendu.pousses().filter(function (charge) {
    return charge && charge.event === nom;
  });
}

test("mesure — la conversion est émise une fois, et une seule", async () => {
  const donnees = baseLastEstimation({ lead_id: "11111111-2222-4333-8444-555555555555" });
  // Un seul magasin partagé = un seul navigateur, trois chargements de la page
  // (arrivée, rechargement, retour arrière depuis le bfcache).
  const navigateur = new Map();

  const premier = renderReport(donnees, { store: navigateur, mesure: true });
  await attendreConversion();
  const second = renderReport(donnees, { store: navigateur, mesure: true });
  await attendreConversion();
  const troisieme = renderReport(donnees, { store: navigateur, mesure: true });
  await attendreConversion();

  assert.equal(evenements(premier, "generate_lead").length, 1, "arrivée : la conversion compte");
  assert.equal(evenements(second, "generate_lead").length, 0, "rechargement : plus rien");
  assert.equal(evenements(troisieme, "generate_lead").length, 0, "retour arrière : plus rien");

  // `report_view` n'est pas une conversion : chaque affichage du rapport est un
  // affichage, et doit rester compté comme tel.
  for (const rendu of [premier, second, troisieme]) {
    assert.equal(evenements(rendu, "report_view").length, 1);
  }
});

test("mesure — deux estimations distinctes valent deux conversions", async () => {
  const navigateur = new Map();

  const premier = renderReport(
    baseLastEstimation({ lead_id: "aaaaaaaa-1111-4111-8111-111111111111" }),
    { store: navigateur, mesure: true }
  );
  await attendreConversion();
  const second = renderReport(
    baseLastEstimation({ lead_id: "bbbbbbbb-2222-4222-8222-222222222222" }),
    { store: navigateur, mesure: true }
  );
  await attendreConversion();

  assert.equal(evenements(premier, "generate_lead").length, 1);
  assert.equal(
    evenements(second, "generate_lead").length,
    1,
    "le verrou porte sur le lead, pas sur la page"
  );
});

test("mesure — un rapport sans lead_id ne compte aucune conversion", async () => {
  // `lastEstimation` écrit par une version du site antérieure au lot T1 : le
  // rapport s'affiche, mais il n'y a rien à rattacher. Compter à tort serait
  // pire que ne pas compter.
  const rendu = renderReport(baseLastEstimation(), { mesure: true });
  await attendreConversion();

  assert.equal(evenements(rendu, "report_view").length, 1);
  assert.equal(evenements(rendu, "generate_lead").length, 0);
});

test("mesure — la conversion porte sa valeur et sa qualification", async () => {
  const rendu = renderReport(
    baseLastEstimation({ lead_id: "cccccccc-3333-4333-8333-333333333333" }),
    { mesure: true }
  );
  await attendreConversion();

  const conversion = evenements(rendu, "generate_lead")[0];

  assert.equal(conversion.lead_type, "estimation");
  assert.equal(conversion.currency, "EUR");
  assert.equal(conversion.lead_quality, "hot", "propriétaire décidé à vendre");
  assert.equal(conversion.estimation_value, 850000);
  // 100 × 3 (hot) × min(2,5 ; 850 000/250 000) -> le plafond s'applique.
  assert.equal(conversion.value, 750);
  assert.equal(conversion.property_type, "appartement");
  assert.equal(conversion.surface_bucket, "060-089");
  assert.equal(conversion.departement_code, "75");
  assert.equal(conversion.estimation_status, "ok");
});

test("mesure — une estimation non calculée n'invente pas de valeur de bien", async () => {
  const donnees = baseLastEstimation({
    lead_id: "dddddddd-4444-4444-8444-444444444444",
    estimationStatus: "deferred",
    estimation: null,
  });

  const rendu = renderReport(donnees, { mesure: true });
  await attendreConversion();
  const conversion = evenements(rendu, "generate_lead")[0];

  assert.equal("estimation_value" in conversion, false, "aucun prix affiché, aucun prix poussé");
  // Coefficient de bien neutre : 100 × 3 × 1.
  assert.equal(conversion.value, 300);
  assert.equal(conversion.estimation_status, "deferred");
});

test("mesure — aucune donnée personnelle n'accompagne la conversion", async () => {
  // Le garde-fou de bout en bout : `lastEstimation` CONTIENT les coordonnées du
  // prospect (le rapport et le PDF en ont besoin). Rien de tout cela ne doit
  // atteindre le dataLayer, qui est lisible par n'importe quelle extension
  // installée chez le visiteur.
  const donnees = baseLastEstimation({
    lead_id: "eeeeeeee-5555-4555-8555-555555555555",
    name: "Jean Dupont",
    email: "jean.dupont@example.com",
    phone: "0612345678",
    address: "12 rue de la Paix",
  });

  const rendu = renderReport(donnees, { mesure: true });
  await attendreConversion();
  const pousses = JSON.stringify(rendu.pousses());

  for (const secret of ["Jean Dupont", "jean.dupont@example.com", "0612345678", "rue de la Paix"]) {
    assert.equal(
      pousses.indexOf(secret),
      -1,
      `« ${secret} » ne doit jamais transiter par le dataLayer`
    );
  }
});

test("mesure — la conversion porte les empreintes de contact, jamais les coordonnées", async () => {
  const { createHash } = await import("node:crypto");
  const empreinte = (texte) => createHash("sha256").update(texte, "utf8").digest("hex");

  const donnees = baseLastEstimation({
    lead_id: "ffffffff-6666-4666-8666-666666666666",
    email: "Jean.Dupont@Example.com",
    phone: "06 12 34 56 78",
  });

  const rendu = renderReport(donnees, { mesure: true });
  await attendreConversion();

  const conversion = evenements(rendu, "generate_lead")[0];

  // Comparaison champ par champ : l'objet vient du contexte `vm`, son
  // prototype n'est pas celui du realm de test — `deepStrictEqual` le refuse
  // alors même que le contenu est identique.
  //
  // Normalisation Google : minuscules pour l'e-mail, E.164 pour le téléphone.
  // Envoyer « 06 12 34 56 78 » tel quel produirait une empreinte que Google ne
  // rapprocherait de rien — et l'échec serait parfaitement silencieux.
  assert.equal(
    conversion.user_data.sha256_email_address,
    empreinte("jean.dupont@example.com")
  );
  assert.equal(conversion.user_data.sha256_phone_number, empreinte("+33612345678"));
  assert.deepEqual(Object.keys(conversion.user_data).sort(), [
    "sha256_email_address",
    "sha256_phone_number",
  ]);
});

test("mesure — un hachage impossible ne coûte jamais la conversion", async () => {
  // Page servie en HTTP, navigateur ancien : `crypto.subtle` n'existe pas. La
  // conversion doit partir quand même, simplement sans conversion améliorée.
  const donnees = baseLastEstimation({
    lead_id: "99999999-7777-4777-8777-777777777777",
    email: "jean@example.com",
    phone: "0612345678",
  });

  const rendu = renderReport(donnees, { mesure: true, sansWebCrypto: true });
  await attendreConversion();

  const conversions = evenements(rendu, "generate_lead");
  assert.equal(conversions.length, 1, "la conversion part malgré tout");
  assert.equal("user_data" in conversions[0], false);
  assert.equal(conversions[0].value, 750, "et elle porte toujours sa valeur");
});

test("mesure — rien ne part tant que le consentement n'est pas connu", async () => {
  /*
   * DÉFAUT CONSTATÉ EN MODE APERÇU, ET CORRIGÉ ICI.
   *
   * Le choix du visiteur est stocké dans un cookie, mais RÉAPPLIQUÉ à chaque
   * chargement de page, de façon asynchrone — le bandeau charge sa
   * bibliothèque par `import()` dynamique. L'ordre observé était :
   *
   *     défaut « denied » -> report_view -> generate_lead -> consent_update
   *
   * La conversion partait donc toujours sous le défaut refusé, même chez
   * quelqu'un ayant accepté de longue date : balises tierces bloquées à chaque
   * fois, balises Google en mode dégradé, et un diagnostic GTM annonçant
   * « 100 % des signaux refusés ».
   */
  const rendu = renderReport(
    baseLastEstimation({ lead_id: "77777777-8888-4888-8888-888888888888" }),
    { mesure: true, consentementInconnu: true }
  );

  await attendreConversion();

  assert.deepEqual(rendu.pousses(), [], "aucun événement avant que le choix soit connu");

  // Le bandeau finit de charger et restitue le choix mémorisé.
  rendu.sandbox.window.dataLayer.push({ event: "consent_update" });
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(evenements(rendu, "generate_lead").length, 1, "la conversion part ensuite");
});
