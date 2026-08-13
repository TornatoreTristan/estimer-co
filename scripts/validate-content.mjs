#!/usr/bin/env node
/**
 * Garde-fou CI — à exécuter avant `astro build` (cf. specs/cms-seo-tracking.md
 * §3 A3/C5/D1-D2, §4 "Gate de publication", §5 slugs réservés, Lot 0 §2 point 4).
 *
 * Ce script ne réimplémente PAS ce que `src/content.config.ts` (Zod) valide
 * déjà : types, patterns, bornes numériques, unions/enums, et la règle
 * "imageAlt obligatoire si image" sont garantis en amont par le schéma — s'ils
 * étaient faux, `astro sync`/`astro build` aurait déjà échoué avant même
 * d'arriver ici. Ce script couvre exactement ce que Zod ne peut PAS vérifier :
 *
 *   1. Les "gates de publication" du §4 : présence de champs qui sont
 *      `.optional()` dans le schéma (metaDescription, dateMiseAJour, faq…)
 *      MAIS obligatoires dès que `statut: publie`. Un brouillon incomplet ne
 *      fait donc JAMAIS échouer ce script — seule une entrée `publie`
 *      incomplète le fait.
 *   2. Les contraintes de longueur sur le corps Markdown (`intro`,
 *      `presentation`, `contenu`) : Zod ne valide que le frontmatter, jamais
 *      le corps.
 *   3. Des invariants transverses qu'un schéma par-entrée ne peut pas
 *      exprimer : unicité de slug entre plusieurs fichiers/collections,
 *      liste de slugs réservés, existence effective d'une référence
 *      (`regionParente`) dans la collection cible.
 *
 * Sortie : rapport texte groupé par fichier, code de sortie 1 si au moins une
 * ERREUR (les AVERTISSEMENTS n'affectent jamais le code de sortie).
 *
 * Décision documentée — `regionParente doit référencer une région existante` :
 * la consigne place cette règle dans la liste des vérifications "toujours
 * actives" (avec l'unicité des slugs et les slugs réservés), en dehors de la
 * liste des gates conditionnées par `statut: publie`. Mais le §4.2 la décrit
 * aussi comme une "Gate additionnelle" de publication, et la migration Lot 0
 * a un écart de données connu et documenté (les 5 départements d'outre-mer
 * n'ont pas de région correspondante dans les 13 régions existantes — voir
 * `scripts/migrate-legacy-data.mjs`). Pour concilier les deux lectures sans
 * jamais faire échouer un brouillon connu-incomplet : cette règle est ERREUR
 * bloquante pour `statut: publie`, et AVERTISSEMENT (non bloquant) pour
 * `statut: brouillon`. À confirmer avec le PO — voir rapport de livraison.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const CONTENT_DIR = join(ROOT, 'src/content');

// Slugs réservés pour la collection `pages` — cf. specs §5.
const RESERVED_PAGE_SLUGS = new Set([
  'estimation',
  'carte',
  'contact',
  'rapport',
  'partenaires',
  'estimation-immobiliere',
  'pages',
  'sitemap.xml',
  'index',
]);

const CHIFFRE_FIELDS = ['prixM2', 'prixMaisons', 'prixAppartements', 'evolution12Mois', 'evolution5Ans'];

/** @typedef {{ level: 'error' | 'warning', file: string, field: string, message: string }} Issue */

/** @type {Issue[]} */
const issues = [];

function addError(file, field, message) {
  issues.push({ level: 'error', file, field, message });
}

function addWarning(file, field, message) {
  issues.push({ level: 'warning', file, field, message });
}

function isPresent(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return !Number.isNaN(value);
  return true;
}

function wordCount(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ') // ignore les marqueurs de rédaction du script de migration
    .split(/\s+/)
    .filter(Boolean).length;
}

function bodyCharCount(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim().length;
}

// -----------------------------------------------------------------------------
// Lecture des collections
// -----------------------------------------------------------------------------

