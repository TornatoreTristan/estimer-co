/**
 * Auteurs des articles du blog.
 *
 * Le frontmatter d'un article ne porte que l'identifiant (`auteur:
 * tristan-tornatore`) : nom, fonction et biographie vivent ici, une seule
 * fois, pour rester identiques sur tous les articles (en-tête, encadré
 * « À propos de l'auteur » et JSON-LD `Person`, qui nourrit l'E-E-A-T).
 *
 * Depuis specs/blog-automatisation-ia.md §1.1, chaque auteur est un fichier
 * `src/content/auteurs/<id>.json` (l'id est le nom de fichier, sans
 * extension) : l'agent IA peut en créer un nouveau (via l'API `api/`) sans
 * toucher au code. Ce module reste un loader synchrone qui lit ce dossier au
 * chargement — même contrat qu'avant (`AUTEURS`, `AUTEUR_IDS`,
 * `AUTEUR_PAR_DEFAUT`) pour ne rien changer au rendu ni à
 * `src/content.config.ts`.
 *
 * Module pur, sans import Astro : `src/content.config.ts` en tire l'enum du
 * champ `auteur`, et les tests l'importent directement. `readdirSync` (plutôt
 * que `import.meta.glob`, propre à Vite) marche à la fois sous Astro/Vite et
 * sous `node --test` — Node exécute nativement ce fichier TypeScript sans
 * transpilation côté projet.
 *
 * Résolution du dossier via `process.cwd()`, pas `import.meta.url` : Astro
 * bundle ce module et déplace les chunks pendant `astro build`
 * (`.astro/.prerender/chunks/…`), ce qui casserait un chemin relatif au
 * fichier source (constaté : `ENOENT .astro/.prerender/content/auteurs`).
 * `astro dev`/`astro build`/`node --test` sont toujours lancés depuis la
 * racine du projet (voir `package.json`), ce qui rend `process.cwd()` fiable
 * dans les deux environnements.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type TypeLien = 'linkedin' | 'x' | 'site' | 'email';

export interface LienAuteur {
  type: TypeLien;
  /** URL absolue, ou `mailto:` pour l'email. */
  url: string;
  /** Texte visible à côté de l'icône. */
  texte: string;
  /** Nom accessible complet du lien. */
  libelle: string;
}

export interface Auteur {
  id: string;
  nom: string;
  fonction: string;
  bio: string;
  /** Chemin sous `public/`, carré, au moins 240 px de côté. */
  photo?: string;
  /** Affichées à la place de la photo quand la fiche n'en a pas. */
  initiales: string;
  liens: readonly LienAuteur[];
}

/** Forme d'un fichier `src/content/auteurs/<id>.json` : un `Auteur` sans `id` (l'id est le nom de fichier). */
type FicheAuteurJson = Omit<Auteur, 'id'>;

// Racine du projet -> `src/content/auteurs`.
const AUTEURS_DIR = join(process.cwd(), 'src/content/auteurs');

/**
 * Schémas d'URL autorisés pour `liens[].url` — défense en profondeur (revue
 * QA, majeur 2), même règle que `api/app/validators/blog_auteur.ts`
 * (`assertLienUrlSchemes`), qui est censée avoir déjà refusé le reste avant
 * l'écriture du fichier. Ce garde-ci protège contre une fiche qui aurait
 * contourné cette validation (édition manuelle du JSON, régression future de
 * l'API…) : `AuteurEncart.astro` rend `lien.url` tel quel en `href` — un
 * schéma `javascript:` non filtré ici s'exécuterait au clic.
 */
const HTTP_URL_PATTERN = /^https?:\/\/.+/i;
const MAILTO_PATTERN = /^mailto:.+/i;

/** Vrai si `url` a un schéma autorisé pour ce `type` de lien. */
export function estLienUrlAutorisee(type: TypeLien, url: string): boolean {
  return (type === 'email' ? MAILTO_PATTERN : HTTP_URL_PATTERN).test(url);
}

/** Lit tous les fichiers `src/content/auteurs/*.json` et construit la table indexée par id. */
function chargerAuteurs(): Record<string, Auteur> {
  const fichiers = readdirSync(AUTEURS_DIR).filter((nom) => nom.endsWith('.json'));
  const auteurs: Record<string, Auteur> = {};

  for (const fichier of fichiers) {
    const id = fichier.slice(0, -'.json'.length);
    const fiche = JSON.parse(readFileSync(join(AUTEURS_DIR, fichier), 'utf8')) as FicheAuteurJson;
    auteurs[id] = {
      id,
      ...fiche,
      liens: fiche.liens.filter((lien) => estLienUrlAutorisee(lien.type, lien.url)),
    };
  }

  return auteurs;
}

export const AUTEURS: Record<string, Auteur> = chargerAuteurs();

/**
 * Identifiant d'auteur. Avant le passage en JSON, ce type était une union
 * littérale (`keyof typeof AUTEURS` sur un objet `as const`) : le contenu du
 * dossier `src/content/auteurs/` n'étant connu qu'à l'exécution, il ne peut
 * plus être qu'un `string` — la validation de forme (auteur connu ou non)
 * reste faite par l'enum Zod ci-dessous et par l'API pour les auteurs créés
 * par l'IA.
 */
export type AuteurId = string;

const idsAuteurs = Object.keys(AUTEURS);
if (idsAuteurs.length === 0) {
  throw new Error('Aucun auteur trouvé dans src/content/auteurs/ — au moins un fichier est requis.');
}

// `z.enum` (src/content.config.ts) exige un tuple non vide : le garde ci-dessus
// le garantit à l'exécution, d'où ce seul `as` du fichier.
export const AUTEUR_IDS = idsAuteurs as [AuteurId, ...AuteurId[]];

export const AUTEUR_PAR_DEFAUT: AuteurId = 'tristan-tornatore';

/**
 * Profils à déclarer en `sameAs` dans le JSON-LD : uniquement ceux qui
 * désignent la personne elle-même (pas un site d'entreprise ni un email).
 */
export function getProfilsSociaux(auteur: Auteur): string[] {
  return auteur.liens.filter((lien) => lien.type === 'linkedin' || lien.type === 'x').map((lien) => lien.url);
}

export function getAuteur(id: AuteurId): Auteur {
  const auteur = AUTEURS[id];
  if (!auteur) {
    throw new Error(`Auteur "${id}" introuvable dans src/content/auteurs/.`);
  }
  return auteur;
}
