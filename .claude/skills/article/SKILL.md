---
name: article
description: "Rédiger, illustrer et proposer un article de blog estimer.co. Utiliser dès qu'il s'agit d'écrire un nouvel article, de compléter un brouillon, de publier un article existant ou d'ajouter sa photo d'illustration. Couvre le frontmatter, les catégories, les auteurs, le SEO, les images et la validation avant PR."
---

# /article

Un article de blog est un simple fichier Markdown dans `src/content/articles/`.
Cette skill dit comment l'écrire pour qu'il passe la validation du dépôt et
ressemble aux articles existants.

Référence de forme : `src/content/articles/estimation-maison-caen.md`. En cas de
doute sur une règle, la source de vérité est `src/content.config.ts` (schéma) et
`scripts/validate-content.mjs` (gate de publication) — jamais ce fichier-ci.

## Marche à suivre

1. Partir de `main` à jour et créer une branche `blog/<slug>`.
2. Écrire `src/content/articles/<slug>.md` (frontmatter + corps).
3. Ajouter l'image si l'utilisateur en fournit une (voir §Images).
4. Lancer `node scripts/validate-content.mjs`, corriger jusqu'à 0 erreur.
5. Lancer `npm run test:blog && npm run test:blog-pages`.
6. Commit, push, ouvrir la PR. **Ne jamais merger soi-même.**

Un article naît toujours en `statut: brouillon`. Ne le passer à `publie` que si
l'utilisateur le demande explicitement, et seulement après avoir vérifié que la
gate de publication passe (§Publier).

## Frontmatter

Ordre et forme repris de l'article de référence :

```yaml
---
slug: estimation-appartement-nantes      # = nom du fichier, ^[a-z0-9-]+$, sans accent
categorie: villes                        # une des 5 catégories, voir §Catégories
title: "Titre affiché en haut de l'article"
metaTitle: "Titre de l'onglet et des résultats Google"   # ≤ 60 caractères
metaDescription: "Description affichée sous le lien dans Google."  # 50–160 caractères
extrait: "Résumé affiché sur les cartes du blog."        # 50–200 caractères
image: /images/blog/estimation-appartement-nantes.webp
imageAlt: "Description factuelle de la photo, pour les lecteurs d'écran"
imageCadrage: 20                         # 0 = haut, 100 = bas ; à régler si la photo est coupée
motsClesCibles:                          # usage interne, non affiché
  - estimation appartement Nantes
faq:                                     # 10 maximum, facultatif mais recommandé
  - question: "…"
    reponse: "…"
articlesLies:                            # 4 maximum, slugs d'articles existants
  - estimation-maison-caen
auteur: tristan-tornatore                # voir §Auteurs ; omettre = auteur par défaut
statut: brouillon
datePublication: 2026-09-18
dateMiseAJour: 2026-09-18
---
```

Règles à respecter :
- `slug` doit être identique au nom du fichier, unique dans tout `src/content/`,
  en minuscules sans accent.
- `metaDescription` : entre 50 et 160 caractères, sinon le build échoue.
- `extrait` : entre 50 et 200 caractères.
- `imageAlt` est **obligatoire** dès que `image` est renseignée.
- `articlesLies` doit pointer vers des slugs qui existent vraiment.
- `dateMiseAJour` ne peut pas être antérieure à `datePublication`.

## Catégories

Les 5 seules valeurs acceptées (source : `src/lib/blog.ts`) :

| `categorie` | Contenu attendu |
| --- | --- |
| `estimation-immobiliere` | Méthodes, données et outils pour connaître le vrai prix d'un bien |
| `prix-immobilier` | Tendances de prix au m² et repères de marché par ville ou région |
| `vendre` | Conseils pratiques pour préparer, fixer le prix et réussir une vente |
| `dpe-travaux` | DPE et impact des travaux sur le prix |
| `villes` | Zoom local sur le marché d'une ville précise |

**Ne jamais inventer une catégorie.** Elle détermine l'URL de l'article
(`/blog/<categorie>/<slug>`) et la navigation du site. Si aucune ne convient,
le dire à l'utilisateur et proposer la plus proche — en créer une est une
décision éditoriale qui touche plusieurs fichiers.

