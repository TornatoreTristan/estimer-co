import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface BlogCategory {
  slug: string
  label: string
  description: string
}

/**
 * Dernier import réussi de `src/lib/blog.ts` — revue QA, mineur 7.
 *
 * Import dynamique du fichier TypeScript : Node exécute nativement les
 * modules `.ts` (même mécanisme que `scripts/test-blog-content.mjs` côté
 * site). Ce fichier change d'une branche à l'autre dans la MÊME copie de
 * travail (nouvelle branche `blog-ia/*` checkoutée pour chaque opération) —
 * il faut donc pouvoir invalider un import périmé, ce que Node ne permet pas
 * de faire sur une URL déjà importée : l'ancienne approche ajoutait
 * `?t=<mtime>` à l'URL pour forcer un nouvel import à chaque changement.
 *
 * Problème : `git checkout` réécrit le fichier sur disque (donc change son
 * `mtime`) même quand son CONTENU est strictement identique à ce qu'il était
 * déjà — ce qui est le cas de `src/lib/blog.ts` la plupart du temps, les
 * catégories ne changeant qu'à de rares déploiements. Sur un process de
 * longue durée qui traite de nombreuses opérations (chaque upsert/publish
 * change de branche), ça déclenchait un `import()` avec une URL JAMAIS VUE à
 * chaque appel — et Node ne libère jamais un module déjà importé par
 * `import()` dynamique : le cache d'import croît sans borne.
 *
 * Cette version ne réimporte que si le CONTENU du fichier a changé (hash
 * SHA-256, comparé au dernier import), et ne garde qu'UNE seule entrée en
 * mémoire (le dernier résultat) — jamais une table qui grossit. Une branche
 * dont le contenu de `blog.ts` est identique à la précédente ne déclenche
 * donc plus aucun nouvel `import()`.
 */
let lastImport: { contentHash: string; categories: BlogCategory[] } | null = null

/**
 * Source unique des catégories : `src/lib/blog.ts` DANS LA COPIE DE TRAVAIL
 * (spec : « enum catégorie lue depuis la copie de travail ou src/lib/blog.ts »)
 * — jamais une liste dupliquée côté API, qui divergerait silencieusement du
 * site le jour où un silo est ajouté ou renommé.
 */
export async function readCategories(workdir: string): Promise<BlogCategory[]> {
  const path = join(workdir, 'src/lib/blog.ts')
  const contentHash = createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex')

  if (lastImport && lastImport.contentHash === contentHash) {
    return lastImport.categories
  }

  const url = `${pathToFileURL(path).href}?contentHash=${contentHash}`
  const mod = (await import(url)) as { CATEGORIES: readonly BlogCategory[] }
  const categories = [...mod.CATEGORIES]
  lastImport = { contentHash, categories }
  return categories
}

export async function isKnownCategory(workdir: string, slug: string): Promise<boolean> {
  const categories = await readCategories(workdir)
  return categories.some((category) => category.slug === slug)
}
