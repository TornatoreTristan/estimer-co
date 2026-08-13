# Specs — CMS Git (Pages CMS) + pages SEO région/département/partenaire + tracking clics GA4

> Cadrage produit. Décisions client arbitrées : CMS = Pages CMS (hébergé),
> analytics = Google Analytics 4, périmètre ≈ 145 pages générées.

## 1. Contexte technique

Astro 7.2, **sortie 100 % statique**, aucun framework UI, **aucun backend**, aucune
base de données. Déploiement visé : GitHub Pages, domaine `https://estimer.co`.

Le « modèle de données » est donc constitué des **Astro content collections**
(Markdown + frontmatter YAML validés par Zod), pas de tables SQL. Il n'y a pas
d'endpoints API.

### Constats sur l'existant

- **Aucun pipeline CI/CD** : pas de dossier `.github/`. Rien ne build ni ne déploie
  automatiquement. **Prérequis bloquant** : sans build+deploy déclenché par commit,
  les éditions Pages CMS (qui ne font que committer) ne mettront jamais le site à jour.
- 6 pages `.astro` avec contenu en dur : `index`, `estimation`, `carte`, `contact`,
  `partenaires`, `rapport`. Redirections `.html` dans `astro.config.mjs`.
- `BaseLayout.astro` n'accepte que `title` / `description`. Génère `<meta description>`
  et `canonical`. **Aucun Open Graph, aucun JSON-LD, aucun `robots`, aucun sitemap**
  (`@astrojs/sitemap` absent de `package.json`).
- `src/data/prix.ts` : 13 régions + 101 départements (`name, price, maisons, apparts,
  evol12, evol5`). Consommé par `carte.astro` **côté serveur ET côté client** (le
  `<script>` réimporte `prix.ts` pour le filtrage interactif).
- `src/data/partenaires.ts` : 30 partenaires (`logo` = texte, pas d'image ; `name`,
  `description`, `url`). Liens sortants déjà en `target="_blank" rel="noopener
  noreferrer"` mais **non trackés** — pas de GA4, pas de bandeau de consentement.
- `carte.astro` est un explorateur interactif **mono-page**, pas 114 pages. Les pages
  SEO région/département sont un objet distinct et complémentaire.
- `src/lib/config.ts` centralise les `PUBLIC_*` → point d'extension pour l'ID GA4.

## 2. User stories

Priorités : **P0** fondation/bloquant, **P1** valeur métier, **P2** qualité.

### Épique A — Fondations CMS & déploiement

- **A1 (P0)** — En tant qu'éditeur non-développeur, je veux me connecter à Pages CMS
  avec GitHub et voir les collections (régions, départements, partenaires, pages libres)
  afin de créer/modifier des pages sans toucher au code.
- **A2 (P0)** — En tant que mainteneur, je veux qu'un commit sur `main` déclenche build
  Astro + déploiement GitHub Pages afin que toute édition soit visible sans action manuelle.
- **A3 (P1)** — En tant que mainteneur, je veux que le build échoue si une entrée
  « publiée » ne respecte pas les champs minimums afin qu'aucune page creuse ne parte
  en production.

### Épique B — Pages partenaires + tracking + consentement

- **B1 (P1)** — En tant que visiteur, je veux une page dédiée par partenaire afin
  d'évaluer son offre avant de cliquer vers son site.
- **B2 (P1)** — En tant qu'éditeur, je veux ajouter/modifier/réordonner/dépublier un
  partenaire depuis le CMS afin de ne plus dépendre d'un développeur.
- **B3 (P0 métier)** — En tant que responsable marketing, je veux que chaque clic sortant
  soit un événement GA4 qualifié (quel partenaire, depuis quelle page) afin d'identifier
  les partenaires qui génèrent le plus de trafic.
- **B4 (P0 légal)** — En tant que visiteur, je veux un bandeau de consentement, pouvoir
  accepter/refuser, et voir mon choix respecté durablement (RGPD/CNIL).
- **B5 (P0 légal)** — En tant que visiteur ayant refusé, je veux qu'aucun cookie GA4 ne
  soit déposé ni aucun événement envoyé, tout en gardant une navigation 100 % fonctionnelle.

