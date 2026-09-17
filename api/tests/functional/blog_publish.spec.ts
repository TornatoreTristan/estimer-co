import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'

import { setBlogServicesForTesting } from '#services/blog/service_registry'
import {
  createBlogApiClient,
  createBlogGitFixture,
  InMemoryPrService,
  readFileFromBare,
} from '#tests/helpers/blog_fixtures'

// ≥ 1200 caractères pour satisfaire la gate de publication de scripts/validate-content.mjs.
const CONTENU_COMPLET = Array.from(
  { length: 20 },
  (_, i) =>
    `Paragraphe ${i} suffisamment long pour contribuer aux mille deux cents caractères requis par la gate.`
).join('\n\n')

test.group('POST /v1/blog/articles/:slug/publish — F1-F2', (group) => {
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

  test('F1 — contenu complet → 200, statut publie + dateMiseAJour', async ({ client, assert }) => {
    const { token: writeToken } = await createBlogApiClient(['articles:write'])
    const { token: publishToken } = await createBlogApiClient(['publish:request'])

    const create = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${writeToken}`)
      .header('Idempotency-Key', 'publish-create')
      .json({
        slug: 'article-a-publier',
        categorie: 'vendre',
        title: 'Article complet',
        metaDescription:
          'Une description suffisamment longue pour passer la gate de publication ici.',
        extrait: 'Un extrait suffisamment long pour passer la gate de publication du script réel.',
        datePublication: '2026-01-01',
        contenu: CONTENU_COMPLET,
      })
    create.assertStatus(201)

    const publish = await client
      .post('/v1/blog/articles/article-a-publier/publish')
      .header('Authorization', `Bearer ${publishToken}`)
      .header('Idempotency-Key', 'publish-1')
      .json({})

    publish.assertStatus(200)
    const body = publish.body()
    assert.equal(body.statut, 'publie')
    assert.equal(body.job.status, 'pr_open')

    const onBranch = await readFileFromBare(
      fixture.bareDir,
      'blog-ia/article-a-publier',
      'src/content/articles/article-a-publier.md'
    )
    assert.include(onBranch ?? '', 'statut: publie')
    assert.match(onBranch ?? '', /dateMiseAJour: \d{4}-\d{2}-\d{2}/)
  })

  test('F2 — contenu incomplet → 422 avec le rapport de la gate, fichier inchangé', async ({
    client,
    assert,
  }) => {
    const { token: writeToken } = await createBlogApiClient(['articles:write'])
    const { token: publishToken } = await createBlogApiClient(['publish:request'])

    await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${writeToken}`)
      .header('Idempotency-Key', 'publish-incomplet-create')
      .json({
        slug: 'article-incomplet',
        categorie: 'vendre',
        title: 'Incomplet',
        contenu: 'Trop court.',
      })

    const publish = await client
      .post('/v1/blog/articles/article-incomplet/publish')
      .header('Authorization', `Bearer ${publishToken}`)
      .header('Idempotency-Key', 'publish-incomplet-1')
      .json({})

    publish.assertStatus(422)
    const body = publish.body()
    assert.equal(body.error, 'validation_failed')
    assert.isArray(body.errors)
    assert.isAbove(body.errors.length, 0)

    const onBranch = await readFileFromBare(
      fixture.bareDir,
      'blog-ia/article-incomplet',
      'src/content/articles/article-incomplet.md'
    )
    assert.include(onBranch ?? '', 'statut: brouillon')
  })

  test('publish sur un slug inconnu → 404', async ({ client }) => {
    const { token } = await createBlogApiClient(['publish:request'])
    const response = await client
      .post('/v1/blog/articles/jamais-cree/publish')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'publish-404')
      .json({})

    response.assertStatus(404)
  })
})

test.group('GET /v1/blog/jobs/:id — G1-G2', (group) => {
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

  test('G1 — consultation de l’état d’un job créé par le même client', async ({
    client,
    assert,
  }) => {
    const { token } = await createBlogApiClient(['articles:write'])
    const create = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'job-1')
      .json({ categorie: 'vendre', title: 'Job Consultable', contenu: 'Un corps de texte.' })

    const jobId = create.body().job.id

    const response = await client
      .get(`/v1/blog/jobs/${jobId}`)
      .header('Authorization', `Bearer ${token}`)
    response.assertStatus(200)
    const body = response.body()
    assert.equal(body.id, jobId)
    assert.equal(body.status, 'pr_open')
    assert.equal(body.action, 'article_upsert')
  })

  test('G1 — un job n’est visible que par le client qui l’a créé (sinon 404)', async ({
    client,
  }) => {
    const { token: creator } = await createBlogApiClient(['articles:write'])
    const { token: other } = await createBlogApiClient([])

    const create = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${creator}`)
      .header('Idempotency-Key', 'job-confidentiel')
      .json({ categorie: 'vendre', title: 'Job Confidentiel', contenu: 'Un corps de texte.' })

    const jobId = create.body().job.id

    const response = await client
      .get(`/v1/blog/jobs/${jobId}`)
      .header('Authorization', `Bearer ${other}`)
    response.assertStatus(404)
  })

  test('G2 — pr_open relu sur GitHub détecte un merge externe', async ({ client, assert }) => {
    const { token } = await createBlogApiClient(['articles:write'])
    const create = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'job-merge')
      .json({ categorie: 'vendre', title: 'Job Merge', contenu: 'Un corps de texte.' })

    const jobId = create.body().job.id
    const prNumber = create.body().job.status === 'pr_open' ? 1 : null
    // La première PR créée par la fixture InMemoryPrService porte le numéro 1.
    pr.markMerged(prNumber ?? 1)

    const response = await client
      .get(`/v1/blog/jobs/${jobId}`)
      .header('Authorization', `Bearer ${token}`)
    response.assertStatus(200)
    assert.equal(response.body().status, 'pr_merged')
  })
})
