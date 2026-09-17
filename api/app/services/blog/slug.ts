/**
 * Slug (specs/blog-automatisation-ia.md §4) : kebab-case ASCII, même motif que
 * `src/content.config.ts` côté site (`^[a-z0-9-]+$`).
 *
 * Ce motif est aussi la protection contre le path traversal : un slug (ou un
 * id d'auteur) qui le respecte ne peut contenir ni `/`, ni `..`, ni aucun
 * caractère capable de sortir du dossier cible. Toute route qui reçoit un
 * `:slug`/`:id` en paramètre d'URL DOIT le vérifier avec `isValidSlug` avant
 * de construire un chemin de fichier.
 */
export const SLUG_PATTERN = /^[a-z0-9-]+$/

export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value)
}

/**
 * Dérive un slug kebab-case ASCII à partir d'un titre libre (§4 : « slug
 * absent → dérivé du title »). Les accents sont translittérés (NFD + retrait
 * des diacritiques) avant le nettoyage, pour qu'un titre français produise un
 * slug lisible plutôt qu'une suite de tirets.
 */
export function slugify(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
}
