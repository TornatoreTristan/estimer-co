#!/usr/bin/env node
/**
 * Migration one-off : `src/data/prix.ts` + `src/data/partenaires.ts`
 * -> `src/content/{regions,departements,partenaires}/*.md`
 *
 * cf. specs/cms-seo-tracking.md §2 (modèles), §4 (schémas), §5 (slugs), Lot 0.
 *
 * Usage :
 *   node scripts/migrate-legacy-data.mjs           # écrit les fichiers manquants
 *   node scripts/migrate-legacy-data.mjs --force    # écrase aussi les existants
 *   node scripts/migrate-legacy-data.mjs --dry-run  # n'écrit rien, affiche le plan
 *
 * Idempotence : par défaut, un fichier déjà présent n'est JAMAIS écrasé (un
 * éditeur a pu commencer à le rédiger). `--force` est requis explicitement
 * pour regénérer un fichier existant depuis les données legacy.
 *
 * Toutes les entrées générées ont `statut: brouillon` — rien n'est publié
 * automatiquement (voir Lot 0 des specs).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONTENT_DIR = join(ROOT, 'src/content');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');

// -----------------------------------------------------------------------------
// Chargement des données legacy (TypeScript) sans dépendance de build.
// -----------------------------------------------------------------------------
// `src/data/*.ts` ne contient que des littéraux d'objet avec, au plus, une
// annotation de type sur la déclaration `export const <nom>: <Type> = ...`.
// On retire ces annotations (seule syntaxe non-JS du fichier) puis on importe
// le résultat via une data: URL — pas de nouvelle dépendance (ts-node/tsx),
// pas de fichier temporaire laissé sur le disque.
async function loadTsDataModule(relativePath) {
  const absolutePath = join(ROOT, relativePath);
  let code = readFileSync(absolutePath, 'utf8');

  // Supprime les blocs `export interface Nom { ... }` (aucune accolade imbriquée
  // dans ces interfaces, un remplacement non-gourmand jusqu'à la première `}` suffit).
  code = code.replace(/export interface \w+\s*\{[\s\S]*?\}\n/g, '');

  // Supprime l'annotation de type entre l'identifiant et `=` sur les
  // déclarations exportées, ex. `export const x: Record<string, Y> = {`
  // devient `export const x = {`.
  code = code.replace(/^(export const \w+)\s*:\s*[^=]+(=)/gm, '$1 $2');

  const dataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
  return import(dataUrl);
}

// -----------------------------------------------------------------------------
// Table de correspondance code INSEE -> slug de région
// -----------------------------------------------------------------------------
// Couvre les 101 départements (96 métropole + 5 DOM + 2A/2B). Toute absence
// fait échouer le script bruyamment (cf. assertion plus bas) : un
// rattachement manquant ou faux produit un maillage interne SEO erroné.
//
// Régions métropolitaines : correspondance vers les 13 clés de
// `regionsData` (découpage administratif 2016, vérifié département par
// département).
//
// DOM (971/972/973/974/976) : `regionsData` ne contient QUE les 13 régions
// métropolitaines — aucune région d'outre-mer n'y figure. Administrativement,
// la Guadeloupe, la Martinique, la Guyane, La Réunion et Mayotte sont chacune
// une région mono-départementale : il n'existe donc PAS de rattachement
// correct vers l'une des 13 régions existantes. Plutôt que d'inventer un
// rattachement géographiquement faux (ce que les specs interdisent
// explicitement), ces 5 départements sont rattachés à leur slug de région
// réel (`guadeloupe`, `martinique`, `guyane`, `la-reunion`, `mayotte`), MÊME
// SI aucune entrée `regions` correspondante n'est générée ici (les specs et
// la tâche demandent exactement 13 régions, celles de `regionsData`).
// Conséquence assumée, documentée dans le rapport de migration : ces 5
// départements ont un `regionParente` qui ne résout vers aucune entrée tant
// qu'un éditeur n'aura pas créé ces 5 régions manquantes dans le CMS (ou que
// le produit décide d'un autre traitement). `scripts/validate-content.mjs`
// n'échoue pas là-dessus pour un brouillon (voir ce script), mais avertit.
const REGION_BY_DEPT_CODE = Object.freeze({
  // Île-de-France (8)
  75: 'ile-de-france',
  77: 'ile-de-france',
  78: 'ile-de-france',
  91: 'ile-de-france',
  92: 'ile-de-france',
  93: 'ile-de-france',
  94: 'ile-de-france',
  95: 'ile-de-france',
  // Provence-Alpes-Côte d'Azur (6)
  '04': 'provence-alpes-cote-azur',
  '05': 'provence-alpes-cote-azur',
  '06': 'provence-alpes-cote-azur',
  13: 'provence-alpes-cote-azur',
  83: 'provence-alpes-cote-azur',
  84: 'provence-alpes-cote-azur',
  // Corse (2)
  '2A': 'corse',
  '2B': 'corse',
  // Auvergne-Rhône-Alpes (12)
  '01': 'auvergne-rhone-alpes',
  '03': 'auvergne-rhone-alpes',
  '07': 'auvergne-rhone-alpes',
  15: 'auvergne-rhone-alpes',
  26: 'auvergne-rhone-alpes',
  38: 'auvergne-rhone-alpes',
  42: 'auvergne-rhone-alpes',
  43: 'auvergne-rhone-alpes',
  63: 'auvergne-rhone-alpes',
  69: 'auvergne-rhone-alpes',
  73: 'auvergne-rhone-alpes',
  74: 'auvergne-rhone-alpes',
  // Pays de la Loire (5)
  44: 'pays-de-la-loire',
  49: 'pays-de-la-loire',
  53: 'pays-de-la-loire',
  72: 'pays-de-la-loire',
  85: 'pays-de-la-loire',
  // Nouvelle-Aquitaine (12)
  16: 'nouvelle-aquitaine',
  17: 'nouvelle-aquitaine',
  19: 'nouvelle-aquitaine',
  23: 'nouvelle-aquitaine',
  24: 'nouvelle-aquitaine',
  33: 'nouvelle-aquitaine',
  40: 'nouvelle-aquitaine',
  47: 'nouvelle-aquitaine',
  64: 'nouvelle-aquitaine',
  79: 'nouvelle-aquitaine',
  86: 'nouvelle-aquitaine',
  87: 'nouvelle-aquitaine',
  // Bretagne (4)
  22: 'bretagne',
  29: 'bretagne',
  35: 'bretagne',
  56: 'bretagne',
  // Occitanie (13)
  '09': 'occitanie',
  11: 'occitanie',
  12: 'occitanie',
  30: 'occitanie',
  31: 'occitanie',
  32: 'occitanie',
  34: 'occitanie',
  46: 'occitanie',
  48: 'occitanie',
  65: 'occitanie',
  66: 'occitanie',
  81: 'occitanie',
  82: 'occitanie',
  // Normandie (5)
  14: 'normandie',
  27: 'normandie',
  50: 'normandie',
  61: 'normandie',
  76: 'normandie',
  // Hauts-de-France (5)
  '02': 'hauts-de-france',
  59: 'hauts-de-france',
  60: 'hauts-de-france',
  62: 'hauts-de-france',
  80: 'hauts-de-france',
  // Grand Est (10)
  '08': 'grand-est',
  10: 'grand-est',
  51: 'grand-est',
  52: 'grand-est',
  54: 'grand-est',
  55: 'grand-est',
  57: 'grand-est',
  67: 'grand-est',
  68: 'grand-est',
  88: 'grand-est',
  // Centre-Val de Loire (6)
  18: 'centre-val-de-loire',
  28: 'centre-val-de-loire',
  36: 'centre-val-de-loire',
  37: 'centre-val-de-loire',
  41: 'centre-val-de-loire',
  45: 'centre-val-de-loire',
  // Bourgogne-Franche-Comté (8)
  21: 'bourgogne-franche-comte',
  25: 'bourgogne-franche-comte',
  39: 'bourgogne-franche-comte',
  58: 'bourgogne-franche-comte',
  70: 'bourgogne-franche-comte',
  71: 'bourgogne-franche-comte',
  89: 'bourgogne-franche-comte',
  90: 'bourgogne-franche-comte',
  // DOM (5) — voir commentaire ci-dessus : aucune région existante dans
  // `regionsData`, rattachement au slug réel malgré tout.
  971: 'guadeloupe',
  972: 'martinique',
  973: 'guyane',
  974: 'la-reunion',
  976: 'mayotte',
});

const REGION_SLUGS_WITHOUT_ENTRY = new Set(['guadeloupe', 'martinique', 'guyane', 'la-reunion', 'mayotte']);

// -----------------------------------------------------------------------------
// Utilitaires
// -----------------------------------------------------------------------------

/** kebab-case ASCII sans accents, ex. "Côte-d'Or" -> "cote-d-or". */
function slugify(input) {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "Aube (10)" -> { nom: "Aube", code: "10" } ; "Corse-du-Sud (2A)" -> { nom, code: "2A" }. */
function parseDepartementName(rawName) {
  const match = rawName.match(/^(.+)\s\((\d{2,3}|2A|2B)\)$/);
  if (!match) {
    throw new Error(`Impossible d'extraire nom/code depuis "${rawName}" (format attendu "Nom (CODE)")`);
  }
  return { nom: match[1], code: match[2] };
}

function frontmatterBlock(data) {
  // `stringify` (paquet `yaml`) échappe correctement apostrophes, accents,
  // deux-points etc. — bien plus sûr qu'une concaténation de chaînes.
  return `---\n${stringify(data, { lineWidth: 0 })}---\n`;
}

function writeContentFile(collectionDir, slug, frontmatterData, body) {
  const dir = join(CONTENT_DIR, collectionDir);
  const filePath = join(dir, `${slug}.md`);
  const relativeForLog = `src/content/${collectionDir}/${slug}.md`;

  if (existsSync(filePath) && !FORCE) {
    return { status: 'skipped', path: relativeForLog };
  }

  const content = frontmatterBlock(frontmatterData) + (body ?? '') + '\n';

  if (!DRY_RUN) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }

  return { status: existsSync(filePath) && FORCE ? 'overwritten' : 'created', path: relativeForLog };
}

