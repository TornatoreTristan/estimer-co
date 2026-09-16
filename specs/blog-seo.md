# Specs — Blog SEO longue traîne (`/blog/<categorie>/<slug>/`)

> Cadrage produit. Périmètre : l'infrastructure du blog (5 silos) et un premier article pilier dans `/blog/estimation-immobiliere/`.

## 0. Décisions prises

1. **Nom du silo** : on garde `/blog/estimation-immobiliere/`, même si les futures pages `/estimation-immobiliere/<région|département>` utilisent le même mot-clé. Chacun a son rôle : le blog est un guide pédagogique, les pages par zone donnent des chiffres locaux. Les deux se renvoient l'un vers l'autre.
2. **Auteur affiché** : « Équipe RITMODiag » par défaut (champ `auteur`, surchargeable).
3. **Unicité des slugs d'articles** : **globale**, toutes catégories confondues, pour simplifier le maillage.

## 1. Constat de l'existant

- Stack : Astro, sortie 100 % statique, hébergée sur GitHub Pages, domaine `https://estimer.co`. Le dossier `api/` (AdonisJS) ne concerne pas le blog.
- `astro.config.mjs` : `trailingSlash: 'always'`, `build.format: 'directory'`, `@astrojs/sitemap` déjà en place. Toute URL interne se termine par `/`.
- `src/content.config.ts` : des collections existent déjà (`regions`, `departements`, `partenaires`, `pages`). Elles utilisent le loader `glob()`, un schéma Zod et un champ `statut: brouillon|publie`. Aucune route ne les lit encore.
- `scripts/validate-content.mjs` : garde-fou exécuté avant `astro build`. Il vérifie les conditions de publication, les slugs réservés et l'unicité des slugs.
- `src/layouts/BaseLayout.astro` ne gère que title, description et canonical. Il manque Open Graph, JSON-LD et la balise robots.
- Il manque aussi `src/pages/404.astro`, `public/robots.txt` et tout lien « Blog » dans `Header.astro` / `Footer.astro`.
- Le champ `image` des collections reste un `z.string()`, pas le helper `image()` d'Astro. Le blog suit la même règle.

## 2. Périmètre MVP

### Infrastructure
- Nouvelle collection `articles`. Le champ `categorie` est une enum fermée : `estimation-immobiliere`, `prix-immobilier`, `vendre`, `dpe-travaux`, `villes`.
- Routes : `src/pages/blog/index.astro`, `src/pages/blog/[categorie]/index.astro`, `src/pages/blog/[categorie]/[slug].astro`, `src/pages/404.astro`.
- Ajouter `blog` aux slugs réservés (schéma `pages` + `RESERVED_PAGE_SLUGS`).
- SEO transverse : `src/components/seo/SeoHead.astro`, `src/components/seo/JsonLd.astro`, `src/components/Breadcrumb.astro`, et extension de `BaseLayout.astro`.
- Créer `public/robots.txt`, ajouter le lien « Blog » dans le Header et une colonne « Blog » dans le Footer.

### Article pilier
- **Titre** : Estimation immobilière : le guide complet pour connaître le vrai prix de votre bien en 2026
- **Slug** : `comment-estimer-son-bien-immobilier-guide-complet`
- **URL** : `/blog/estimation-immobiliere/comment-estimer-son-bien-immobilier-guide-complet/`
- **Mot-clé principal** : estimation immobilière. **Secondaires** : comment estimer son bien immobilier, méthodes d'estimation immobilière, estimation gratuite en ligne, prix de vente d'un bien immobilier.
- **metaTitle** (60 caractères max) : `Estimation immobilière : le guide complet 2026 | Estimer mon bien`. Si la longueur réelle dépasse, raccourcir.
- **metaDescription** : `Comment est calculé le prix de votre bien ? Méthodes, données DVF, erreurs à éviter, estimation gratuite en 2 minutes. Le guide complet 2026.`
- **Plan** :
  - H2 Qu'est-ce qu'une estimation immobilière et pourquoi elle compte
    - H3 Estimation vs expertise : ne pas confondre
    - H3 Les enjeux d'une estimation juste
  - H2 Les méthodes d'estimation immobilière
    - H3 La méthode par comparaison (données DVF)
    - H3 La méthode par le revenu (biens locatifs)
    - H3 Les outils d'estimation en ligne : ce qu'ils valent vraiment
  - H2 Les critères qui font varier le prix de votre bien
    - H3 Localisation et marché local
    - H3 Surface, état général, DPE et travaux
    - H3 Spécificités du bien (extérieur, étage, exposition…)
  - H2 Les erreurs qui faussent une estimation
    - H3 Se fier au prix d'achat initial
    - H3 Ignorer le DPE
    - H3 Comparer avec des prix affichés et non des ventes réelles
  - H2 Comment obtenir une estimation fiable en 2 minutes
    - H3 Ce que vérifie un outil sérieux
    - H3 Faire estimer gratuitement son bien
  - FAQ (champ `faq`, rendue par `FaqAccordion`)
