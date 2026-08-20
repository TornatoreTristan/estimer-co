#!/usr/bin/env node
/**
 * Vérification de la VISIBILITÉ RÉELLE des boutons de navigation du wizard
 * (`src/pages/estimation.astro` + `src/styles/global.css`).
 *
 * Pourquoi ce fichier existe
 * --------------------------
 * `estimation-wizard.js` masque et révèle `#wizardSubmit` / `#wizardPrev` avec
 * l'attribut `hidden` (`renderNavButtons`), et `scripts/test-estimation-ui.mjs`
 * vérifie que cette bascule est correcte. Elle l'a toujours été. Le bouton
 * « Recevoir mon estimation gratuite » s'affichait pourtant AUX CINQ ÉTAPES.
 *
 * La cause n'était pas dans le JavaScript mais dans la cascade CSS : la règle
 * `[hidden] { display: none }` de la feuille de style du NAVIGATEUR n'a qu'une
 * spécificité de (0,1,0). `#wizardSubmit` porte `.btn` (`display: inline-flex`)
 * et `.btn--block` (`display: flex`) — mêmes (0,1,0) mais déclarées plus tard,
 * donc gagnantes. L'attribut `hidden` était bien posé ; il ne masquait rien.
 *
 * Aucun test JavaScript ne pouvait attraper ça : il n'y a pas de mise en page
 * dans un contexte Node, et `element.hidden === true` reste vrai pendant que
 * l'utilisateur voit le bouton. Ce fichier rejoue donc la CASCADE elle-même —
 * spécificité, `!important` et ordre des sources — sur l'élément tel qu'il est
 * réellement rendu, et vérifie quelle déclaration `display` l'emporte.
 *
 * Portée assumée : le sous-ensemble de CSS que ce site utilise réellement
 * (sélecteurs de type/classe/id/attribut et combinateurs descendants). Un
 * sélecteur qu'il ne sait pas interpréter fait ÉCHOUER le test plutôt que
 * d'être ignoré en silence — un faux négatif serait pire que pas de test.
 *
 * Usage : `node scripts/test-wizard-nav-visibility.mjs`
 *         (ou `npm run test:wizard-nav`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GLOBAL_CSS_PATH = path.join(__dirname, "..", "src", "styles", "global.css");
const ESTIMATION_PAGE_PATH = path.join(__dirname, "..", "src", "pages", "estimation.astro");

const GLOBAL_CSS = readFileSync(GLOBAL_CSS_PATH, "utf8");
const ESTIMATION_PAGE = readFileSync(ESTIMATION_PAGE_PATH, "utf8");

// ============================================================================
// 1. Un mini-moteur de cascade (le strict nécessaire)
// ============================================================================

/** Retire les commentaires `/* ... *\/`, qui fausseraient le découpage en règles. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Découpe une feuille en règles `{selectorList, declarations}`.
 *
 * `[^{}]+` ne peut pas franchir une accolade : les blocs `@media` ne sont donc
 * jamais confondus avec une règle, et leurs règles internes sont extraites
 * telles quelles. C'est le comportement voulu ici — une règle sous media query
 * reste une règle susceptible de s'appliquer.
 */
function parseRules(css, source) {
  const rules = [];
  const RULE = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = RULE.exec(stripComments(css))) !== null) {
    const selectorList = match[1].trim();
    if (!selectorList || selectorList.startsWith("@")) continue;
    rules.push({ selectorList, declarations: match[2], source, order: rules.length });
  }
  return rules;
}

/** Dernière valeur déclarée pour `property`, avec son drapeau `!important`. */
function readDeclaration(declarations, property) {
  const DECL = new RegExp("(?:^|;)\\s*" + property + "\\s*:([^;]+)", "gi");
  let match;
  let found = null;
  while ((match = DECL.exec(declarations)) !== null) {
    const raw = match[1].trim();
    const important = /!important\s*$/i.test(raw);
    found = { value: raw.replace(/\s*!important\s*$/i, "").trim(), important };
  }
  return found;
}

