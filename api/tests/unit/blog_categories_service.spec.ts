import { test } from '@japa/runner'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readCategories } from '#services/blog/categories_service'

/**
 * `readCategories` — revue QA, mineur 7 : le cache d'import ne doit grossir
 * que si le CONTENU de `src/lib/blog.ts` change (hash), jamais à chaque
 * appel (l'ancien comportement, indexé sur `mtime`, était invalidé par un
 * simple `git checkout` même sans changement réel de contenu).
 *
 * Ces tests couvrent la CORRECTION du résultat au fil des changements —
 * la non-croissance du cache d'import de Node lui-même n'est pas observable
 * depuis l'extérieur du module (Node n'expose aucune API pour l'inspecter) :
 * c'est le raisonnement documenté dans `categories_service.ts` qui la
 * garantit (une seule entrée mémorisée, jamais une table indexée par URL).
 */

function writeBlogTs(dir: string, categories: Array<{ slug: string; label: string }>): string {
  const libDir = join(dir, 'src/lib')
  mkdirSync(libDir, { recursive: true })
  const path = join(libDir, 'blog.ts')
  const body = categories
    .map(
      (c) =>
        `  { slug: ${JSON.stringify(c.slug)}, label: ${JSON.stringify(c.label)}, description: 'desc' },`
    )
    .join('\n')
  writeFileSync(path, `export const CATEGORIES = [\n${body}\n];\n`, 'utf8')
  return path
}

test.group('categories_service | readCategories', (group) => {
  let dir: string

  group.each.setup(() => {
    dir = mkdtempSync(join(tmpdir(), 'estimer-categories-'))
    return () => rmSync(dir, { recursive: true, force: true })
  })

  test('lit les catégories du fichier de la copie de travail', async ({ assert }) => {
    writeBlogTs(dir, [{ slug: 'vendre', label: 'Vendre' }])

    const categories = await readCategories(dir)

    assert.deepEqual(
      categories.map((c) => c.slug),
      ['vendre']
    )
  })

  test('un changement de CONTENU est répercuté au prochain appel', async ({ assert }) => {
    writeBlogTs(dir, [{ slug: 'vendre', label: 'Vendre' }])
    await readCategories(dir)

    writeBlogTs(dir, [{ slug: 'acheter', label: 'Acheter' }])
    const categories = await readCategories(dir)

    assert.deepEqual(
      categories.map((c) => c.slug),
      ['acheter']
    )
  })

  test('un second appel sans changement de contenu renvoie toujours la même liste', async ({
    assert,
  }) => {
    writeBlogTs(dir, [{ slug: 'vendre', label: 'Vendre' }])

    const first = await readCategories(dir)
    const second = await readCategories(dir)

    assert.deepEqual(first, second)
  })

  test('un contenu identique dans un AUTRE dossier renvoie le même résultat (le cache ne mémorise qu’un hash, pas un chemin)', async ({
    assert,
  }) => {
    const otherDir = mkdtempSync(join(tmpdir(), 'estimer-categories-'))
    try {
      writeBlogTs(dir, [{ slug: 'dpe-travaux', label: 'DPE et travaux' }])
      writeBlogTs(otherDir, [{ slug: 'dpe-travaux', label: 'DPE et travaux' }])

      const first = await readCategories(dir)
      const second = await readCategories(otherDir)

      assert.deepEqual(first, second)
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })
})