### Épique C — Pages région / département

- **C1 (P1)** — Page dédiée par région : prix au m², évolutions, contenu local.
- **C2 (P1)** — Idem affiné au département.
- **C3 (P1)** — Mise à jour trimestrielle des prix et du contenu depuis le CMS.
- **C4 (P1)** — Maillage : liste des départements sur la page région, lien retour vers
  la région parente sur la page département.
- **C5 (P0 SEO)** — Texte, FAQ et données propres à chaque zone, afin d'éviter que Google
  ne traite les pages comme du contenu dupliqué / thin content.

### Épique D — Pages libres CMS

- **D1 (P1)** — Créer une page libre (guide, actualité, page légale) avec slug personnalisé.
- **D2 (P1)** — Statut « brouillon » : relire sans être visible publiquement ni indexé.

### Épique E — SEO transverse

- **E1 (P0)** — title, meta description, canonical, Open Graph et JSON-LD sur chaque page.
- **E2 (P0)** — `sitemap.xml` généré au build, ne contenant que les pages publiées.

## 3. Critères d'acceptation (Given/When/Then)

### A1 — Connexion et édition via Pages CMS

```
Scénario : Connexion réussie
  Given je suis un éditeur avec accès au repo GitHub estimer.co
  When j'ouvre l'app hébergée Pages CMS et me connecte avec GitHub
  Then je vois les 4 collections (Régions, Départements, Partenaires, Pages libres)
  And je peux ouvrir une entrée existante et voir tous ses champs pré-remplis

Scénario : Édition et publication
  Given je modifie le champ "prixM2" d'une région
  When je clique sur Enregistrer
  Then un commit est créé sur main
  And le fichier modifié correspond exactement au champ édité (pas de perte d'autres champs)

Scénario : Accès refusé
  Given je ne suis pas membre du repo avec droits d'écriture
  When je tente de me connecter
  Then l'accès en édition m'est refusé
```

### A2 — Build & déploiement automatiques

```
Scénario : Déploiement suite à un commit CMS
  Given un commit est poussé sur main (Pages CMS ou développeur)
  When le workflow GitHub Actions se déclenche
  Then le site est construit avec "astro build"
  And dist/ est déployé sur GitHub Pages
  And le site en ligne reflète le changement en moins de 5 minutes

Scénario : Échec de build
  Given un commit introduit un contenu ne respectant pas un schéma
  When le workflow s'exécute
  Then le build échoue explicitement
  And l'ancien site en production reste inchangé (pas de déploiement partiel)
  And l'échec est visible dans l'onglet Actions
```

### A3 — Garde-fou anti-publication incomplète

```
Scénario : Page publiée sans champs minimums
  Given une entrée région a statut = "publie"
  And son champ metaDescription est vide
  When le script de validation s'exécute en CI avant le build
  Then le build échoue en listant l'entrée et les champs manquants

Scénario : Brouillon incomplet
  Given une entrée a statut = "brouillon" et des champs incomplets
  When le script de validation s'exécute
  Then le build n'échoue pas
  And la page n'est ni générée ni incluse dans le sitemap
```

### B1/B2 — Pages partenaires

```
Scénario : Page générée par partenaire publié
  Given un partenaire "Century 21" a statut = "publie" et slug = "century-21"
  When le site est buildé
  Then /partenaires/century-21 est générée
  And elle affiche nom, logo, catégorie, présentation longue, avantages, CTA "Visiter le site"

Scénario : Partenaire dépublié
  Given un partenaire passe de "publie" à "brouillon"
  When le commit est déployé
  Then sa page n'est plus générée
  And il n'apparaît plus dans /partenaires ni dans le sitemap

Scénario : Réordonnancement
  Given deux partenaires ont un ordreAffichage différent
  When /partenaires est rendue
  Then les cartes sont triées par ordreAffichage croissant
```

### B3 — Tracking des clics sortants (GA4)