/**
 * Découpe un sélecteur composé (`button.btn[hidden]`) en ses parties.
 * Lève sur toute syntaxe hors du sous-ensemble supporté : mieux vaut un test
 * qui casse bruyamment qu'un test qui approuve ce qu'il n'a pas compris.
 */
function parseCompound(compound) {
  const parts = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
  const TOKEN = /^(?:([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([^\]]+)\]|(::?[\w-]+(?:\([^)]*\))?))/;
  let rest = compound;
  while (rest.length) {
    const match = TOKEN.exec(rest);
    if (!match) throw new Error("Sélecteur non supporté par ce test : " + compound);
    if (match[1]) parts.tag = match[1].toLowerCase();
    else if (match[2]) parts.id = match[2];
    else if (match[3]) parts.classes.push(match[3]);
    else if (match[4]) parts.attrs.push(match[4].trim());
    else parts.pseudos.push(match[5]);
    rest = rest.slice(match[0].length);
  }
  return parts;
}

/** Un sélecteur composé décrit-il cet élément ? */
function compoundMatches(compound, element) {
  const parts = parseCompound(compound);

  // Pseudo-CLASSES d'interaction (`:hover`, `:active`, `:focus`) et
  // pseudo-ÉLÉMENTS (`::after`) : hors état statique, jamais applicables ici.
  if (parts.pseudos.length) return false;

  if (parts.tag && parts.tag !== element.tag) return false;
  if (parts.id && parts.id !== element.id) return false;
  if (parts.classes.some((cls) => !element.classes.includes(cls))) return false;

  return parts.attrs.every((attr) => {
    const nameMatch = /^([\w-]+)/.exec(attr);
    const name = nameMatch ? nameMatch[1] : attr;
    const valueMatch = /=\s*['"]?([^'"\]]*)['"]?$/.exec(attr);
    if (!Object.prototype.hasOwnProperty.call(element.attrs, name)) return false;
    return valueMatch ? element.attrs[name] === valueMatch[1] : true;
  });
}

/**
 * Un sélecteur complet (combinateurs descendants uniquement) décrit-il cet
 * élément, placé sous `ancestors` (du plus proche au plus lointain) ?
 */
function selectorMatches(selector, element, ancestors) {
  if (/[>+~]/.test(selector)) return false; // non utilisés sur ce composant.
  const compounds = selector.trim().split(/\s+/);
  const last = compounds.pop();
  if (!compoundMatches(last, element)) return false;

  let pool = ancestors.slice();
  for (let i = compounds.length - 1; i >= 0; i--) {
    const index = pool.findIndex((ancestor) => compoundMatches(compounds[i], ancestor));
    if (index === -1) return false;
    pool = pool.slice(index + 1);
  }
  return true;
}

/** Spécificité CSS `[ids, classes+attributs+pseudo-classes, types]`. */
function specificity(selector) {
  let a = 0;
  let b = 0;
  let c = 0;
  selector
    .trim()
    .split(/\s+/)
    .forEach((compound) => {
      const parts = parseCompound(compound);
      if (parts.id) a += 1;
      b += parts.classes.length + parts.attrs.length;
      parts.pseudos.forEach((pseudo) => {
        if (pseudo.startsWith("::")) c += 1;
        else b += 1;
      });
      if (parts.tag) c += 1;
    });
  return [a, b, c];
}

function compareCascade(x, y) {
  if (x.important !== y.important) return x.important ? 1 : -1;
  for (let i = 0; i < 3; i++) {
    if (x.specificity[i] !== y.specificity[i]) return x.specificity[i] - y.specificity[i];
  }
  if (x.sourceRank !== y.sourceRank) return x.sourceRank - y.sourceRank;
  return x.order - y.order;
}

/**
 * Valeur de `property` qui l'emporte réellement sur `element`.
 *
 * `sheets` est ordonné comme le navigateur les reçoit. La feuille du navigateur
 * (`ua`) vient donc en premier — c'est elle qui porte `[hidden] { display: none }`,
 * et c'est très exactement sa faiblesse qui a produit le défaut.
 */
