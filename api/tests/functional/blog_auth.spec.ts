import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'

import { setBlogServicesForTesting } from '#services/blog/service_registry'
import {
  createBlogApiClient,
  createBlogGitFixture,
  InMemoryPrService,
} from '#tests/helpers/blog_fixtures'

/**
 * Sécurité de `/v1/blog/**` — specs/blog-automatisation-ia.md §3 "A" et §4.
 */
test.group('/v1/blog — authentification et scopes', (group) => {
  let fixture: Awaited<ReturnType<typeof createBlogGitFixture>>

  group.each.setup(async () => {
    await limiter.clear(['memory'])
    await db.rawQuery('DELETE FROM blog_jobs')
    await db.rawQuery('DELETE FROM blog_api_clients')
    fixture = await createBlogGitFixture()
    setBlogServicesForTesting({ git: fixture.git, pr: new InMemoryPrService() })
    return () => {
      setBlogServicesForTesting(null)
      fixture.cleanup()
    }
  })

  test('jeton absent → 401 unauthorized', async ({ client }) => {
    const response = await client.get('/v1/blog/categories')
    response.assertStatus(401)
    response.assertBodyContains({ error: 'unauthorized' })
  })

  test('jeton invalide → 401 unauthorized', async ({ client }) => {
    const response = await client
      .get('/v1/blog/categories')
      .header('Authorization', 'Bearer inconnu')
    response.assertStatus(401)
    response.assertBodyContains({ error: 'unauthorized' })
  })

  test('jeton révoqué → 401 unauthorized', async ({ client }) => {
    const { token } = await createBlogApiClient([], { revoked: true })
    const response = await client
      .get('/v1/blog/categories')
      .header('Authorization', `Bearer ${token}`)
    response.assertStatus(401)
  })

  test('jeton valide sans le scope requis → 403 forbidden', async ({ client, assert }) => {
    const { token } = await createBlogApiClient(['auteurs:write'])
    const response = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'k1')
      .json({ categorie: 'vendre', title: 'Titre', contenu: 'Un corps de texte.' })

    response.assertStatus(403)
    const body = response.body()
    assert.equal(body.error, 'forbidden')
    assert.include(body.missingScopes, 'articles:write')
  })

  test('quota dépassé sur /v1/blog/** → 429', async ({ client, assert }) => {
    const { token } = await createBlogApiClient([])
    const quota = 30
    let limited: Awaited<ReturnType<typeof client.get>> | null = null

    for (let attempt = 0; attempt < quota + 1; attempt += 1) {
      const response = await client
        .get('/v1/blog/categories')
        .header('Authorization', `Bearer ${token}`)
      if (response.status() === 429) {
        limited = response
        break
      }
    }

    assert.isNotNull(limited, 'le quota devait finir par être atteint')
    limited?.assertStatus(429)
  }).timeout(20_000)
})
