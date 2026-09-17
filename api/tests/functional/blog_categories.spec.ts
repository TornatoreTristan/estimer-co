import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'

import { setBlogServicesForTesting } from '#services/blog/service_registry'
import {
  createBlogApiClient,
  createBlogGitFixture,
  InMemoryPrService,
} from '#tests/helpers/blog_fixtures'

test.group('GET /v1/blog/categories — E1', (group) => {
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

  test('liste les catégories lues depuis src/lib/blog.ts de la copie de travail', async ({
    client,
    assert,
  }) => {
    const { token } = await createBlogApiClient([])
    const response = await client
      .get('/v1/blog/categories')
      .header('Authorization', `Bearer ${token}`)

    response.assertStatus(200)
    const { categories } = response.body()
    assert.isArray(categories)
    assert.includeDeepMembers(categories, [{ slug: 'vendre', label: 'Vendre son bien' }])
    assert.lengthOf(categories, 5)
  })
})