function computedDisplay(sheets, element, ancestors) {
  const candidates = [];
  sheets.forEach((sheet, sourceRank) => {
    sheet.rules.forEach((rule) => {
      const declaration = readDeclaration(rule.declarations, "display");
      if (!declaration) return;
      rule.selectorList.split(",").forEach((selector) => {
        if (!selectorMatches(selector, element, ancestors)) return;
        candidates.push({
          value: declaration.value,
          important: declaration.important,
          specificity: specificity(selector),
          sourceRank,
          order: rule.order,
          origin: sheet.name,
          selector: selector.trim(),
        });
      });
    });
  });
  if (!candidates.length) return null;
  return candidates.sort(compareCascade)[candidates.length - 1];
}

// ============================================================================
// 2. Les feuilles et l'élément, tels qu'ils existent réellement
// ============================================================================

/**
 * Feuille de style du navigateur, réduite à ce qui compte ici. C'est bien la
 * SEULE origine de `[hidden] { display: none }` tant qu'aucune feuille du site
 * ne la reprend : la reproduire explicitement est ce qui rend le test capable
 * de constater sa défaite face à `.btn`.
 */
const UA_SHEET = {
  name: "navigateur",
  rules: parseRules("[hidden] { display: none } button { display: inline-block }", "ua"),
};

/** Bloc `<style>` de la page (Astro scope avec `:where()`, sans effet sur la spécificité). */
function pageStyle(source) {
  const match = /<style>([\s\S]*?)<\/style>/.exec(source);
  assert.ok(match, "bloc <style> introuvable dans estimation.astro");
  return match[1];
}

const SHEETS = [
  UA_SHEET,
  { name: "global.css", rules: parseRules(GLOBAL_CSS, "global") },
  { name: "estimation.astro", rules: parseRules(pageStyle(ESTIMATION_PAGE), "page") },
];

/** `<div class="wizard-nav">` -> `<form id="estimationForm">` -> ... */
const NAV_ANCESTORS = [
  { tag: "div", id: null, classes: ["wizard-nav"], attrs: {} },
  { tag: "form", id: "estimationForm", classes: [], attrs: { novalidate: "" } },
  { tag: "div", id: null, classes: ["form-card"], attrs: {} },
];

const SUBMIT_BUTTON = {
  tag: "button",
  id: "wizardSubmit",
  classes: ["btn", "btn--primary", "btn--lg", "btn--block"],
  attrs: { type: "submit", hidden: "" },
};

const SUBMIT_BUTTON_VISIBLE = {
  ...SUBMIT_BUTTON,
  attrs: { type: "submit" }, // dernière étape : `renderNavButtons` a retiré `hidden`.
};

const PREV_BUTTON = {
  tag: "button",
  id: "wizardPrev",
  classes: ["btn", "btn--outline"],
  attrs: { type: "button", hidden: "" },
};

// ============================================================================
// 3. Le moteur doit être crédible avant de servir de garde-fou
// ============================================================================

test("moteur — sans règle `[hidden]` côté site, `.btn` gagne (le défaut d'origine)", () => {
  // Reconstitution de l'état AVANT correctif : global.css ne contient pas de
  // règle `[hidden]`. Si ce test cessait de démontrer la défaite, c'est que le
  // moteur ne mesure plus rien.
  const brokenSheets = [
    UA_SHEET,
    { name: "global.css (avant correctif)", rules: parseRules(".btn { display: inline-flex }") },
  ];
  const winner = computedDisplay(brokenSheets, SUBMIT_BUTTON, NAV_ANCESTORS);
  assert.equal(winner.value, "inline-flex");
  assert.equal(winner.origin, "global.css (avant correctif)");
});

test("moteur — spécificité et `!important` calculés correctement", () => {
  assert.deepEqual(specificity("[hidden]"), [0, 1, 0]);
  assert.deepEqual(specificity(".btn"), [0, 1, 0]);
  assert.deepEqual(specificity(".wizard-nav #wizardSubmit"), [1, 1, 0]);
  assert.deepEqual(specificity("button.btn--block"), [0, 1, 1]);
  assert.equal(readDeclaration("display: none !important", "display").important, true);
  assert.equal(readDeclaration("display: flex", "display").important, false);
});