function draftPlaceholder(comment) {
  return `<!-- ${comment} -->\n`;
}

// -----------------------------------------------------------------------------
// Migration
// -----------------------------------------------------------------------------

async function main() {
  const { regionsData, departementsData } = await loadTsDataModule('src/data/prix.ts');
  const { partenaires } = await loadTsDataModule('src/data/partenaires.ts');

  const deptCodes = Object.keys(departementsData);
  const unmapped = deptCodes.filter((code) => !(code in REGION_BY_DEPT_CODE));
  if (unmapped.length > 0) {
    console.error(
      `\nERREUR : ${unmapped.length} code(s) INSEE de departementsData sans correspondance région : ${unmapped.join(', ')}\n` +
        `Complète la table REGION_BY_DEPT_CODE dans ce script avant de relancer la migration.\n`
    );
    process.exit(1);
  }

  const results = { regions: [], departements: [], partenaires: [] };
  const warnings = [];

  // --- Régions -------------------------------------------------------------
  const regionEntries = Object.entries(regionsData);
  regionEntries.forEach(([slug, zone], index) => {
    const frontmatter = {
      slug,
      nom: zone.name,
      title: `Prix immobilier au m² — ${zone.name}`,
      prixM2: zone.price,
      prixMaisons: zone.maisons,
      prixAppartements: zone.apparts,
      evolution12Mois: zone.evol12,
      evolution5Ans: zone.evol5,
      statut: 'brouillon',
      ordreAffichage: index + 1,
    };
    const body = draftPlaceholder(
      "Contenu à rédiger par l'éditeur (intro ≥ 400 caractères requis avant publication, voir specs/cms-seo-tracking.md §4.1)."
    );
    results.regions.push(writeContentFile('regions', slug, frontmatter, body));
  });

  // --- Départements ----------------------------------------------------------
  Object.entries(departementsData).forEach(([code, zone], index) => {
    const { nom, code: extractedCode } = parseDepartementName(zone.name);
    if (extractedCode !== code) {
      // Garde-fou : la clé de l'objet et le code entre parenthèses doivent concorder.
      throw new Error(`Incohérence de code pour "${zone.name}" : clé="${code}" vs extrait="${extractedCode}"`);
    }
    const slug = `${slugify(nom)}-${code.toLowerCase()}`;
    const regionParente = REGION_BY_DEPT_CODE[code];

    if (REGION_SLUGS_WITHOUT_ENTRY.has(regionParente)) {
      warnings.push(
        `${slug} : regionParente="${regionParente}" ne correspond à aucune entrée régions générée (DOM sans région dans regionsData — voir en-tête du script).`
      );
    }

    const frontmatter = {
      slug,
      nom,
      title: `Prix immobilier au m² — ${nom}`,
      codeInsee: code,
      regionParente,
      prixM2: zone.price,
      prixMaisons: zone.maisons,
      prixAppartements: zone.apparts,
      evolution12Mois: zone.evol12,
      evolution5Ans: zone.evol5,
      statut: 'brouillon',
      ordreAffichage: index + 1,
    };
    const body = draftPlaceholder(
      "Contenu à rédiger par l'éditeur (intro ≥ 400 caractères, ≥ 2 entrées FAQ requises avant publication, voir specs/cms-seo-tracking.md §4.2)."
    );
    results.departements.push(writeContentFile('departements', slug, frontmatter, body));
  });

  // --- Partenaires -----------------------------------------------------------
  partenaires.forEach((partenaire, index) => {
    const slug = slugify(partenaire.name);
    const frontmatter = {
      slug,
      nom: partenaire.name,
      logoTexte: partenaire.logo,
      description: partenaire.description,
      // Valeur par défaut plausible en attendant l'arbitrage éditorial — NE
      // PAS considérer comme fiable, à corriger partenaire par partenaire.
      categorie: 'agence-immobiliere',
      url: partenaire.url,
      statut: 'brouillon',
      ordreAffichage: index + 1,
    };
    // Volontairement PAS `partenaire.description` recopiée ici : specs §8
    // risque 7, ces descriptions sont déjà génériques, un vrai travail de
    // rédaction est nécessaire avant publication.
    const body = draftPlaceholder(
      "Présentation à rédiger par l'éditeur (≥ 300 mots recommandé, contenu différenciant — ne pas recopier `description`, voir specs/cms-seo-tracking.md §8 risque 7)."
    );
    results.partenaires.push(writeContentFile('partenaires', slug, frontmatter, body));
  });

  // --- Rapport ---------------------------------------------------------------
  const summarize = (label, entries) => {
    const created = entries.filter((e) => e.status === 'created').length;
    const overwritten = entries.filter((e) => e.status === 'overwritten').length;
    const skipped = entries.filter((e) => e.status === 'skipped').length;
    console.log(
      `${label} : ${entries.length} attendues — ${created} créée(s), ${overwritten} écrasée(s), ${skipped} ignorée(s) (déjà existantes)`
    );
    if (skipped > 0) {
      entries
        .filter((e) => e.status === 'skipped')
        .forEach((e) => console.log(`  - ignoré (déjà présent, relancer avec --force pour écraser) : ${e.path}`));
    }
  };

  console.log(`\n${DRY_RUN ? '[dry-run] ' : ''}Migration terminée.\n`);
  summarize('regions', results.regions);
  summarize('departements', results.departements);
  summarize('partenaires', results.partenaires);

  const total = results.regions.length + results.departements.length + results.partenaires.length;
  console.log(`\nTotal : ${total} entrées traitées.`);

  if (warnings.length > 0) {
    console.log(`\n${warnings.length} avertissement(s) (non bloquants) :`);
    warnings.forEach((w) => console.log(`  - ${w}`));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