## Auteurs

Les fiches auteurs sont déclarées dans `src/lib/auteurs.ts` (constante
`AUTEURS`). Le frontmatter ne porte que l'identifiant, ex. `tristan-tornatore` :
nom, fonction, biographie, photo et liens vivent dans cette fiche, une seule
fois, et alimentent l'en-tête, l'encadré « À propos de l'auteur » et le JSON-LD.

- Lire `src/lib/auteurs.ts` avant d'attribuer un auteur : seuls les
  identifiants qui y figurent sont acceptés par le schéma.
- Champ `auteur` omis = auteur par défaut du site. C'est le cas normal.
- **Ne jamais créer une fiche auteur sans que l'utilisateur l'ait demandé.**
  Si c'est le cas : reprendre la forme d'une fiche existante, bio d'au moins 50
  caractères, photo carrée d'au moins 240 px dans `public/auteurs/`, et
  uniquement des liens en `https://` ou `mailto:`.

## SEO

- `title` : la promesse de l'article, avec le mot-clé principal en tête.
- `metaTitle` : ≤ 60 caractères, sinon Google le coupe. Peut différer du `title`.
- `metaDescription` : une phrase qui donne envie de cliquer, avec le mot-clé.
- `extrait` : ce que le lecteur voit sur les cartes du blog.
- **Liens internes** : au moins 2 dans le corps, vers `/estimation/` ou vers un
  autre article `/blog/…`. En dessous, la validation émet un avertissement.
- **FAQ** : questions réellement posées par les lecteurs, réponses courtes et
  factuelles. Elle alimente les résultats enrichis de Google.
- Pas de chiffre de marché sans période ni source dans le texte
  (« les sources consultées en septembre 2026 situent… »).

## Corps de l'article

- Markdown, sans titre de niveau 1 : le `title` du frontmatter est déjà affiché.
- Structurer en `##` et `###`.
- **1200 caractères minimum** pour pouvoir publier. En pratique, viser beaucoup
  plus pour un article utile.
- Ton du site : concret, sans jargon, tutoiement proscrit, pas de promesse de
  prix garanti. Relire un article existant avant d'écrire le premier.

## Images

Les photos d'illustration vivent dans `public/images/blog/<slug>.webp`, et le
frontmatter les référence en `/images/blog/<slug>.webp`.

Conversion depuis un fichier fourni par l'utilisateur :

```bash
# 1600 px de large au maximum ; `-resize` agrandirait une image plus petite,
# donc vérifier la largeur d'abord.
sips -g pixelWidth <source>
cwebp -q 80 -resize 1600 0 <source> -o public/images/blog/<slug>.webp  # si > 1600 px
cwebp -q 80 <source> -o public/images/blog/<slug>.webp                 # sinon
```

- Toujours écrire un `imageAlt` qui décrit ce qu'on voit, pas le mot-clé SEO.
- Les en-têtes et les cartes recadrent en 16/9 : si le sujet est coupé, régler
  `imageCadrage` (0 = haut, 100 = bas, centré par défaut).
- **Ne jamais aller chercher une image sur le web sans que l'utilisateur l'ait
  demandé** : les droits d'usage ne sont pas vérifiables automatiquement.

## Publier

Un article publié doit obligatoirement avoir : `metaDescription`, `extrait`,
`datePublication`, `dateMiseAJour`, et un corps d'au moins 1200 caractères.
Il manque un seul de ces champs et le build du site échoue en CI.

Avant de passer `statut: publie` :

```bash
node scripts/validate-content.mjs   # doit afficher 0 erreur
npm run test:blog && npm run test:blog-pages
```

Les avertissements ne bloquent pas le build, mais les signaler à l'utilisateur.

## À ne pas faire

- Merger la PR soi-même.
- Inventer une catégorie ou un identifiant d'auteur.
- Publier un article que l'utilisateur n'a pas relu.
- Inventer un prix au m², une statistique ou une source.
- Modifier `src/content.config.ts` ou `scripts/validate-content.mjs` pour faire
  passer un article : c'est l'article qu'il faut corriger.
