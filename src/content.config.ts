// Content collections — CMS Git (Pages CMS). Voir specs/cms-seo-tracking.md §4.
//
// -----------------------------------------------------------------------------
// Où vit la logique de validation ? (décision, à ne pas dupliquer ailleurs)
// -----------------------------------------------------------------------------
// Les schémas ci-dessous ne valident que la FORME du frontmatter (types,
// patterns, bornes numériques, enums) — jamais la présence obligatoire d'un
// champ *conditionnée par* `statut`. Deux raisons :
//
// 1. Astro applique ces schémas Zod à CHAQUE entrée, brouillon comme publiée,
//    dès `astro sync`/`astro build`. Si un champ éditorial (metaDescription,
//    dateMiseAJour, faq…) était `required` ici, la moindre entrée brouillon
//    incomplète casserait le build entier — alors que les specs (§3, scénario
//    "Brouillon incomplet") exigent l'inverse : un brouillon incomplet ne doit
//    jamais faire échouer quoi que ce soit.
// 2. Le corps Markdown (`intro`, `presentation`, `contenu`) n'est de toute
//    façon PAS couvert par ces schémas : Zod ne valide que `data` (le
//    frontmatter). Les contraintes de longueur sur le corps (ex. intro ≥ 400
//    caractères) ne peuvent être vérifiées qu'en lisant `entry.body`.
//
// => Toute règle « obligatoire seulement si statut = publie » (Gate de
//    publication du §4, anti thin-content du §3 C5, etc.) vit exclusivement
//    dans `scripts/validate-content.mjs`, exécuté en CI avant `astro build`.
//    Ici, les champs concernés sont `.optional()`, mais restent
//    strictement typés/validés en FORME quand ils sont renseignés (longueur,
//    regex, bornes numériques…) pour donner un retour immédiat à l'éditeur
//    dans Pages CMS.
//
// Champs qui restent réellement `required` dans Zod (donc pour TOUTE entrée,
// brouillon incluse) : uniquement ceux qui sont structurels — nécessaires à
// l'identité du fichier et à un rendu minimalement cohérent même en preview
// (`slug`, `nom`/`title`, `statut`, `codeInsee`/`regionParente` pour les
// départements, `url` pour les partenaires). La migration (script §2) fournit
// toujours ces valeurs à 100 %, donc ce choix ne casse jamais le build.
//
// Exception assumée : la règle « `imageAlt` obligatoire si `image` renseignée »
// (accessibilité) n'est PAS liée à `statut` — elle est donc appliquée ici via
// `superRefine`, pas dans le script CI.
//
// Champ `image` : conservé en simple `z.string()` (chemin/URL), pas le helper
// `image()` d'astro:assets. Le dossier média cible (`public/uploads/` vs
// `src/assets/`) n'est pas encore tranché (risque §8.4) ; imposer `image()`
// supposerait un chemin résolvable par Vite relatif au fichier de contenu, ce
// qui n'est pas garanti tant que Pages CMS n'écrit pas dans ce dossier. À
// revoir une fois le risque §8.4 arbitré.

import { defineCollection, reference } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const slugPattern = /^[a-z0-9-]+$/;
const slugField = z
  .string()
  .regex(slugPattern, 'slug attendu en kebab-case ASCII sans accents (^[a-z0-9-]+$)');

const statutField = z.enum(['brouillon', 'publie']).default('brouillon');

const faqEntrySchema = z.object({
  question: z.string().min(1),
  reponse: z.string().min(1),
});

const villePrincipaleSchema = z.object({
  nom: z.string().min(1),
  prixM2: z.number().positive().optional(),
});

const categorieEnum = z.enum([
  'agence-immobiliere',
  'banque',
  'notaire',
  'diagnostiqueur',
  'courtier',
  'autre',
]);

const gabaritEnum = z.enum(['page-simple', 'article']);

