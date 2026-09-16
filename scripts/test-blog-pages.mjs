#!/usr/bin/env node
/**
 * Vérification de bout en bout du blog SEO (specs/blog-seo.md §3, critères
 * d'acceptation), en inspectant directement le résultat d'un `astro build` —
 * la seule façon de vérifier ce que le build produit réellement (routes
 * générées, contenu du `<head>`, JSON-LD, sitemap), à la différence de
 * `scripts/test-blog-content.mjs` qui ne couvre que les fonctions pures de
 * `src/lib/blog.ts` et les règles de `scripts/validate-content.mjs`.
 *
 * ---------------------------------------------------------------------------
 * Dépendance à un build — choix documenté (revu après retour QA)
 * ---------------------------------------------------------------------------
 * Aucun autre test du dépôt n'inspecte une sortie de build (tous testent des
 * modules ou des scripts source directement). Ce fichier introduit donc le
 * premier précédent, avec deux garanties non négociables :
 *
 * 1. Le build est TOUJOURS relancé, à chaque exécution de ce fichier — jamais
 *    la réutilisation d'un `dist/` existant. Un `dist/` périmé (contenu ou
 *    composant modifié depuis le dernier build) ferait sinon passer des
 *    régressions réelles : démontré par le QA en cassant volontairement
 *    `SeoHead.astro` sans reconstruire, les 18 tests restaient verts.
 * 2. Ce build ne touche jamais le `dist/` du développeur ni celui d'une autre
 *    exécution concurrente : il est produit dans un dossier temporaire dédié
 *    (`astro build --outDir <tmp>`, flag confirmé disponible dans cette
 *    version — `astro build --help`), créé avec `fs.mkdtempSync` et supprimé
 *    à la sortie du process (`process.on('exit', ...)`, qui couvre aussi bien
 *    la fin normale des tests qu'un échec du build lui-même avant que
 *    `node:test` n'ait rien pu exécuter).
 *
 * Conséquence assumée : ce test ajoute la durée d'un `astro build` complet à
 * chaque exécution (le sien, et celle de `npm test` qui l'enchaîne avec une
 * douzaine d'autres suites) — c'est le prix de la garantie ci-dessus, pas un
 * oubli d'optimisation.
 *
 * `--outDir` isole la SORTIE du build (ce que ce fichier lit), mais pas tout
 * : Astro 7 écrit aussi un dossier de travail intermédiaire fixe,
 * `<racine du projet>/.astro/.prerender/`, JAMAIS déplacé par `--outDir`
 * (vérifié dans `node_modules/astro/dist/core/config/schemas/relative.js` :
 * `build.server` n'est recalculé sous le `outDir` personnalisé qu'au moment
 * où le fichier de config est évalué, pas depuis le flag CLI). Deux
 * `astro build` lancés en parallèle dans ce même dépôt (ce fichier ET
 * `scripts/test-consent-banner.mjs`, qui construit aussi via un `--outDir`
 * temporaire) se marchent donc dessus sur ce dossier partagé
 * (`ENOTEMPTY`/modules introuvables, constaté en CI). C'est pourquoi le
 * script `test` de `package.json` force `--test-concurrency=1` : tant qu'un
 * deuxième test buildera le site en parallèle de celui-ci, node:test doit
 * les exécuter en série, pas en isolant chaque fichier via son seul
 * `--outDir`.
 *
 * Le build interne passe `ESTIMATION_ALLOW_NO_API=1` : en CI, l'étape Test
 * tourne avant l'étape Build (`.github/workflows/site.yml`), donc avant que
 * `.env`/`PUBLIC_API_URL` n'existe. Sans ce répli explicite, le garde-fou de
 * `astro.config.mjs` (déploiement en repli statique silencieux, cf. son
 * commentaire) ferait échouer CE build interne — et donc tout `npm test` —
 * indépendamment de la variable d'environnement réelle du poste qui lance le
 * test. Le garde-fou original continue de s'appliquer tel quel au VRAI build
 * de déploiement (`npm run build`, sans cette variable).
 *
 * Usage : `node --test scripts/test-blog-pages.mjs` (ou `npm run test:blog-pages`).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';

import { CATEGORIES, getArticleUrl, getCategoryUrl } from '../src/lib/blog.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

const DIST = mkdtempSync(join(tmpdir(), 'estimer-blog-pages-'));

// Filet de sécurité universel : couvre la fin normale des tests comme un
// build qui échouerait avant même que `node:test` ait pu enregistrer un hook
// `after()`. `rmSync` est synchrone, seule forme de nettoyage fiable dans un
// gestionnaire `exit`.
process.on('exit', () => {
  rmSync(DIST, { recursive: true, force: true });
});

console.log(`[test-blog-pages] build isolé dans ${DIST}…`);
execFileSync(join(ROOT, 'node_modules/.bin/astro'), ['build', '--outDir', DIST], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, ESTIMATION_ALLOW_NO_API: '1' },
});

// -----------------------------------------------------------------------------
// Lecture directe de src/content/articles/ (même technique que
// scripts/validate-content.mjs) — sert de référence indépendante à comparer
// au contenu réel de dist/, plutôt que de recopier des slugs en dur.
// -----------------------------------------------------------------------------

function readArticleSources() {
  const dir = join(ROOT, 'src/content/articles');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((filename) => {
      const raw = readFileSync(join(dir, filename), 'utf8');
      const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
      const data = match ? (parseYaml(match[1]) ?? {}) : {};
      return { filename, data };
    });
}

const articleSources = readArticleSources();
const publishedArticles = articleSources.filter((a) => a.data.statut === 'publie');
const draftArticles = articleSources.filter((a) => a.data.statut !== 'publie');

function readDist(relPath) {
  return readFileSync(join(DIST, relPath), 'utf8');
}

function distExists(relPath) {
  return existsSync(join(DIST, relPath));
}

/** Extrait tous les blocs JSON-LD d'une page HTML, déjà parsés. */
function extractJsonLd(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  return blocks.map((m) => JSON.parse(m[1].replace(/\\u003c/g, '<')));
}

