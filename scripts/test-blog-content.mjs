#!/usr/bin/env node
/**
 * Vérification autonome de l'infrastructure « backend » du blog SEO
 * (specs/blog-seo.md), scindée en deux parties :
 *
 *   1. `src/lib/blog.ts` : le tri des articles d'un silo (`ordreAffichage`
 *      croissant puis `datePublication` décroissante), le filtre des
 *      articles publiés, et la construction des URLs `/blog/<categorie>/` et
 *      `/blog/<categorie>/<slug>/`. Fonctions pures, importées directement
 *      (Node exécute nativement les modules TypeScript sans transpilation
 *      côté projet — mêmes garanties qu'à l'exécution dans Astro).
 *   2. `scripts/validate-content.mjs` : les règles propres à la collection
 *      `articles` que Zod ne peut pas exprimer — unicité globale des slugs,
 *      `articlesLies` pointant vers des slugs existants, `dateMiseAJour` >=
 *      `datePublication`, gate de publication, et l'avertissement non
 *      bloquant sous 2 liens internes. Le module est importé (pas exécuté en
 *      sous-processus) : voir la garde `if (process.argv[1] === ...)` en bas
 *      de `validate-content.mjs`, qui empêche `main()` (lecture du vrai
 *      `src/content/`, `process.exit`) de s'exécuter à l'import.
 *
 * Usage : `node --test scripts/test-blog-content.mjs` (ou `npm run test:blog`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORIES,
  BLOG_INDEX_URL,
  getCategory,
  isCategorieSlug,
  getCategoryUrl,
  getArticleUrl,
  sortArticles,
  isPublished,
  filterPublished,
  getPublishedSortedArticles,
} from '../src/lib/blog.ts';

import {
  RESERVED_PAGE_SLUGS,
  issues,
  resetIssues,
  countInternalLinks,
  checkSlugUniqueness,
  checkArticlesLies,
  checkArticleGate,
} from './validate-content.mjs';
import { AUTEURS, AUTEUR_IDS, AUTEUR_PAR_DEFAUT, getAuteur } from '../src/lib/auteurs.ts';

// -----------------------------------------------------------------------------
// src/lib/blog.ts — catégories
// -----------------------------------------------------------------------------

test('CATEGORIES expose les 5 silos, dans l\'ordre des specs', () => {
  assert.deepEqual(
    CATEGORIES.map((c) => c.slug),
    ['estimation-immobiliere', 'prix-immobilier', 'vendre', 'dpe-travaux', 'villes']
  );
  for (const category of CATEGORIES) {
    assert.ok(category.label.length > 0, `label manquant pour ${category.slug}`);
    assert.ok(category.description.length > 0, `description manquante pour ${category.slug}`);
  }
});

test('getCategory retrouve un silo connu et renvoie undefined sinon', () => {
  assert.equal(getCategory('vendre')?.label, 'Vendre son bien');
  assert.equal(getCategory('inconnu'), undefined);
});

test('isCategorieSlug distingue les 5 slugs valides du reste', () => {
  assert.equal(isCategorieSlug('dpe-travaux'), true);
  assert.equal(isCategorieSlug('recettes-de-cuisine'), false);
});

// -----------------------------------------------------------------------------
// src/lib/blog.ts — URLs
// -----------------------------------------------------------------------------

test('BLOG_INDEX_URL, getCategoryUrl et getArticleUrl se terminent par "/"', () => {
  assert.equal(BLOG_INDEX_URL, '/blog/');
  assert.equal(getCategoryUrl('vendre'), '/blog/vendre/');
  assert.equal(
    getArticleUrl('estimation-immobiliere', 'comment-estimer-son-bien-immobilier-guide-complet'),
    '/blog/estimation-immobiliere/comment-estimer-son-bien-immobilier-guide-complet/'
  );
});

// -----------------------------------------------------------------------------
// src/lib/blog.ts — tri et filtre
// -----------------------------------------------------------------------------

function article(overrides) {
  return {
    slug: 'a',
    categorie: 'vendre',
    statut: 'publie',
    ...overrides,
  };
}

test('sortArticles trie par ordreAffichage croissant puis datePublication décroissante', () => {
  const articles = [
    article({ slug: 'c', ordreAffichage: 2, datePublication: '2026-01-01' }),
    article({ slug: 'a', ordreAffichage: 1, datePublication: '2025-01-01' }),
    article({ slug: 'b', ordreAffichage: 1, datePublication: '2026-06-01' }),
  ];

  assert.deepEqual(
    sortArticles(articles).map((a) => a.slug),
    ['b', 'a', 'c']
  );
});

test('sortArticles relègue en fin de liste les articles sans ordreAffichage', () => {
  const articles = [
    article({ slug: 'sans-ordre', datePublication: '2026-01-01' }),
    article({ slug: 'avec-ordre', ordreAffichage: 5, datePublication: '2020-01-01' }),
  ];

  assert.deepEqual(
    sortArticles(articles).map((a) => a.slug),
    ['avec-ordre', 'sans-ordre']
  );
});

test('sortArticles ne mute pas le tableau reçu', () => {
  const articles = [article({ slug: 'x', ordreAffichage: 2 }), article({ slug: 'y', ordreAffichage: 1 })];
  const original = [...articles];
  sortArticles(articles);
  assert.deepEqual(articles, original);
});

test('isPublished / filterPublished écartent les brouillons', () => {
  const publie = article({ slug: 'publie', statut: 'publie' });
  const brouillon = article({ slug: 'brouillon', statut: 'brouillon' });

  assert.equal(isPublished(publie), true);
  assert.equal(isPublished(brouillon), false);
  assert.deepEqual(filterPublished([publie, brouillon]).map((a) => a.slug), ['publie']);
});

test('getPublishedSortedArticles combine filtre des publiés et tri du silo', () => {
  const articles = [
    article({ slug: 'brouillon', statut: 'brouillon', ordreAffichage: 1 }),
    article({ slug: 'second', statut: 'publie', ordreAffichage: 2 }),
    article({ slug: 'premier', statut: 'publie', ordreAffichage: 1 }),
  ];

  assert.deepEqual(
    getPublishedSortedArticles(articles).map((a) => a.slug),
    ['premier', 'second']
  );
});

// -----------------------------------------------------------------------------
// scripts/validate-content.mjs — règles propres aux articles
// -----------------------------------------------------------------------------

function entry(overrides) {
  return {
    collection: 'articles',
    filename: `${overrides.data?.slug ?? 'article'}.md`,
    relPath: `src/content/articles/${overrides.data?.slug ?? 'article'}.md`,
    data: {},
    body: '',
    ...overrides,
  };
}

test('RESERVED_PAGE_SLUGS contient "blog" (nouvelle racine de routes)', () => {
  assert.ok(RESERVED_PAGE_SLUGS.has('blog'));
});

test('countInternalLinks compte les liens markdown vers /estimation/ et /blog/', () => {
  const body = [
    'Texte avec un lien vers [estimation](/estimation/) puis un autre.',
    'Encore [un silo](/blog/vendre/) et [un lien externe](https://example.com/estimation/) ignoré,',
    'et [un lien absolu du site](https://estimer.co/estimation/) qui compte.',
  ].join('\n');

  assert.equal(countInternalLinks(body), 3);
});

test('countInternalLinks renvoie 0 si aucun lien interne', () => {
  assert.equal(countInternalLinks('Aucun lien ici, juste du texte.'), 0);
});

test('checkSlugUniqueness ajoute une erreur par doublon de slug, aucune sinon', () => {
  resetIssues();
  checkSlugUniqueness(
    [
      entry({ data: { slug: 'a' } }),
      entry({ data: { slug: 'b' } }),
      { ...entry({ data: { slug: 'a' } }), relPath: 'src/content/articles/autre-a.md' },
    ],
    'articles'
  );
  const slugErrors = issues.filter((i) => i.field === 'slug' && i.level === 'error');
  assert.equal(slugErrors.length, 2, "les deux fichiers en conflit doivent chacun porter l'erreur");

  resetIssues();
  checkSlugUniqueness([entry({ data: { slug: 'a' } }), entry({ data: { slug: 'b' } })], 'articles');
  assert.equal(issues.length, 0);
});

test('checkArticlesLies : erreur bloquante si publié, avertissement si brouillon', () => {
  resetIssues();
  const existant = entry({ data: { slug: 'existant', statut: 'publie' } });
  const publiePendant = entry({
    data: { slug: 'publie-pendant', statut: 'publie', articlesLies: ['existant', 'fantome'] },
  });
  const brouillonPendant = entry({
    data: { slug: 'brouillon-pendant', statut: 'brouillon', articlesLies: ['fantome'] },
  });

  checkArticlesLies([existant, publiePendant, brouillonPendant]);

  const forPublie = issues.find((i) => i.file === publiePendant.relPath);
  const forBrouillon = issues.find((i) => i.file === brouillonPendant.relPath);
  assert.equal(forPublie.level, 'error');
  assert.equal(forBrouillon.level, 'warning');
  assert.equal(issues.filter((i) => i.file === existant.relPath).length, 0);
});

test('checkArticlesLies ne signale rien quand tous les slugs référencés existent', () => {
  resetIssues();
  const a = entry({ data: { slug: 'a', statut: 'publie', articlesLies: ['b'] } });
  const b = entry({ data: { slug: 'b', statut: 'publie' } });
  checkArticlesLies([a, b]);
  assert.equal(issues.length, 0);
});

const CORPS_VALIDE = 'Paragraphe de contenu. '.repeat(80); // largement > 1200 caractères

test('checkArticleGate : article publié complet ne lève aucune erreur bloquante', () => {
  resetIssues();
  checkArticleGate(
    entry({
      data: {
        slug: 'complet',
        statut: 'publie',
        metaDescription: 'a'.repeat(60),
        extrait: 'a'.repeat(60),
        datePublication: '2026-01-01',
        dateMiseAJour: '2026-02-01',
      },
      body: `${CORPS_VALIDE} [lien 1](/estimation/) et [lien 2](/blog/vendre/)`,
    })
  );
  assert.equal(issues.filter((i) => i.level === 'error').length, 0);
  assert.equal(issues.filter((i) => i.level === 'warning').length, 0);
});

test('checkArticleGate : champs "pour publier" manquants -> erreurs bloquantes', () => {
  resetIssues();
  checkArticleGate(entry({ data: { slug: 'incomplet', statut: 'publie' }, body: '' }));

  const fields = issues.filter((i) => i.level === 'error').map((i) => i.field);
  assert.ok(fields.includes('metaDescription'));
  assert.ok(fields.includes('extrait'));
  assert.ok(fields.includes('contenu'));
  assert.ok(fields.includes('datePublication'));
  assert.ok(fields.includes('dateMiseAJour'));
});

test('checkArticleGate : corps trop court (< 1200 caractères) -> erreur bloquante', () => {
  resetIssues();
  checkArticleGate(
    entry({
      data: {
        slug: 'trop-court',
        statut: 'publie',
        metaDescription: 'a'.repeat(60),
        extrait: 'a'.repeat(60),
        datePublication: '2026-01-01',
        dateMiseAJour: '2026-02-01',
      },
      body: 'Un paragraphe bien trop court pour être publié.',
    })
  );
  const contenuError = issues.find((i) => i.field === 'contenu' && i.level === 'error');
  assert.ok(contenuError, 'attendu : une erreur "contenu" pour un corps trop court');
});

test('checkArticleGate : dateMiseAJour antérieure à datePublication -> erreur bloquante', () => {
  resetIssues();
  checkArticleGate(
    entry({
      data: {
        slug: 'dates-inversees',
        statut: 'publie',
        metaDescription: 'a'.repeat(60),
        extrait: 'a'.repeat(60),
        datePublication: '2026-06-01',
        dateMiseAJour: '2026-01-01',
      },
      body: CORPS_VALIDE,
    })
  );
  const dateError = issues.find((i) => i.field === 'dateMiseAJour' && i.level === 'error');
  assert.ok(dateError, 'attendu : une erreur bloquante quand dateMiseAJour < datePublication');
});

test('checkArticleGate : dateMiseAJour égale à datePublication est acceptée', () => {
  resetIssues();
  checkArticleGate(
    entry({
      data: {
        slug: 'dates-egales',
        statut: 'publie',
        metaDescription: 'a'.repeat(60),
        extrait: 'a'.repeat(60),
        datePublication: '2026-01-01',
        dateMiseAJour: '2026-01-01',
      },
      body: `${CORPS_VALIDE} [a](/estimation/) [b](/blog/vendre/)`,
    })
  );
  assert.equal(issues.filter((i) => i.field === 'dateMiseAJour' && i.level === 'error').length, 0);
});

test('checkArticleGate : avertissement non bloquant sous 2 liens internes', () => {
  resetIssues();
  checkArticleGate(
    entry({
      data: {
        slug: 'peu-de-liens',
        statut: 'publie',
        metaDescription: 'a'.repeat(60),
        extrait: 'a'.repeat(60),
        datePublication: '2026-01-01',
        dateMiseAJour: '2026-01-01',
      },
      body: `${CORPS_VALIDE} un seul [lien](/estimation/) interne.`,
    })
  );
  assert.equal(issues.filter((i) => i.level === 'error').length, 0, 'ne doit jamais bloquer le build');
  const warning = issues.find((i) => i.field === 'contenu' && i.level === 'warning');
  assert.ok(warning, 'attendu : un avertissement sous 2 liens internes');
});

// -----------------------------------------------------------------------------
// src/lib/auteurs.ts
// -----------------------------------------------------------------------------

test("l'auteur par défaut existe et figure dans l'enum du schéma", () => {
  assert.ok(AUTEUR_IDS.includes(AUTEUR_PAR_DEFAUT));
  assert.equal(getAuteur(AUTEUR_PAR_DEFAUT).id, AUTEUR_PAR_DEFAUT);
});

test('chaque fiche auteur est complète et indexée par son id', () => {
  for (const [id, auteur] of Object.entries(AUTEURS)) {
    assert.equal(auteur.id, id);
    for (const champ of ['nom', 'fonction', 'bio', 'initiales']) {
      assert.ok(auteur[champ].trim().length > 0, `${id} : ${champ} vide`);
    }
  }
});
