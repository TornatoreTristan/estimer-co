import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'
import sharp from 'sharp'

import { setBlogServicesForTesting } from '#services/blog/service_registry'
import { BlogAdvisoryLock } from '#services/blog/advisory_lock'
import { buildMarkdownFile } from '#services/blog/markdown'
import {
  createBlogApiClient,
  createBlogGitFixture,
  gitStatusPorcelain,
  InMemoryPrService,
  readFileFromBare,
} from '#tests/helpers/blog_fixtures'

const CONTENU_MINIMAL = 'Un corps de texte suffisant pour un brouillon, sans exigence de longueur.'

async function jpegBase64(): Promise<string> {
  const buffer = await sharp({
    create: { width: 20, height: 20, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .jpeg()
    .toBuffer()
  return buffer.toString('base64')
}

test.group('POST /v1/blog/articles — B1-B4, C1-C4, G', (group) => {
  let fixture: Awaited<ReturnType<typeof createBlogGitFixture>>
  let pr: InMemoryPrService

  group.each.setup(async () => {
    await limiter.clear(['memory'])
    await db.rawQuery('DELETE FROM blog_jobs')
    await db.rawQuery('DELETE FROM blog_api_clients')
    fixture = await createBlogGitFixture()
    pr = new InMemoryPrService()
    setBlogServicesForTesting({ git: fixture.git, pr })
    return () => {
      setBlogServicesForTesting(null)
      fixture.cleanup()
    }
  })

  test('B1 — crée un brouillon, ouvre une PR, rien sur main', async ({ client, assert }) => {
    const { token } = await createBlogApiClient(['articles:write'])

    const response = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'b1-create')
      .json({
        categorie: 'vendre',
        title: 'Estimation appartement Nantes',
        contenu: CONTENU_MINIMAL,
      })

    response.assertStatus(201)
    const body = response.body()
    assert.equal(body.slug, 'estimation-appartement-nantes')
    assert.equal(body.statut, 'brouillon')
    assert.isString(body.prUrl)
    assert.equal(body.job.status, 'pr_open')

    const onBranch = await readFileFromBare(
      fixture.bareDir,
      'blog-ia/estimation-appartement-nantes',
      'src/content/articles/estimation-appartement-nantes.md'
    )
    assert.isNotNull(onBranch)
    assert.include(onBranch ?? '', 'categorie: vendre')

    const onMain = await readFileFromBare(
      fixture.bareDir,
      'main',
      'src/content/articles/estimation-appartement-nantes.md'
    )
    assert.isNull(onMain, 'aucun commit ne doit jamais atteindre main')
  })

  test('B2/B3 — rejeu à l’identique renvoie 200 sans nouvelle PR', async ({ client, assert }) => {
    const { token } = await createBlogApiClient(['articles:write'])
    const payload = { categorie: 'vendre', title: 'Rejeu Idempotent', contenu: CONTENU_MINIMAL }

    const first = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'abc-123')
      .json(payload)
    first.assertStatus(201)

    const second = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'abc-123')
      .json(payload)

    second.assertStatus(200)
    assert.deepEqual(second.body(), first.body())
  })

  test('B3 — même clé, payload différent → 422 idempotency_key_reused', async ({
    client,
    assert,
  }) => {
    const { token } = await createBlogApiClient(['articles:write'])

    await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'abc-123')
      .json({ categorie: 'vendre', title: 'Titre A', contenu: CONTENU_MINIMAL })

    const response = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'abc-123')
      .json({ categorie: 'vendre', title: 'Titre B', contenu: CONTENU_MINIMAL })

    response.assertStatus(422)
    assert.equal(response.body().error, 'idempotency_key_reused')
  })

  test('B2 — mise à jour d’un brouillon pousse un commit sur la même branche', async ({
    client,
    assert,
  }) => {
    const { token } = await createBlogApiClient(['articles:write'])

    const create = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'update-1')
      .json({
        slug: 'mon-article',
        categorie: 'vendre',
        title: 'Titre v1',
        contenu: CONTENU_MINIMAL,
      })
    create.assertStatus(201)

    const update = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'update-2')
      .json({
        slug: 'mon-article',
        categorie: 'vendre',
        title: 'Titre v2',
        contenu: CONTENU_MINIMAL,
      })

    update.assertStatus(200)
    assert.equal(update.body().statut, 'brouillon')

    const onBranch = await readFileFromBare(
      fixture.bareDir,
      'blog-ia/mon-article',
      'src/content/articles/mon-article.md'
    )
    assert.include(onBranch ?? '', 'title: Titre v2')
  })

  test('B4 — catégorie hors enum → 422, rien écrit, aucune branche créée', async ({
    client,
    assert,
  }) => {
    const { token } = await createBlogApiClient(['articles:write'])

    const response = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'bad-cat')
      .json({
        slug: 'article-cat-invalide',
        categorie: 'inexistante',
        title: 'Titre',
        contenu: CONTENU_MINIMAL,
      })

    response.assertStatus(422)
    const body = response.body()
    assert.equal(body.code, 'VALIDATION_ERROR')
    assert.isTrue(body.errors.some((e: { field: string }) => e.field === 'categorie'))

    const onMain = await readFileFromBare(
      fixture.bareDir,
      'main',
      'src/content/articles/article-cat-invalide.md'
    )
    assert.isNull(onMain)
  })

  test('B4 — brouillon incomplet (metaDescription/extrait absents) → 201, PR ouverte', async ({
    client,
    assert,
  }) => {
    const { token } = await createBlogApiClient(['articles:write'])

    const response = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'incomplet')
      .json({ categorie: 'vendre', title: 'Brouillon incomplet', contenu: 'Court.' })

    response.assertStatus(201)
    assert.equal(response.body().job.status, 'pr_open')
  })

  test('C2 — image sans imageAlt → 422, rien écrit', async ({ client, assert }) => {
    const { token } = await createBlogApiClient(['articles:write'])
    const data = await jpegBase64()

    const response = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'image-sans-alt')
      .json({
        slug: 'article-image-sans-alt',
        categorie: 'vendre',
        title: 'Titre',
        contenu: CONTENU_MINIMAL,
        image: { data, mimeType: 'image/jpeg' },
      })

    response.assertStatus(422)
    const body = response.body()
    assert.isTrue(body.errors.some((e: { field: string }) => e.field === 'imageAlt'))

    const onMain = await readFileFromBare(
      fixture.bareDir,
      'main',
      'src/content/articles/article-image-sans-alt.md'
    )
    assert.isNull(onMain)
  })

  test('C — JPEG valide avec alt → .webp créé, frontmatter image renseigné', async ({
    client,
    assert,
  }) => {
    const { token } = await createBlogApiClient(['articles:write'])
    const data = await jpegBase64()

    const response = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'image-ok')
      .json({
        slug: 'article-avec-image',
        categorie: 'vendre',
        title: 'Titre',
        contenu: CONTENU_MINIMAL,
        image: { data, mimeType: 'image/jpeg' },
        imageAlt: 'Une photo de test',
      })

    response.assertStatus(201)

    const onBranch = await readFileFromBare(
      fixture.bareDir,
      'blog-ia/article-avec-image',
      'src/content/articles/article-avec-image.md'
    )
    assert.include(onBranch ?? '', 'image: /images/blog/article-avec-image.webp')
    assert.include(onBranch ?? '', 'imageAlt: Une photo de test')

    // Le fichier binaire a bien été commité sur la branche (signature WebP : "RIFF"…"WEBP").
    const webp = await readFileFromBare(
      fixture.bareDir,
      'blog-ia/article-avec-image',
      'public/images/blog/article-avec-image.webp'
    )
    assert.isNotNull(webp)
    assert.include(webp ?? '', 'WEBP')
  })

  test('C — signature binaire ni JPEG, ni PNG, ni WebP → 422 { field: "image" }', async ({
    client,
    assert,
  }) => {
    const { token } = await createBlogApiClient(['articles:write'])
    const data = Buffer.from('ceci n’est pas une image').toString('base64')

    const response = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'image-invalide')
      .json({
        slug: 'article-image-invalide',
        categorie: 'vendre',
        title: 'Titre',
        contenu: CONTENU_MINIMAL,
        image: { data, mimeType: 'image/jpeg' },
        imageAlt: 'Texte alternatif',
      })

    response.assertStatus(422)
    const body = response.body()
    assert.isTrue(body.errors.some((e: { field: string }) => e.field === 'image'))
  })

  test('C — image > 10 Mo décodés → 422 { field: "image" }', async ({ client, assert }) => {
    const { token } = await createBlogApiClient(['articles:write'])
    const big = Buffer.alloc(11 * 1024 * 1024, 0)
    big[0] = 0xff
    big[1] = 0xd8
    big[2] = 0xff
    const data = big.toString('base64')

    const response = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'image-trop-lourde')
      .json({
        slug: 'article-image-lourde',
        categorie: 'vendre',
        title: 'Titre',
        contenu: CONTENU_MINIMAL,
        image: { data, mimeType: 'image/jpeg' },
        imageAlt: 'Texte alternatif',
      })

    response.assertStatus(422)
    const body = response.body()
    assert.isTrue(body.errors.some((e: { field: string }) => e.field === 'image'))
  }).timeout(20_000)

  test('D2 — auteur inconnu → 422 avec message d’aide', async ({ client, assert }) => {
    const { token } = await createBlogApiClient(['articles:write'])

    const response = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'auteur-inconnu')
      .json({
        slug: 'article-auteur-inconnu',
        categorie: 'vendre',
        title: 'Titre',
        contenu: CONTENU_MINIMAL,
        auteur: 'jean-dupont',
      })

    response.assertStatus(422)
    const body = response.body()
    const error = body.errors.find((e: { field: string }) => e.field === 'auteur')
    assert.exists(error)
    assert.include(error.message, 'jean-dupont')
    assert.include(error.message, 'POST /v1/blog/auteurs')
  })

  test('GET /v1/blog/articles/:slug — existsOnMain, openPr', async ({ client, assert }) => {
    const { token } = await createBlogApiClient(['articles:write'])

    await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'get-1')
      .json({
        slug: 'article-consultable',
        categorie: 'vendre',
        title: 'Titre',
        contenu: CONTENU_MINIMAL,
      })

    const response = await client
      .get('/v1/blog/articles/article-consultable')
      .header('Authorization', `Bearer ${token}`)

    response.assertStatus(200)
    const body = response.body()
    assert.isFalse(body.existsOnMain)
    assert.isString(body.openPr.url)
  })

  test('G2 — opération en cours sur un slug → 409 operation_in_progress', async ({
    client,
    assert,
  }) => {
    const { token } = await createBlogApiClient(['articles:write'])
    const lock = new BlogAdvisoryLock()
    const acquired = await lock.tryAcquire('blog:slug-verrouille')
    assert.isTrue(acquired)

    try {
      const response = await client
        .post('/v1/blog/articles')
        .header('Authorization', `Bearer ${token}`)
        .header('Idempotency-Key', 'verrouille')
        .json({
          slug: 'slug-verrouille',
          categorie: 'vendre',
          title: 'Titre',
          contenu: CONTENU_MINIMAL,
        })

      response.assertStatus(409)
      assert.equal(response.body().error, 'operation_in_progress')
    } finally {
      await lock.release()
    }
  })

  test('POST sans en-tête Idempotency-Key → 422', async ({ client, assert }) => {
    const { token } = await createBlogApiClient(['articles:write'])
    const response = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .json({ categorie: 'vendre', title: 'Titre', contenu: CONTENU_MINIMAL })

    response.assertStatus(422)
    assert.equal(response.body().code, 'VALIDATION_ERROR')
  })

  test('revue QA, majeur 3 — un upsert rejeté par la gate de validation laisse la copie de travail propre', async ({
    client,
    assert,
  }) => {
    /*
     * `runValidateContent` (le VRAI `scripts/validate-content.mjs`) bloque un
     * `brouillon` sur une seule règle « toujours active » : une collision de
     * slug (`checkSlugUniqueness`, jamais conditionnée à `statut: publie`).
     * On seed donc, directement sur `main`, un autre article qui porte déjà
     * le slug visé par l'upsert — sans passer par l'API, pour ne pas
     * présupposer que la validation aurait aussi lieu à la création de ce
     * seed.
     */
    await fixture.git.ensureWorkdir()
    await fixture.git.prepareBranch('main')
    fixture.git.writeTextFile(
      'src/content/articles/autre-article.md',
      buildMarkdownFile(
        {
          slug: 'article-en-collision',
          categorie: 'vendre',
          title: 'Un autre article, même slug en frontmatter',
          statut: 'brouillon',
        },
        CONTENU_MINIMAL
      )
    )
    await fixture.git.commit('Seed : article en collision de slug')
    await fixture.git.push('main')

    const { token } = await createBlogApiClient(['articles:write'])
    const response = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'majeur-3-collision-slug')
      .json({
        slug: 'article-en-collision',
        categorie: 'vendre',
        title: 'Nouvel article en collision',
        contenu: CONTENU_MINIMAL,
      })

    response.assertStatus(422)
    assert.equal(response.body().error, 'validation_failed')
    assert.isTrue(
      (response.body().errors as { field: string }[]).some((e) => e.field === 'slug'),
      'attendu : une erreur de collision de slug'
    )

    // Rien n'a été poussé sur la branche article…
    const onBranch = await readFileFromBare(
      fixture.bareDir,
      'blog-ia/article-en-collision',
      'src/content/articles/article-en-collision.md'
    )
    assert.isNull(onBranch)

    // … et la copie de travail LOCALE, partagée entre opérations
    // (`blogWorkdirMutex`), ne garde ni le fichier écrit avant l'échec, ni
    // aucune modification non commitée.
    const status = await gitStatusPorcelain(fixture.workdir)
    assert.equal(status.trim(), '', `copie de travail non propre :\n${status}`)
  })
})