/** Ajoute la règle « imageAlt obligatoire dès que image est renseignée ». */
function withImageAltRule<T extends z.ZodObject<{ image?: z.ZodTypeAny; imageAlt?: z.ZodTypeAny }>>(
  schema: T
) {
  return schema.superRefine((data: { image?: unknown; imageAlt?: unknown }, ctx: z.RefinementCtx) => {
    if (data.image && !data.imageAlt) {
      ctx.addIssue({
        code: 'custom',
        path: ['imageAlt'],
        message: "imageAlt est obligatoire dès qu'un champ image est renseigné (accessibilité).",
      });
    }
  });
}

/** Champs communs à `regions` et `departements` (§4.1, repris en base pour §4.2). */
function zonePrixShape() {
  return {
    slug: slugField,
    nom: z.string().min(1),
    title: z.string().min(1),
    metaTitle: z.string().optional(),
    metaDescription: z.string().min(50).max(160).optional(),
    // `intro` (corps Markdown) : non couvert ici, voir en-tête de fichier.
    analyseLocale: z.string().optional(),
    prixM2: z.number().positive().optional(),
    prixMaisons: z.number().positive().optional(),
    prixAppartements: z.number().positive().optional(),
    evolution12Mois: z.number().optional(),
    evolution5Ans: z.number().optional(),
    faq: z.array(faqEntrySchema).max(10).optional(),
    partenairesMisEnAvant: z.array(reference('partenaires')).max(6).optional(),
    image: z.string().optional(),
    imageAlt: z.string().optional(),
    statut: statutField,
    datePublication: z.coerce.date().optional(),
    dateMiseAJour: z.coerce.date().optional(),
    ordreAffichage: z.number().optional(),
  };
}

const regions = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/regions' }),
  schema: withImageAltRule(z.object(zonePrixShape())),
});

const departements = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/departements' }),
  schema: withImageAltRule(
    z.object({
      ...zonePrixShape(),
      codeInsee: z.string().regex(/^(\d{2,3}|2A|2B)$/, 'code INSEE attendu (2-3 chiffres, ou 2A/2B)'),
      // Optionnel au niveau du schéma : la référence doit exister au moment de
      // la publication (vérifié par le script CI), pas nécessairement pour un
      // brouillon. Voir aussi le rapport de migration pour le cas particulier
      // des départements d'outre-mer.
      regionParente: reference('regions').optional(),
      villesPrincipales: z.array(villePrincipaleSchema).max(8).optional(),
    })
  ),
});

const partenaires = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/partenaires' }),
  schema: z.object({
    slug: slugField,
    nom: z.string().min(1),
    logo: z.string().optional(),
    logoTexte: z.string().optional(),
    description: z.string().min(50).max(200).optional(),
    // `presentation` (corps Markdown) : non couvert ici, voir en-tête de fichier.
    categorie: categorieEnum.optional(),
    avantages: z.array(z.string().min(1)).max(6).optional(),
    zoneCouverture: z.array(z.union([reference('regions'), reference('departements')])).optional(),
    url: z.string().regex(/^https:\/\/.+/, "l'URL doit commencer par https://"),
    ctaLabel: z.string().default('Visiter le site'),
    statut: statutField,
    datePublication: z.coerce.date().optional(),
    dateMiseAJour: z.coerce.date().optional(),
    ordreAffichage: z.number().optional(),
  }),
});

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: withImageAltRule(
    z.object({
      slug: slugField,
      title: z.string().min(1),
      metaTitle: z.string().optional(),
      metaDescription: z.string().min(50).max(160).optional(),
      gabarit: gabaritEnum.default('page-simple'),
      // `contenu` (corps Markdown) : non couvert ici, voir en-tête de fichier.
      image: z.string().optional(),
      imageAlt: z.string().optional(),
      auteur: z.string().default('Équipe Estimer mon bien'),
      statut: statutField,
      datePublication: z.coerce.date().optional(),
      dateMiseAJour: z.coerce.date().optional(),
    })
  ),
});

export const collections = { regions, departements, partenaires, pages };