// -----------------------------------------------------------------------------
// 1. Pages générées : l'article pilier et les 5 silos.
// -----------------------------------------------------------------------------

test('la page /blog/ est générée', () => {
  assert.ok(distExists('blog/index.html'));
});

test('les 5 silos sont générés, y compris ceux sans article publié', () => {
  for (const category of CATEGORIES) {
    const path = getCategoryUrl(category.slug).replace(/^\//, '') + 'index.html';
    assert.ok(distExists(path), `silo manquant : ${category.slug}`);
  }
});

test("l'article pilier publié est généré à son URL", () => {
  const article = publishedArticles.find(
    (a) => a.data.slug === 'comment-estimer-son-bien-immobilier-guide-complet'
  );
  assert.ok(article, "l'article pilier est introuvable dans src/content/articles/");
  const path = getArticleUrl(article.data.categorie, article.data.slug).replace(/^\//, '') + 'index.html';
  assert.ok(distExists(path));
});

// -----------------------------------------------------------------------------
// 2. Aucune page pour les brouillons — vérification générique : l'ensemble
// des dossiers d'article présents dans dist/blog/<categorie>/ doit
// correspondre exactement à l'ensemble des slugs publiés, jamais aux
// brouillons.
// -----------------------------------------------------------------------------

test('aucune page générée pour un article brouillon', () => {
  for (const draft of draftArticles) {
    if (!draft.data.categorie || !draft.data.slug) continue;
    const path =
      getArticleUrl(draft.data.categorie, draft.data.slug).replace(/^\//, '') + 'index.html';
    assert.ok(!distExists(path), `page générée pour un brouillon : ${draft.filename}`);
  }
});

test('dist/blog/<categorie>/ ne contient que des slugs publiés', () => {
  for (const category of CATEGORIES) {
    const dir = join(DIST, 'blog', category.slug);
    if (!existsSync(dir)) continue;
    const generatedSlugs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const expectedSlugs = publishedArticles
      .filter((a) => a.data.categorie === category.slug)
      .map((a) => a.data.slug);
    assert.deepEqual(generatedSlugs.sort(), expectedSlugs.sort(), `silo ${category.slug}`);
  }
});

// -----------------------------------------------------------------------------
// 3. SEO transverse de l'article pilier : title, meta, canonical, og:type.
// -----------------------------------------------------------------------------

const pilierSource = publishedArticles.find(
  (a) => a.data.slug === 'comment-estimer-son-bien-immobilier-guide-complet'
);
const pilierPath =
  getArticleUrl(pilierSource.data.categorie, pilierSource.data.slug).replace(/^\//, '') + 'index.html';
const pilierHtml = readDist(pilierPath);
const pilierUrl = `https://estimer.co${getArticleUrl(pilierSource.data.categorie, pilierSource.data.slug)}`;

test('<title> reprend metaTitle', () => {
  const expected = pilierSource.data.metaTitle ?? pilierSource.data.title;
  assert.match(pilierHtml, new RegExp(`<title>${escapeRegExp(expected)}</title>`));
});

test('meta description reprend metaDescription', () => {
  assert.match(
    pilierHtml,
    new RegExp(`<meta name="description" content="${escapeRegExp(pilierSource.data.metaDescription)}"`)
  );
});

test('canonical absolu, terminé par un slash', () => {
  assert.match(pilierHtml, new RegExp(`<link rel="canonical" href="${escapeRegExp(pilierUrl)}"`));
  assert.ok(pilierUrl.endsWith('/'));
});

test('og:type vaut "article"', () => {
  assert.match(pilierHtml, /<meta property="og:type" content="article"/);
});

test('article:published_time et article:modified_time sont présents', () => {
  assert.match(pilierHtml, /<meta property="article:published_time" content="[^"]+"/);
  assert.match(pilierHtml, /<meta property="article:modified_time" content="[^"]+"/);
});

// -----------------------------------------------------------------------------
// 4. Données structurées : Article, BreadcrumbList, FAQPage.
// -----------------------------------------------------------------------------

const pilierJsonLd = extractJsonLd(pilierHtml);

test('JSON-LD Article complet', () => {
  const article = pilierJsonLd.find((block) => block['@type'] === 'Article');
  assert.ok(article, 'aucun bloc JSON-LD @type=Article trouvé');
  assert.equal(article.headline, pilierSource.data.title);
  assert.ok(article.datePublished);
  assert.ok(article.dateModified);
  // `auteur` a une valeur par défaut posée par le schéma Zod
  // (src/content.config.ts), absente de la lecture "brute" du frontmatter
  // ci-dessus si le champ n'est pas renseigné dans le fichier source.
  assert.equal(article.author.name, pilierSource.data.auteur ?? 'Équipe RITMODiag');
  assert.equal(article.publisher.name, 'RITMODiag');
  assert.ok(article.publisher.logo.url);
  assert.ok(article.image);
  assert.equal(article.mainEntityOfPage['@id'], pilierUrl);
});

test("JSON-LD BreadcrumbList complet, identique au fil d'ariane", () => {
  const breadcrumb = pilierJsonLd.find((block) => block['@type'] === 'BreadcrumbList');
  assert.ok(breadcrumb, 'aucun bloc JSON-LD @type=BreadcrumbList trouvé');
  assert.equal(breadcrumb.itemListElement.length, 4); // Accueil > Blog > Silo > Article
  assert.equal(breadcrumb.itemListElement[0].name, 'Accueil');
  assert.equal(breadcrumb.itemListElement[1].name, 'Blog');
  assert.equal(breadcrumb.itemListElement.at(-1).item, pilierUrl);
});

test('JSON-LD FAQPage présent (faq non vide dans le frontmatter)', () => {
  assert.ok(Array.isArray(pilierSource.data.faq) && pilierSource.data.faq.length > 0);
  const faqPage = pilierJsonLd.find((block) => block['@type'] === 'FAQPage');
  assert.ok(faqPage, 'aucun bloc JSON-LD @type=FAQPage trouvé');
  assert.equal(faqPage.mainEntity.length, pilierSource.data.faq.length);
});

// -----------------------------------------------------------------------------
// 5. Sitemap : /blog/, les silos et l'article, jamais un brouillon.
// -----------------------------------------------------------------------------

test('le sitemap contient /blog/ et l\'article pilier', () => {
  const sitemap = readDist('sitemap-0.xml');
  assert.match(sitemap, /<loc>https:\/\/estimer\.co\/blog\/<\/loc>/);
  assert.match(sitemap, new RegExp(`<loc>${escapeRegExp(pilierUrl)}</loc>`));
});

test('robots.txt référence le sitemap-index', () => {
  const robots = readFileSync(join(ROOT, 'public/robots.txt'), 'utf8');
  assert.match(robots, /Sitemap:\s*https:\/\/estimer\.co\/sitemap-index\.xml/);
});

// -----------------------------------------------------------------------------
// 6. État vide d'un silo sans article publié.
// -----------------------------------------------------------------------------

test("un silo sans article publié affiche l'état vide avec un CTA vers /estimation/", () => {
  const emptyCategory = CATEGORIES.find(
    (c) => !publishedArticles.some((a) => a.data.categorie === c.slug)
  );
  assert.ok(emptyCategory, 'aucun silo vide à tester (tous les silos ont un article publié)');
  const html = readDist(getCategoryUrl(emptyCategory.slug).replace(/^\//, '') + 'index.html');
  assert.match(html, /Bientôt de nouveaux contenus/);
  assert.match(html, /href="\/estimation\/"/);
});

// -----------------------------------------------------------------------------
// 7. 404.
// -----------------------------------------------------------------------------

test('dist/404.html existe', () => {
  assert.ok(distExists('404.html'));
});

test('404.html est en noindex et sans canonical', () => {
  const html = readDist('404.html');
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
  assert.doesNotMatch(html, /<link rel="canonical"/);
});

// -----------------------------------------------------------------------------
// 8. Lien « Blog » dans le Header.
// -----------------------------------------------------------------------------

test('le lien Blog est présent dans le header de la page d\'accueil', () => {
  const home = readDist('index.html');
  assert.match(home, /<nav class="site-nav"[\s\S]*?<a href="\/blog\/"[^>]*>\s*Blog\s*<\/a>[\s\S]*?<\/nav>/);
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
