/**
 * Module de référence du blog SEO (`specs/blog-seo.md` §2 et §6) :
 * - la liste ordonnée des 5 silos (slug, libellé, description SEO courte),
 *   pour ne jamais la dupliquer entre `src/pages/blog/**` et les composants
 *   `src/components/blog/**` ;
 * - le tri des articles d'un silo (`ordreAffichage` croissant, puis
 *   `datePublication` décroissante — specs §3 "Silo") ;
 * - le filtre des articles publiés (un brouillon n'apparaît jamais dans une
 *   liste, cf. specs §3 "Article") ;
 * - la construction des URLs `/blog/<categorie>/` et `/blog/<categorie>/<slug>/`,
 *   cohérente avec `trailingSlash: 'always'` (astro.config.mjs).
 *
 * Fonctions pures, sans dépendance à Astro : testables avec `node --test`
 * (voir `scripts/test-blog-content.mjs`) et réutilisables telles quelles dans
 * les pages/composants Astro du blog.
 */

/** Slug des 5 silos éditoriaux — doit rester synchronisé avec l'enum `categorie`
 * de la collection `articles` dans `src/content.config.ts`. */
export type CategorieSlug =
  | 'estimation-immobiliere'
  | 'prix-immobilier'
  | 'vendre'
  | 'dpe-travaux'
  | 'villes';

export interface BlogCategory {
  slug: CategorieSlug;
  /** Libellé affiché (nav, fil d'ariane, titres de silo). */
  label: string;
  /** Description SEO courte, utilisable en intro de silo ou en meta description. */
  description: string;
}

/**
 * Les 5 silos, dans l'ordre d'affichage attendu (page `/blog/`, Header, Footer).
 * Source unique — ne pas redéclarer ces libellés ailleurs (specs §6).
 */
export const CATEGORIES: readonly BlogCategory[] = [
  {
    slug: 'estimation-immobiliere',
    label: 'Estimation immobilière',
    description: "Méthodes, données et outils pour connaître le vrai prix d'un bien.",
  },
  {
    slug: 'prix-immobilier',
    label: 'Prix immobilier',
    description: "Tendances de prix au m² et repères de marché par ville et région.",
  },
  {
    slug: 'vendre',
    label: 'Vendre son bien',
    description: "Conseils pratiques pour préparer, fixer le prix et réussir une vente.",
  },
  {
    slug: 'dpe-travaux',
    label: 'DPE et travaux',
    description: "Diagnostic de performance énergétique et impact des travaux sur le prix.",
  },
  {
    slug: 'villes',
    label: 'Villes',
    description: "Zooms locaux sur le marché immobilier de villes précises.",
  },
];

/** Chemin de l'index du blog. */
export const BLOG_INDEX_URL = '/blog/';

/** Retrouve la définition d'un silo à partir de son slug, `undefined` si inconnu. */
export function getCategory(slug: string): BlogCategory | undefined {
  return CATEGORIES.find((category) => category.slug === slug);
}

/** Garde de type : `slug` est-il l'un des 5 slugs de silo connus ? */
export function isCategorieSlug(slug: string): slug is CategorieSlug {
  return CATEGORIES.some((category) => category.slug === slug);
}

/** URL du silo (`/blog/<categorie>/`), toujours terminée par `/`. */
export function getCategoryUrl(categorie: string): string {
  return `/blog/${categorie}/`;
}

/** URL d'un article (`/blog/<categorie>/<slug>/`), toujours terminée par `/`. */
export function getArticleUrl(categorie: string, slug: string): string {
  return `/blog/${categorie}/${slug}/`;
}

/**
 * Forme minimale attendue d'un article pour le tri/filtre ci-dessous — pensée
 * pour correspondre structurellement à `entry.data` d'une entrée de la
 * collection `articles` (`CollectionEntry<'articles'>['data']`), sans importer
 * `astro:content` ici (module gardé pur, testable hors Astro).
 */
export interface ArticleLike {
  slug: string;
  categorie: string;
  statut?: 'brouillon' | 'publie';
  datePublication?: Date | string;
  dateMiseAJour?: Date | string;
  ordreAffichage?: number;
  [key: string]: unknown;
}

function toTime(value: Date | string | undefined): number {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Trie une liste d'articles par `ordreAffichage` croissant (les articles sans
 * `ordreAffichage` sont relégués en fin de liste), puis par `datePublication`
 * décroissante (specs §3 "Silo"). Ne mute jamais le tableau reçu.
 */
export function sortArticles<T extends ArticleLike>(articles: readonly T[]): T[] {
  return [...articles].sort((a, b) => {
    const orderA = a.ordreAffichage ?? Number.POSITIVE_INFINITY;
    const orderB = b.ordreAffichage ?? Number.POSITIVE_INFINITY;
    if (orderA !== orderB) return orderA - orderB;

    return toTime(b.datePublication) - toTime(a.datePublication);
  });
}

/** Un article est-il publié ? (`statut: publie`, jamais `brouillon`). */
export function isPublished(article: ArticleLike): boolean {
  return article.statut === 'publie';
}

/** Filtre une liste d'articles pour ne garder que ceux qui sont publiés. */
export function filterPublished<T extends ArticleLike>(articles: readonly T[]): T[] {
  return articles.filter(isPublished);
}

/** Combine filtre des publiés et tri du silo — raccourci le plus utilisé côté pages. */
export function getPublishedSortedArticles<T extends ArticleLike>(articles: readonly T[]): T[] {
  return sortArticles(filterPublished(articles));
}