```
Scénario : Clic tracké avec consentement accordé
  Given le visiteur a accepté les cookies analytiques
  And il consulte /partenaires/century-21
  When il clique sur "Visiter le site"
  Then un événement GA4 "partner_click_out" est envoyé avec :
    partner_slug=century-21, partner_name="Century 21",
    partner_category=agence-immobiliere, page_type=partenaire_detail,
    page_path=/partenaires/century-21, link_url=https://www.century21.fr
  And le lien s'ouvre normalement dans un nouvel onglet, sans délai perceptible

Scénario : Clic depuis le listing
  Given le visiteur consulte /partenaires
  When il clique sur la 5e carte
  Then l'événement est envoyé avec page_type=partenaires_index et position=5

Scénario : Clic depuis une page région/département
  Given le visiteur consulte /estimation-immobiliere/paris-75
  When il clique sur un partenaire recommandé
  Then l'événement est envoyé avec page_type=departement et page_path=/estimation-immobiliere/paris-75

Scénario : JavaScript bloqué (adblocker)
  Given gtag.js n'a pas pu se charger
  When le visiteur clique sur un lien partenaire
  Then la navigation fonctionne normalement (lien <a href> natif)
  And aucune erreur JS n'est levée
```

### B4/B5 — Consentement RGPD (Consent Mode v2, implémentation « Basic »)

```
Scénario : Premier visiteur
  Given aucun consentement stocké
  When la page se charge
  Then aucun script GA4 n'est chargé
  And aucun cookie _ga/_ga_* n'est déposé
  And le bandeau s'affiche sans bloquer le contenu (pas de cookie wall)
  And un défaut "denied" est positionné (analytics_storage, ad_storage,
      ad_user_data, ad_personalization) avant tout tag tiers

Scénario : Acceptation
  When le visiteur clique sur "Accepter"
  Then le choix est stocké (13 mois max, avec une version de politique)
  And gtag.js est chargé et gtag('consent','update',{analytics_storage:'granted',...}) appelé
  And page_view et partner_click_out sont désormais envoyés

Scénario : Refus
  When le visiteur clique sur "Refuser"
  Then le choix "refusé" est stocké (cookie technique de consentement uniquement)
  And gtag.js n'est jamais chargé
  And aucun événement n'est envoyé, y compris partner_click_out
  And la navigation, le formulaire de contact et les clics partenaires restent fonctionnels

Scénario : Modification a posteriori
  When le visiteur ouvre "Gérer mes cookies" (pied de page)
  Then le bandeau se rouvre avec son choix pré-sélectionné
  And un nouveau choix écrase l'ancien et met à jour gtag consent, sans recharger la page

Scénario : Expiration
  Given le consentement stocké a plus de 13 mois, ou la version de politique a changé
  When le visiteur revient
  Then le bandeau est réaffiché comme pour un premier visiteur
```

### C1/C2/C4/C5 — Pages région/département

```
Scénario : Page région avec ses départements enfants
  Given la région Île-de-France est publiée
  And 8 départements ont regionParente = Île-de-France et sont publiés
  When le site est buildé
  Then /estimation-immobiliere/ile-de-france est générée
  And elle liste les 8 départements avec lien vers /estimation-immobiliere/<slug>
  And chaque lien affiche un teaser de prix

Scénario : Page département avec fil d'Ariane
  Given le département Yvelines (78) a regionParente = Île-de-France
  When /estimation-immobiliere/yvelines-78 est rendue
  Then le fil d'Ariane affiche Accueil > Prix immobilier > Île-de-France > Yvelines (78)
  And un lien retour vers la page région est présent

Scénario : Contenu insuffisant (anti thin content)
  Given une page département a intro vide OU moins de 2 entrées FAQ OU pas de regionParente
  When le script de validation s'exécute
  Then le build échoue si statut = "publie"

Scénario : Maillage avec /carte
  When un visiteur clique sur un département dans l'explorateur /carte
  Then un lien "Voir la fiche complète du département →" est visible dans le panneau
  And réciproquement chaque fiche propose un lien vers /carte
```

### D1/D2 — Pages libres