test("moteur — combinateur descendant résolu contre les vrais ancêtres", () => {
  assert.equal(selectorMatches(".wizard-nav #wizardSubmit", SUBMIT_BUTTON, NAV_ANCESTORS), true);
  assert.equal(selectorMatches(".quote #wizardSubmit", SUBMIT_BUTTON, NAV_ANCESTORS), false);
});

// ============================================================================
// 4. La régression elle-même
// ============================================================================

test("#wizardSubmit avec `hidden` est RÉELLEMENT masqué (étapes 1 à 4)", () => {
  const winner = computedDisplay(SHEETS, SUBMIT_BUTTON, NAV_ANCESTORS);
  assert.ok(winner, "aucune règle `display` ne s'applique au bouton d'envoi");
  assert.equal(
    winner.value,
    "none",
    `le bouton d'envoi reste visible : c'est « ${winner.selector} » ` +
      `(${winner.origin}) qui l'emporte avec « display: ${winner.value} »`
  );
});

test("#wizardPrev avec `hidden` est RÉELLEMENT masqué (étape 1)", () => {
  // Même défaut, même cause : `.btn` bat `[hidden]`. Il passait inaperçu parce
  // qu'un « Précédent » à l'étape 1 choque moins qu'un bouton d'envoi.
  const winner = computedDisplay(SHEETS, PREV_BUTTON, NAV_ANCESTORS);
  assert.equal(winner.value, "none");
});

test("sans `hidden`, le bouton d'envoi redevient visible (étape finale)", () => {
  // Le pendant indispensable : une règle qui masquerait le bouton en toutes
  // circonstances ferait passer le test précédent tout en cassant le tunnel.
  const winner = computedDisplay(SHEETS, SUBMIT_BUTTON_VISIBLE, NAV_ANCESTORS);
  assert.equal(winner.value, "flex", "`.btn--block` doit reprendre la main sans `hidden`");
});

test("la règle `[hidden]` est globale, pas un rustine par composant", () => {
  // Trois `.x[hidden] { display: none }` avaient déjà été ajoutés au coup par
  // coup (`.optional-block`, `.wizard-submit-status`, `.field-row`) : la preuve
  // que le défaut avait été rencontré trois fois sans être diagnostiqué. La
  // règle doit vivre dans global.css pour couvrir tous les composants à venir.
  const rules = parseRules(GLOBAL_CSS, "global").filter(
    (rule) => rule.selectorList.trim() === "[hidden]"
  );
  assert.equal(rules.length, 1, "global.css doit porter exactement une règle `[hidden]`");
  const declaration = readDeclaration(rules[0].declarations, "display");
  assert.equal(declaration.value, "none");
  assert.equal(
    declaration.important,
    true,
    "`!important` est nécessaire : `[hidden]` (0,1,0) ne bat pas `.btn` (0,1,0) déclarée après"
  );
});

// ============================================================================
// 5. L'état initial rendu par le serveur
// ============================================================================

test("estimation.astro rend #wizardSubmit et #wizardPrev avec `hidden`", () => {
  // Sans JavaScript (ou avant son exécution), le formulaire ne doit pas
  // afficher le bouton d'envoi de l'étape 5 au-dessus de l'étape 1.
  const submit = /<button[^>]*id="wizardSubmit"[^>]*>/.exec(ESTIMATION_PAGE);
  assert.ok(submit, "#wizardSubmit introuvable dans la page");
  assert.match(submit[0], /\shidden\b/);

  const prev = /<button[^>]*id="wizardPrev"[^>]*>/.exec(ESTIMATION_PAGE);
  assert.ok(prev, "#wizardPrev introuvable dans la page");
  assert.match(prev[0], /\shidden\b/);

  // `#wizardNext`, lui, est visible au chargement : c'est le seul bouton
  // attendu à l'étape 1.
  const next = /<button[^>]*id="wizardNext"[^>]*>/.exec(ESTIMATION_PAGE);
  assert.ok(next, "#wizardNext introuvable dans la page");
  assert.doesNotMatch(next[0], /\shidden\b/);
});