function readEntries(collection) {
  const dir = join(CONTENT_DIR, collection);
  let filenames;
  try {
    filenames = readdirSync(dir);
  } catch {
    return [];
  }

  return filenames
    .filter((filename) => extname(filename) === '.md')
    .sort()
    .map((filename) => {
      const filePath = join(dir, filename);
      const relPath = `src/content/${collection}/${filename}`;
      const raw = readFileSync(filePath, 'utf8');
      const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

      if (!match) {
        addError(relPath, 'frontmatter', 'Délimiteurs YAML "---" introuvables ou frontmatter mal formé.');
        return { collection, filename, relPath, data: {}, body: '' };
      }

      let data;
      try {
        data = parseYaml(match[1]) ?? {};
      } catch (error) {
        addError(relPath, 'frontmatter', `YAML invalide : ${error instanceof Error ? error.message : String(error)}`);
        data = {};
      }

      return { collection, filename, relPath, data, body: (match[2] ?? '').trim() };
    });
}

const entriesByCollection = Object.fromEntries(
  ['regions', 'departements', 'partenaires', 'pages'].map((c) => [c, readEntries(c)])
);

// -----------------------------------------------------------------------------
// 1. Unicité des slugs — regions ∪ departements (même préfixe /estimation-immobiliere/)
// -----------------------------------------------------------------------------
// Toujours vérifié, quel que soit `statut` : une collision de slug écrase
// silencieusement une page par l'autre au build, ce n'est jamais acceptable,
// même en brouillon.

function checkSlugUniqueness(entries, label) {
  const bySlug = new Map();
  for (const entry of entries) {
    const slug = entry.data?.slug;
    if (!isPresent(slug)) continue; // absence de slug déjà signalée ailleurs (zod)
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(entry);
  }
  for (const [slug, group] of bySlug) {
    if (group.length > 1) {
      const files = group.map((e) => e.relPath).join(', ');
      for (const entry of group) {
        addError(entry.relPath, 'slug', `slug "${slug}" en conflit dans ${label} avec : ${files}`);
      }
    }
  }
}

checkSlugUniqueness([...entriesByCollection.regions, ...entriesByCollection.departements], 'regions ∪ departements');
checkSlugUniqueness(entriesByCollection.partenaires, 'partenaires');
checkSlugUniqueness(entriesByCollection.pages, 'pages');

// -----------------------------------------------------------------------------
// 2. Slugs réservés — collection `pages`
// -----------------------------------------------------------------------------
// Toujours vérifié, quel que soit `statut` (specs §5 : "à vérifier en CI, pas
// seulement à documenter" — un brouillon nommé "contact" est déjà dangereux).

for (const entry of entriesByCollection.pages) {
  const slug = entry.data?.slug;
  if (isPresent(slug) && RESERVED_PAGE_SLUGS.has(slug)) {
    addError(entry.relPath, 'slug', `slug "${slug}" réservé (collision avec une route existante) — voir specs §5.`);
  }
}

// -----------------------------------------------------------------------------
// 3. regionParente doit référencer une région existante
// -----------------------------------------------------------------------------

const knownRegionSlugs = new Set(entriesByCollection.regions.map((e) => e.data?.slug).filter(isPresent));

for (const entry of entriesByCollection.departements) {
  const regionParente = entry.data?.regionParente;
  const statut = entry.data?.statut ?? 'brouillon';

  if (!isPresent(regionParente)) {
    if (statut === 'publie') {
      addError(entry.relPath, 'regionParente', 'regionParente manquant (obligatoire pour publication — Gate §4.2).');
    }
    continue;
  }

  if (!knownRegionSlugs.has(regionParente)) {
    const message = `regionParente="${regionParente}" ne correspond à aucune entrée de src/content/regions/.`;
    if (statut === 'publie') {
      addError(entry.relPath, 'regionParente', message);
    } else {
      addWarning(entry.relPath, 'regionParente', `${message} (brouillon : non bloquant, voir en-tête de ce script)`);
    }
  }
}

// -----------------------------------------------------------------------------
// 4. Gates de publication (§4) — uniquement pour statut = publie
// -----------------------------------------------------------------------------