```
Scénario : Création
  Given une entrée "pages" avec slug = "guide-diagnostic-dpe", statut = "publie"
  When le site est buildé
  Then /pages/guide-diagnostic-dpe est accessible

Scénario : Slug réservé refusé
  Given un éditeur tente slug = "contact" (route déjà utilisée)
  When le script de validation s'exécute
  Then le build échoue en listant les slugs réservés en conflit

Scénario : Brouillon
  Given une page libre a statut = "brouillon"
  When le site est buildé
  Then /pages/<slug> n'est pas générée
  And elle n'apparaît ni dans le sitemap ni dans l'index /pages
```

### E1/E2 — SEO transverse

```
Scénario : Métadonnées complètes
  Given une page publiée (région, département, partenaire ou libre)
  When elle est rendue
  Then <title> reflète metaTitle (ou title en repli)
  And <meta name="description"> reflète metaDescription
  And <link rel="canonical"> pointe vers l'URL absolue exacte
  And og:title, og:description, og:type, og:url, og:image, og:locale=fr_FR sont présents
  And un JSON-LD valide (Rich Results Test) est présent, incluant a minima BreadcrumbList

Scénario : FAQPage conditionnel
  Given une page région/département a au moins 1 entrée FAQ
  Then un JSON-LD FAQPage est ajouté reprenant chaque question/réponse
  And ce bloc est absent si faq est vide

Scénario : Sitemap
  Given 114 entrées régions/départements dont 90 publiées, et 30 partenaires dont 28 publiés
  When le site est buildé
  Then sitemap.xml contient 90 + 28 URLs de contenu, + les 6 pages statiques,
       + les pages libres publiées
  And aucune URL de brouillon n'y figure
```

## 4. Modèles de contenu

Implémentation : `src/content.config.ts`, `loader: glob()` sur `src/content/<collection>/*.md`
(frontmatter YAML + corps Markdown pour le champ éditorial principal), schémas Zod.

### 4.1 `regions` (13 entrées)

| Champ | Type | Obligatoire | Validation |
|---|---|---|---|
| `slug` | string | oui | `^[a-z0-9-]+$`, unique dans {regions ∪ departements} |
| `nom` | string | oui | ex. « Île-de-France » |
| `title` | string | oui | H1 / repli du `<title>` |
| `metaTitle` | string | non | repli = `title`, ≤ 60 car. recommandé |
| `metaDescription` | string | oui | 50–160 caractères |
| `intro` (corps md) | rich-text | oui | non vide ; ≥ 400 car. pour publication |
| `analyseLocale` | rich-text | non | tendances, sous-marchés |
| `prixM2` | number | oui | > 0 |
| `prixMaisons` | number | oui | > 0 |
| `prixAppartements` | number | oui | > 0 |
| `evolution12Mois` | number | oui | %, peut être négatif |
| `evolution5Ans` | number | oui | %, peut être négatif |
| `faq` | liste `{question, reponse}` | non | 0–10 ; ≥ 2 requis si publié |
| `partenairesMisEnAvant` | refs → `partenaires` | non | 0–6 |
| `image` | image | non | — |
| `imageAlt` | string | conditionnel | obligatoire si `image` |
| `statut` | select `brouillon\|publie` | oui | défaut `brouillon` |
| `datePublication` | date | non | à la première publication |
| `dateMiseAJour` | date | oui si publié | affichage E-E-A-T |
| `ordreAffichage` | number | non | tri des listings |

**Gate de publication** : `metaDescription`, `intro` ≥ 400 car., les 5 champs chiffrés,
`faq.length ≥ 2`, `dateMiseAJour`.

### 4.2 `departements` (101 entrées)

Mêmes champs que `regions`, **plus** :

| Champ | Type | Obligatoire | Validation |
|---|---|---|---|
| `codeInsee` | string | oui | `^(\d{2,3}\|2A\|2B)$`, unique |
| `regionParente` | ref → `regions` | oui | doit exister |
| `villesPrincipales` | liste `{nom, prixM2?}` | non | 0–8 |

Gate additionnelle : `regionParente` obligatoire.

### 4.3 `partenaires` (30 entrées)

