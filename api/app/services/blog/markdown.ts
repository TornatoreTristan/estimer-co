import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/**
 * Construction/lecture du frontmatter d'un article ou d'une fiche auteur —
 * TOUJOURS via la librairie YAML (`yaml`), jamais par concaténation de
 * chaînes (contrainte explicite : un titre ou un extrait contenant `:` ou des
 * guillemets casserait un frontmatter construit à la main, et ouvrirait une
 * injection dans le fichier commité).
 *
 * Forme exacte de `src/content/articles/estimation-maison-caen.md` :
 * frontmatter YAML entre deux lignes `---`, puis une ligne vide, puis le
 * corps Markdown tel quel (`contenu` — ce n'est PAS un champ du frontmatter,
 * voir `src/content.config.ts` : le corps n'est jamais couvert par le schéma
 * Zod, uniquement par `scripts/validate-content.mjs`).
 */

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export interface ParsedMarkdownFile {
  data: Record<string, unknown>
  body: string
}

/** Assemble frontmatter + corps dans la forme exacte attendue par le site (et par le script CI). */
export function buildMarkdownFile(frontmatter: Record<string, unknown>, body: string): string {
  // `undefined` retiré avant sérialisation : un champ optionnel absent du
  // payload ne doit PAS apparaître comme `champ: null` dans le fichier — les
  // articles existants ne les écrivent pas non plus.
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value !== undefined) clean[key] = value
  }

  const yaml = stringifyYaml(clean, { lineWidth: 0 })
  return `---\n${yaml}---\n\n${body.trim()}\n`
}

/** Lit un fichier `.md` de contenu : `{ data, body }`, comme `validate-content.mjs`. */
export function parseMarkdownFile(raw: string): ParsedMarkdownFile {
  const match = raw.match(FRONTMATTER_PATTERN)
  if (!match) {
    return { data: {}, body: raw.trim() }
  }
  const data = (parseYaml(match[1]) ?? {}) as Record<string, unknown>
  return { data, body: (match[2] ?? '').trim() }
}

/** Assemble une fiche auteur JSON (`src/content/auteurs/<id>.json`) — voir `src/lib/auteurs.ts`. */
export function buildAuteurJson(fiche: Record<string, unknown>): string {
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fiche)) {
    if (value !== undefined) clean[key] = value
  }
  return `${JSON.stringify(clean, null, 2)}\n`
}
