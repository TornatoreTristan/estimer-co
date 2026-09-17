import { test } from '@japa/runner'

import {
  createBlogGitFixture,
  listBranchesInBare,
  readFileFromBare,
} from '#tests/helpers/blog_fixtures'

/**
 * `GitService` — specs/blog-automatisation-ia.md §0, §1.3, §5.
 *
 * Ces tests exercent un VRAI dépôt Git local (fixture "bare"), jamais un
 * mock : c'est la seule façon de vérifier ce que le module écrit réellement
 * sur disque et pousse réellement sur une branche.
 */
test.group('BlogGitService', (group) => {
  let fixture: Awaited<ReturnType<typeof createBlogGitFixture>>

  group.each.setup(async () => {
    fixture = await createBlogGitFixture()
    return () => fixture.cleanup()
  })

  test('clone la copie de travail et lie node_modules', async ({ assert }) => {
    await fixture.git.ensureWorkdir()
    assert.isTrue(fixture.git.fileExists('scripts/validate-content.mjs'))
    assert.isTrue(fixture.git.fileExists('node_modules'))
  })

  test('prepareBranch crée une nouvelle branche depuis main quand elle n’existe pas', async ({
    assert,
  }) => {
    await fixture.git.ensureWorkdir()
    await fixture.git.fetchAll()
    const { isNew } = await fixture.git.prepareBranch('blog-ia/mon-slug')
    assert.isTrue(isNew)
  })

  test('écrit, commit et push : le fichier apparaît sur la branche, jamais sur main', async ({
    assert,
  }) => {
    await fixture.git.ensureWorkdir()
    await fixture.git.fetchAll()
    await fixture.git.prepareBranch('blog-ia/mon-slug')

    fixture.git.writeTextFile(
      'src/content/articles/mon-slug.md',
      '---\nslug: mon-slug\n---\n\nCorps.\n'
    )
    const committed = await fixture.git.commit('Crée mon-slug')
    assert.isTrue(committed)
    await fixture.git.push('blog-ia/mon-slug')

    const onBranch = await readFileFromBare(
      fixture.bareDir,
      'blog-ia/mon-slug',
      'src/content/articles/mon-slug.md'
    )
    assert.isNotNull(onBranch)
    assert.include(onBranch ?? '', 'slug: mon-slug')

    const onMain = await readFileFromBare(
      fixture.bareDir,
      'main',
      'src/content/articles/mon-slug.md'
    )
    assert.isNull(onMain, 'aucun commit ne doit jamais atteindre main')

    const branches = await listBranchesInBare(fixture.bareDir)
    assert.include(branches, 'blog-ia/mon-slug')
  })

  test('prepareBranch reprend origin/<branch> si elle existe déjà (mise à jour)', async ({
    assert,
  }) => {
    await fixture.git.ensureWorkdir()
    await fixture.git.fetchAll()
    await fixture.git.prepareBranch('blog-ia/mon-slug')
    fixture.git.writeTextFile(
      'src/content/articles/mon-slug.md',
      '---\nslug: mon-slug\ntitle: v1\n---\n\nCorps.\n'
    )
    await fixture.git.commit('v1')
    await fixture.git.push('blog-ia/mon-slug')

    const { isNew } = await fixture.git.prepareBranch('blog-ia/mon-slug')
    assert.isFalse(isNew)
    assert.include(fixture.git.readTextFile('src/content/articles/mon-slug.md') ?? '', 'title: v1')
  })

  test('resetWorkingTree efface les écritures non commitées', async ({ assert }) => {
    await fixture.git.ensureWorkdir()
    await fixture.git.fetchAll()
    await fixture.git.prepareBranch('blog-ia/mon-slug')
    fixture.git.writeTextFile('public/images/blog/orphelin.webp', 'binaire')
    await fixture.git.resetWorkingTree()
    assert.isFalse(fixture.git.fileExists('public/images/blog/orphelin.webp'))
  })

  test('le vrai scripts/validate-content.mjs --json tourne dans la copie de travail', async ({
    assert,
  }) => {
    await fixture.git.ensureWorkdir()
    await fixture.git.fetchAll()
    await fixture.git.prepareBranch('blog-ia/mon-slug')
    fixture.git.writeTextFile(
      'src/content/articles/mon-slug.md',
      '---\nslug: mon-slug\ncategorie: vendre\ntitle: "Titre"\nstatut: brouillon\n---\n\nCorps.\n'
    )

    const { runValidateContent } = await import('#services/blog/validate_service')
    const report = await runValidateContent(fixture.git.workdir)
    assert.isArray(report.errors)
    assert.isArray(report.warnings)
    assert.lengthOf(report.errors, 0, 'un brouillon ne doit jamais lever d’erreur bloquante')
  })
})