| Champ | Type | Obligatoire | Validation |
|---|---|---|---|
| `slug` | string | oui | kebab-case, unique |
| `nom` | string | oui | — |
| `logo` | image | non | repli = pastille texte |
| `logoTexte` | string | non | repli d'affichage, et `alt` si image présente |
| `description` | string | oui | 50–200 car., teaser carte |
| `presentation` (corps md) | rich-text | oui | ≥ 300 mots recommandé, différenciant |
| `categorie` | select | oui | `agence-immobiliere\|banque\|notaire\|diagnostiqueur\|courtier\|autre` |
| `avantages` | liste de strings | non | 0–6 |
| `zoneCouverture` | refs → régions/départements | non | 0–n (cf. risque §8) |
| `url` | string | oui | `^https://` |
| `ctaLabel` | string | non | défaut « Visiter le site » |
| `statut` | select | oui | défaut `brouillon` |
| `datePublication` / `dateMiseAJour` | date | conditionnel | comme regions |
| `ordreAffichage` | number | non | tri du listing |

Gate : `description`, `presentation`, `categorie`, `url` valides.

### 4.4 `pages` (contenu libre)

| Champ | Type | Obligatoire | Validation |
|---|---|---|---|
| `slug` | string | oui | kebab-case, unique, **interdit** si réservé (§5) |
| `title` | string | oui | — |
| `metaTitle` | string | non | repli = `title` |
| `metaDescription` | string | oui | 50–160 caractères |
| `gabarit` | select `page-simple\|article` | oui | pilote le JSON-LD (WebPage vs Article) |
| `contenu` (corps md) | rich-text | oui | non vide |
| `image` / `imageAlt` | image / string | non / conditionnel | `imageAlt` requis si `image` |
| `auteur` | string | non | défaut « Équipe Estimer mon bien », si `gabarit = article` |
| `statut` | select | oui | défaut `brouillon` |
| `datePublication` / `dateMiseAJour` | date | conditionnel | requis si `gabarit = article` |

### 4.5 `.pages.yml` (racine du repo)

- 4 collections → `src/content/{regions,departements,partenaires,pages}/`
- Nommage de fichier basé sur `slug` (`{slug}.md`) pour aligner fichier et URL
- Dossier média unique (cf. risque §8 sur `public/uploads/` vs `src/assets/`)
- Authentification GitHub, restreinte aux collaborateurs du repo

## 5. URLs et règles de slug

```
/                                          existant
/estimation  /carte  /contact  /rapport    existants
/partenaires                               existant — listing, piloté par la collection
/partenaires/<slug>                        NOUVEAU — 30 pages
/estimation-immobiliere/<slug-region>      NOUVEAU — 13 pages
/estimation-immobiliere/<slug-departement> NOUVEAU — 101 pages
/pages/<slug>                              NOUVEAU — N pages
/pages/                                    NOUVEAU (optionnel, Lot 3) — index
/sitemap.xml                               NOUVEAU
```

- Format : kebab-case ASCII sans accents, `^[a-z0-9-]+$`.
- **Régions** : réutiliser les clés déjà présentes dans `prix.ts` (`ile-de-france`,
  `provence-alpes-cote-azur`…).
- **Départements** : **pas** le code numérique seul (ambigu, mauvaise pratique SEO).
  Convention : `<nom-kebab>-<code>` → `paris-75`, `ain-01`, `corse-du-sud-2a`, `yvelines-78`.
- **Partenaires** : nom kebab-casé → `century-21`, `stephane-plaza-immobilier`.
- **Slugs réservés interdits** pour les pages libres : `estimation`, `carte`, `contact`,
  `rapport`, `partenaires`, `estimation-immobiliere`, `pages`, `sitemap.xml`, `index`.
  À vérifier **en CI**, pas seulement à documenter.
- Régions et départements partagent le préfixe `/estimation-immobiliere/` → **une seule
  route dynamique** agrège les deux collections, avec vérification explicite de
  l'unicité des slugs en CI.

## 6. Composants et fichiers

### À créer

