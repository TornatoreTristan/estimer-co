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

const BIO_50 = 'Une biographie de cinquante caractères ou plus, ici.'

test.group('/v1/blog/auteurs — D1-D3', (group) => {
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

  test('D2 — crée un auteur (id dérivé du nom), PR distincte de celle d’un article', async ({
    client,
    assert,
  }) => {
    const { token } = await createBlogApiClient(['auteurs:write'])

    const response = await client
      .post('/v1/blog/auteurs')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'auteur-1')
      .json({ nom: 'Marie Curie', fonction: 'Rédactrice', bio: BIO_50 })

    response.assertStatus(201)
    const body = response.body()
    assert.equal(body.id, 'marie-curie')
    assert.isString(body.prUrl)

    const onBranch = await readFileFromBare(
      fixture.bareDir,
      'blog-ia/auteur-marie-curie',
      'src/content/auteurs/marie-curie.json'
    )
    assert.isNotNull(onBranch)
    const fiche = JSON.parse(onBranch ?? '{}')
    assert.equal(fiche.nom, 'Marie Curie')
    assert.equal(fiche.initiales, 'MC')

    const onMain = await readFileFromBare(
      fixture.bareDir,
      'main',
      'src/content/auteurs/marie-curie.json'
    )
    assert.isNull(onMain)
  })

  test('D2 — bio trop courte (< 50 caractères) → 422', async ({ client, assert }) => {
    const { token } = await createBlogApiClient(['auteurs:write'])
    const response = await client
      .post('/v1/blog/auteurs')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'auteur-bio-courte')
      .json({ nom: 'Jean Dupont', fonction: 'Rédacteur', bio: 'Trop court.' })

    response.assertStatus(422)
    const body = response.body()
    assert.isTrue(body.errors.some((e: { field: string }) => e.field === 'bio'))
  })

  test('D2 — schéma d’URL dangereux (javascript:) dans un lien → 422 sur liens.N.url', async ({
    client,
    assert,
  }) => {
    // Revue QA, majeur 2 : `liens[].url` est rendu tel quel en `href` par
    // `AuteurEncart.astro` — un schéma exécutable ne doit jamais atteindre le
    // dépôt.
    const { token } = await createBlogApiClient(['auteurs:write'])
    const response = await client
      .post('/v1/blog/auteurs')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'auteur-lien-dangereux')
      .json({
        nom: 'Alice Martin',
        fonction: 'Rédactrice',
        bio: BIO_50,
        liens: [
          {
            type: 'site',
            url: 'javascript:alert(1)',
            texte: 'Site',
            libelle: 'Site personnel',
          },
        ],
      })

    response.assertStatus(422)
    const body = response.body()
    assert.isTrue(body.errors.some((e: { field: string }) => e.field === 'liens.0.url'))
  })

  test('D2 — schémas autorisés (https:// et mailto:) acceptés', async ({ client, assert }) => {
    const { token } = await createBlogApiClient(['auteurs:write'])
    const response = await client
      .post('/v1/blog/auteurs')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'auteur-liens-valides')
      .json({
        nom: 'Bob Petit',
        fonction: 'Rédacteur',
        bio: BIO_50,
        liens: [
          {
            type: 'linkedin',
            url: 'https://www.linkedin.com/in/bob-petit',
            texte: 'LinkedIn',
            libelle: 'LinkedIn de Bob Petit',
          },
          {
            type: 'email',
            url: 'mailto:bob@exemple.fr',
            texte: 'E-mail',
            libelle: 'E-mail de Bob Petit',
          },
        ],
      })

    response.assertStatus(201)
    assert.equal(response.body().id, 'bob-petit')
  })

  test('D2 — id déjà existant → 409', async ({ client }) => {
    const { token } = await createBlogApiClient(['auteurs:write'])

    const first = await client
      .post('/v1/blog/auteurs')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'auteur-doublon-1')
      .json({ id: 'jean-dupont', nom: 'Jean Dupont', fonction: 'Rédacteur', bio: BIO_50 })
    first.assertStatus(201)

    const second = await client
      .post('/v1/blog/auteurs')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'auteur-doublon-2')
      .json({ id: 'jean-dupont', nom: 'Jean Dupont bis', fonction: 'Rédacteur', bio: BIO_50 })

    second.assertStatus(409)
  })

  test('D1 — GET /v1/blog/auteurs liste les auteurs de main', async ({ client, assert }) => {
    const { token: writeToken } = await createBlogApiClient(['auteurs:write'])
    await client
      .post('/v1/blog/auteurs')
      .header('Authorization', `Bearer ${writeToken}`)
      .header('Idempotency-Key', 'liste-1')
      .json({ id: 'auteur-liste', nom: 'Auteur Liste', fonction: 'Rédacteur', bio: BIO_50 })

    // L'auteur créé n'est encore que sur sa branche : main ne le connaît pas.
    const { token } = await createBlogApiClient([])
    const response = await client.get('/v1/blog/auteurs').header('Authorization', `Bearer ${token}`)
    response.assertStatus(200)
    assert.isArray(response.body().auteurs)
    assert.lengthOf(response.body().auteurs, 0)
  })

  test('D3 — auteur omis sur un article → AUTEUR_PAR_DEFAUT (pas d’erreur 422)', async ({
    client,
  }) => {
    const { token } = await createBlogApiClient(['articles:write'])
    const response = await client
      .post('/v1/blog/articles')
      .header('Authorization', `Bearer ${token}`)
      .header('Idempotency-Key', 'sans-auteur')
      .json({ categorie: 'vendre', title: 'Sans auteur', contenu: 'Un corps de texte.' })

    response.assertStatus(201)
  })
})