function checkZonePrixGate(entry, { isDepartement }) {
  const { data, body, relPath } = entry;

  if (!isPresent(data.metaDescription)) {
    addError(relPath, 'metaDescription', 'manquant (obligatoire pour publication).');
  }

  const introLength = bodyCharCount(body);
  if (introLength === 0) {
    addError(relPath, 'intro', 'corps de page vide (obligatoire pour publication).');
  } else if (introLength < 400) {
    addError(relPath, 'intro', `corps de page trop court (${introLength} caractères, 400 minimum requis).`);
  }

  for (const field of CHIFFRE_FIELDS) {
    if (!isPresent(data[field])) {
      addError(relPath, field, 'manquant (les 5 champs chiffrés sont obligatoires pour publication).');
    }
  }

  const faq = Array.isArray(data.faq) ? data.faq : [];
  if (faq.length < 2) {
    addError(relPath, 'faq', `${faq.length} entrée(s) FAQ (2 minimum requis pour publication — anti thin-content).`);
  }

  if (!isPresent(data.dateMiseAJour)) {
    addError(relPath, 'dateMiseAJour', 'manquant (obligatoire pour publication, affichage E-E-A-T).');
  }

  if (isDepartement && !isPresent(data.regionParente)) {
    addError(relPath, 'regionParente', 'manquant (Gate additionnelle §4.2, obligatoire pour publication).');
  }
}

for (const entry of entriesByCollection.regions) {
  if (entry.data?.statut === 'publie') checkZonePrixGate(entry, { isDepartement: false });
}

for (const entry of entriesByCollection.departements) {
  if (entry.data?.statut === 'publie') checkZonePrixGate(entry, { isDepartement: true });
}

for (const entry of entriesByCollection.partenaires) {
  const { data, body, relPath } = entry;
  if (data?.statut !== 'publie') continue;

  if (!isPresent(data.description)) {
    addError(relPath, 'description', 'manquant (obligatoire pour publication).');
  }
  if (!isPresent(data.categorie)) {
    addError(relPath, 'categorie', 'manquant (obligatoire pour publication).');
  }
  if (!isPresent(data.url)) {
    // Filet de sécurité : `url` est déjà `required` dans le schéma Zod, donc
    // ce cas ne devrait jamais se produire (le build aurait échoué avant).
    addError(relPath, 'url', 'manquant (obligatoire pour publication).');
  }

  const presentationLength = bodyCharCount(body);
  if (presentationLength === 0) {
    addError(relPath, 'presentation', 'corps de page vide (obligatoire pour publication).');
  } else {
    const words = wordCount(body);
    if (words < 300) {
      addWarning(relPath, 'presentation', `${words} mot(s) (≥ 300 mots recommandé, non bloquant).`);
    }
  }
}

for (const entry of entriesByCollection.pages) {
  const { data, body, relPath } = entry;
  if (data?.statut !== 'publie') continue;

  if (!isPresent(data.metaDescription)) {
    addError(relPath, 'metaDescription', 'manquant (obligatoire pour publication).');
  }
  if (bodyCharCount(body) === 0) {
    addError(relPath, 'contenu', 'corps de page vide (obligatoire pour publication).');
  }
  if (data.gabarit === 'article') {
    if (!isPresent(data.datePublication)) {
      addError(relPath, 'datePublication', 'manquant (obligatoire pour publication d\'un article).');
    }
    if (!isPresent(data.dateMiseAJour)) {
      addError(relPath, 'dateMiseAJour', 'manquant (obligatoire pour publication d\'un article).');
    }
  }
}

// -----------------------------------------------------------------------------
// Rapport
// -----------------------------------------------------------------------------

const errors = issues.filter((i) => i.level === 'error');
const warnings = issues.filter((i) => i.level === 'warning');

const totalEntries = Object.values(entriesByCollection).reduce((sum, e) => sum + e.length, 0);
const publishedEntries = Object.values(entriesByCollection)
  .flat()
  .filter((e) => e.data?.statut === 'publie').length;

console.log(`\nValidation du contenu — ${totalEntries} entrées lues (${publishedEntries} publiée(s)).\n`);

if (issues.length === 0) {
  console.log('Aucun problème détecté.\n');
} else {
  const byFile = new Map();
  for (const issue of issues) {
    if (!byFile.has(issue.file)) byFile.set(issue.file, []);
    byFile.get(issue.file).push(issue);
  }
  for (const [file, fileIssues] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(file);
    for (const issue of fileIssues) {
      const tag = issue.level === 'error' ? 'ERREUR ' : 'AVERTIR';
      console.log(`  [${tag}] ${issue.field} — ${issue.message}`);
    }
  }
  console.log('');
}

console.log(`Résumé : ${errors.length} erreur(s), ${warnings.length} avertissement(s).\n`);

if (errors.length > 0) {
  console.error('Validation échouée.');
  process.exit(1);
}

console.log('Validation réussie (le build peut continuer).');
process.exit(0);