| Fichier | Rôle |
|---|---|
| `src/content.config.ts` | 4 collections + schémas Zod |
| `src/pages/estimation-immobiliere/[slug].astro` | Route agrégeant régions + départements |
| `src/pages/partenaires/[slug].astro` | 1 page par partenaire publié |
| `src/pages/pages/[slug].astro` | 1 page par entrée publiée |
| `src/pages/pages/index.astro` | Index des pages libres (Lot 3, proposé) |
| `src/components/seo/SeoHead.astro` | title/description/canonical/OG/robots |
| `src/components/seo/JsonLd.astro` | `<script type="application/ld+json">` générique |
| `src/components/Breadcrumb.astro` | Fil d'Ariane + données BreadcrumbList |
| `src/components/PriceCard.astro` | Prix/évolutions (factorise `renderInfo` de `carte.astro`) |
| `src/components/RegionDepartementList.astro` | Maillage région ↔ départements |
| `src/components/FaqAccordion.astro` | Accordéon FAQ + JSON-LD FAQPage |
| `src/components/PartnerCard.astro` | Carte partenaire réutilisable |
| `src/components/PartnerLinkOut.astro` | **Point d'entrée unique du tracking** |
| `src/components/ConsentBanner.astro` | Bandeau RGPD, accepter/refuser/modifier |
| `src/components/Analytics.astro` | Consent Mode v2 + chargement conditionnel de gtag.js |
| `src/lib/analytics.ts` | `trackEvent()` no-op silencieux + helpers de consentement |
| `.pages.yml` | Configuration Pages CMS |
| `.github/workflows/deploy.yml` | Build + déploiement GitHub Pages sur push `main` |
| `scripts/validate-content.mjs` | Garde-fou CI (gates de publication) |
| `scripts/migrate-legacy-data.mjs` | Migration one-off `prix.ts` / `partenaires.ts` → Markdown |

### À modifier

| Fichier | Modification |
|---|---|
| `src/layouts/BaseLayout.astro` | Intègre `SeoHead`, `Analytics`, `ConsentBanner` ; étend les Props (`ogImage`, `jsonLd`, `noindex`, `type`) |
| `src/pages/partenaires.astro` | `getCollection('partenaires')` filtré/trié, `PartnerCard` + `PartnerLinkOut`, lien vers la fiche |
| `src/pages/carte.astro` | Collections côté serveur + **sérialisation JSON** pour le script client ; lien vers la fiche dédiée |
| `astro.config.mjs` | Ajout de `@astrojs/sitemap` |
| `.env.example`, `src/env.d.ts` | Ajout de `PUBLIC_GA4_MEASUREMENT_ID` |
| `src/data/prix.ts`, `src/data/partenaires.ts` | **Supprimés** une fois la migration faite |
| `README.md` | Documenter `src/content/`, Pages CMS, le déploiement |

### Contrat de l'événement GA4

- Nom : `partner_click_out`
- Paramètres : `partner_slug`, `partner_name`, `partner_category`, `page_type`
  (`partenaires_index` \| `partenaire_detail` \| `region` \| `departement` \| `page_libre`),
  `page_path`, `link_url`, `position` (optionnel).
- Déclenché **uniquement** si `analytics_storage = granted` ; sinon no-op silencieux.
- **Ne bloque jamais la navigation** : pas de `preventDefault()`, pas de délai. Les liens
  gardent `target="_blank" rel="noopener noreferrer"`.

## 7. Lots livrables

### Lot 0 — Fondations (prérequis, aucune valeur visible seule)
`@astrojs/sitemap`, `.github/workflows/deploy.yml`, `src/content.config.ts` + 4 schémas,
script de migration one-off (30 + 114 fichiers, `statut: brouillon` par défaut, données
chiffrées copiées telles quelles), `.pages.yml`, script de validation CI, suppression de
`src/data/*.ts` une fois les pages migrées.

**Dépend de** : rien. **Bloque** tous les autres lots.

### Lot 1 — Pages partenaires (30) + tracking + consentement
`PartnerCard`, `PartnerLinkOut`, `Analytics`, `ConsentBanner`, `lib/analytics.ts`,
`partenaires/[slug].astro`, migration de `partenaires.astro`, événement `partner_click_out`.