- **Liens internes obligatoires** : `/estimation/` au moins 2 fois (intro et section 5), `/blog/prix-immobilier/`, `/blog/vendre/`, `/blog/dpe-travaux/`, `/blog/villes/`, `/carte/`, et `/partenaires/` depuis le passage sur le DPE. **Ne cibler que des routes qui existent réellement**, à vérifier dans `src/pages`.
- **Contenu** : français, factuel et prudent. Pas de chiffre inventé présenté comme une statistique officielle. La marque s'écrit toujours « RITMODiag ».

## 3. Critères d'acceptation

**SEO transverse**
- Given un article publié, When la page est rendue, Then `<title>` vaut `metaTitle` (ou `title` à défaut), la meta description, le canonical absolu `https://estimer.co/blog/<categorie>/<slug>/`, `og:title`, `og:description`, `og:type=article`, `og:url`, `og:image`, `og:locale=fr_FR`, `article:published_time` et `article:modified_time` sont présents.

**Article**
- Given un article `publie`, When on lance le build, Then sa page est générée avec le H1, le contenu, la date de mise à jour, le fil d'ariane et les liens internes.
- Given un article `brouillon`, When on lance le build, Then aucune page n'est générée et l'article n'apparaît ni dans le silo, ni dans l'index, ni dans le sitemap.

**Silo**
- Given 3 articles publiés dans un silo, When la page du silo est rendue, Then ils sont triés par `ordreAffichage` croissant, puis par `datePublication` décroissante. Chaque carte affiche le titre, l'extrait, la date et le lien.
- Given un silo sans article publié, When la page est rendue, Then elle est quand même générée et affiche « Bientôt de nouveaux contenus » avec un CTA vers `/estimation/`.

**Navigation**
- Le Header contient un lien « Blog » vers `/blog/`, qui liste les 5 silos et les derniers articles.

**Données structurées**
- Chaque article porte un JSON-LD `Article` (headline, datePublished, dateModified, author, publisher RITMODiag avec logo, image, mainEntityOfPage).
- Chaque article porte un JSON-LD `BreadcrumbList` (Accueil > Blog > Silo > Article, URLs absolues), identique au fil d'ariane visible.
- Un JSON-LD `FAQPage` est ajouté si `faq` n'est pas vide.

**Sitemap / robots**
- Le sitemap contient `/blog/`, les 5 silos et les articles publiés, jamais les brouillons.
- `robots.txt` référence `https://estimer.co/sitemap-index.xml`.

**Performance**
- Aucun JS client ajouté pour le blog (l'accordéon FAQ utilise `<details>`). Les images ont des dimensions fixées. Objectifs : CLS < 0,1 et LCP < 2,5 s sur mobile.

**404**
- Une catégorie ou un slug inconnu renvoie vers `404.astro`, qui propose des liens vers `/blog/` et `/estimation/`.

## 4. Modèle de contenu — collection `articles`

Fichiers Markdown dans `src/content/articles/*.md`, sur le même modèle que les collections existantes.

| Champ | Type | Obligatoire | Validation |
|---|---|---|---|
| `slug` | string | oui | `^[a-z0-9-]+$`, unique globalement |
| `categorie` | enum | oui | les 5 silos |
| `title` | string | oui | |
| `metaTitle` | string | non | 60 car. max recommandés |
| `metaDescription` | string | pour publier | 50–160 car. |
| `extrait` | string | pour publier | 50–200 car. |
| corps Markdown | | pour publier | ≥ 1200 caractères |
| `image` / `imageAlt` | string | non / requis si `image` | |
| `auteur` | string | non | défaut « Équipe RITMODiag » |
| `faq` | `{question, reponse}[]` | non | 10 max |
| `articlesLies` | slugs | non | 4 max, doivent exister |
| `motsClesCibles` | string[] | non | usage interne |
| `statut` | `brouillon\|publie` | oui | défaut `brouillon` |
| `datePublication` / `dateMiseAJour` | date | pour publier | `dateMiseAJour` ≥ `datePublication` |
| `ordreAffichage` | number | non | |

**Conditions de publication** (dans `validate-content.mjs`) : les champs marqués « pour publier » sont obligatoires. On émet en plus un avertissement non bloquant s'il y a moins de 2 liens internes vers `/estimation/` ou `/blog/`.

## 5. API

Aucune. Tout le contenu est statique et généré au build.

## 6. Composants

`src/components/blog/` : `ArticleCard`, `ArticleList`, `CategoryHero`, `ArticleHeader`, `RelatedArticles` (utilise `articlesLies`, ou à défaut d'autres articles de la même catégorie), `CtaEstimation`, `FaqAccordion`.
Libellés et descriptions des silos : un seul module de référence, par exemple `src/lib/blog.ts`, pour ne pas les dupliquer.

## 7. Hors périmètre

Pagination, recherche, RSS, pages auteur, MDX et composants interactifs, lien entrant depuis `/estimation/`, tracking GA4 dédié au blog, calendrier éditorial des autres silos, arbitrage du dossier média (`public/uploads/` ou `src/assets/`).