**Dépend de** : Lot 0. **Valeur** : livre le besoin métier explicite (tracking) sur un
périmètre restreint, mesurable avant d'attaquer les 114 pages.

### Lot 2 — Régions & départements (114) + maillage `/carte`
`estimation-immobiliere/[slug].astro`, `PriceCard`, `RegionDepartementList`,
`FaqAccordion`, `Breadcrumb`, `JsonLd`, migration de `carte.astro` + sérialisation JSON,
liens croisés, vérification du sitemap.

**Dépend de** : Lot 0 ; réutilise `PartnerLinkOut` du Lot 1.

### Lot 3 — Pages libres
`pages/[slug].astro`, `pages/index.astro`, contrôle des slugs réservés en CI.

**Dépend de** : Lot 0 ; bénéficie des composants SEO du Lot 2.

### Lot 4 (stretch) — Confort éditorial
Rapport de validation détaillé. **Prévisualisation de brouillon : à trancher** — le site
étant statique sans serveur, une vraie preview exige soit un hébergement de preview par
branche/PR (Netlify/Vercel/Cloudflare Pages en plus de GitHub Pages), soit `npm run dev`
en local pour les éditeurs techniques. GitHub Pages seul ne le permet pas.

## 8. Risques et questions ouvertes

### Techniques

1. **`carte.astro` consomme `prix.ts` côté client.** Les content collections ne sont pas
   importables dans un `<script>` client : il faudra sérialiser les données en JSON au
   build (`define:vars` ou fichier JSON statique). Point d'attention explicite du Lot 2,
   pas une simple substitution d'import.
2. **Deux collections, un même préfixe d'URL.** La route dynamique doit agréger avec un
   discriminant explicite et vérifier l'unicité globale des slugs, sinon build cassé ou
   écrasement silencieux d'une page par l'autre.
3. **Validation limitée côté Pages CMS** : difficile d'imposer une longueur minimale sur
   un rich-text ou une règle conditionnelle (« obligatoire seulement si publié »). D'où le
   script CI comme véritable garde-fou.
4. **Dossier média** : `public/uploads/` (simple, pas d'optimisation) vs `src/assets/`
   (permet `astro:assets`, mais Pages CMS écrit dans un dossier fixe à vérifier compatible).
   Impact direct sur la performance des 30 logos.
5. **`@astrojs/sitemap` absent** : à ajouter et vérifier qu'il n'expose pas de brouillons.

### Éditoriaux / SEO

6. **Thin content résiduel.** Imposer `intro` ≥ 400 caractères ne garantit pas un contenu
   différenciant — un éditeur pressé peut copier-coller sur 101 départements. Recommander
   une charte de rédaction (angle local systématique) et un contrôle qualité manuel avant
   bascule en masse en « publié ».
7. **Les 30 descriptions partenaires actuelles sont déjà génériques** (« Réseau de X
   agences… »). La migration ne doit pas recopier `description` dans `presentation` : un
   vrai travail de rédaction est nécessaire avant publication.

### Légaux

8. **Portée du consentement limitée à GA4.** Le site charge déjà Google Maps sur `/carte`,
   qui peut lui aussi déposer des traceurs tiers. Le statut RGPD de cette intégration reste
   **hors périmètre** et mériterait un audit séparé.
9. **Consent Mode v2 « Basic » retenu** (aucun chargement de gtag.js avant consentement)
   plutôt que « Advanced ». Plus simple à défendre juridiquement sans campagnes Ads
   actives, mais **à faire valider** par le responsable RGPD/marketing.

### Questions ouvertes

- Le `Header.astro` doit-il exposer les nouvelles familles de pages (« Prix par région »),
  ou reste-t-il volontairement limité, le trafic SEO arrivant directement via Google ?
- Preview de brouillon : `npm run dev` en local suffit-il, ou faut-il budgétiser un
  hébergement de preview par branche ?
- `zoneCouverture` : Pages CMS supporte-t-il une relation multi-collection sur un même
  champ, ou faut-il se limiter à une seule collection cible ?
- Nom de l'événement GA4 : `partner_click_out` proposé — à valider par l'équipe marketing.
