import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'
import sharp from 'sharp'

import { DEFAULT_MAX_BODY_BYTES } from '#lib/body_size_guard'
import { setBlogServicesForTesting } from '#services/blog/service_registry'
import {
  createBlogApiClient,
  createBlogGitFixture,
  InMemoryPrService,
} from '#tests/helpers/blog_fixtures'
import {
  estimationPayload,
  resetEstimationFixtures,
  seedCommunes,
  seedDatasetVersion,
  seedGueretApartments,
  seedReferences,
} from '#tests/helpers/estimation_fixtures'

/**
 * `BodySizeGuardMiddleware` (`app/middleware/body_size_guard_middleware.ts`)
 * — revue QA, critique C1. La décision elle-même (413/411/401/continue) est
 * couverte de façon exhaustive et rapide par `tests/unit/body_size_guard.spec.ts`
 * (fonction pure, sans requête HTTP). Ce fichier vérifie seulement que le
 * garde est bien branché sur la vraie pile HTTP, dans le bon ordre.
 */

const CONTENU_MINIMAL = 'Un corps de texte suffisant pour un brouillon, sans exigence de longueur.'

test.group('BodySizeGuardMiddleware | /v1/leads', (group) => {
  group.each.setup(() => limiter.clear(['memory']))

  test('un corps au-delà du seuil par défaut est rejeté en 413, sans validation', async ({
    client,
    assert,
  }) => {
    // Un champ largement au-delà de tout ce que `app/validators/lead.ts`
    // accepterait de toute façon (message > LEAD_MESSAGE_MAX_LENGTH) : si le
    // garde de taille ne s'exécutait pas en premier, ce serait un 422 de
    // validation, pas un 413.
    const response = await client.post('/v1/leads').json({
      kind: 'contact',
      name: 'Tristan Test',
      email: 'tristan@example.test',
      message: 'x'.repeat(DEFAULT_MAX_BODY_BYTES + 1_000),
    })

    response.assertStatus(413)
    assert.equal(response.body().code, 'PAYLOAD_TOO_LARGE')
  })

  test('une demande de contact légitime de 5 000 caractères accentués est acceptée', async ({
    client,
    assert,
  }) => {
    // Le pire cas légitime hors blog (§ commentaire de tête de
    // `app/lib/body_size_guard.ts`) : `message` à sa longueur maximale
    // (LEAD_MESSAGE_MAX_LENGTH), rempli de caractères accentués — donc sur
    // plusieurs octets en UTF-8, pas juste 5 000 octets.
    const response = await client.post('/v1/leads').json({
      kind: 'contact',
      name: 'Tristan Test',
      email: 'tristan@example.test',
      phone: '0612345678',
      consent: true,
      message: 'Éàçèêôîûü ce prospect a beaucoup à dire. '.repeat(120).slice(0, 5_000),
    })

    response.assertStatus(200)
    assert.equal(response.body().status, 'dry-run')
  })
})

test.group('BodySizeGuardMiddleware | /v1/estimations', (group) => {
  group.each.setup(async () => {
    await limiter.clear(['memory'])
    await resetEstimationFixtures()
    await seedCommunes()
    await seedReferences()
    await seedDatasetVersion()
    await seedGueretApartments()
  })

  group.each.teardown(async () => {
    await resetEstimationFixtures()
  })

  test('un corps au-delà du seuil générique (64 Kio) est rejeté en 413', async ({
    client,
    assert,
  }) => {
    const response = await client
      .post('/v1/estimations')
      .json(estimationPayload({ address: 'x'.repeat(DEFAULT_MAX_BODY_BYTES + 1_000) }))

    response.assertStatus(413)
    assert.equal(response.body().code, 'PAYLOAD_TOO_LARGE')
  })

  test('un corps sous 64 Kio mais au-delà du seuil propre à la route (4 Ko) est aussi rejeté en 413', async ({
    client,
    assert,
  }) => {
    // Prouve que `MaxBodySizeMiddleware` (4 Ko, `start/routes.ts`) reste
    // actif EN COMPLÉMENT du garde générique, pour un corps qui passe ce
    // dernier (< 64 Kio) mais dépasse la limite propre à cette route.
    const response = await client
      .post('/v1/estimations')
      .json(estimationPayload({ address: 'x'.repeat(8_000) }))

    response.assertStatus(413)
    assert.equal(response.body().code, 'PAYLOAD_TOO_LARGE')
  })

  test('une demande d’estimation légitime reste acceptée', async ({ client }) => {
    const response = await client.post('/v1/estimations').json(estimationPayload())
    response.assertStatus(200)
  })
})

test.group(
  'BodySizeGuardMiddleware | /v1/blog/** — exempté, mais authentification de forme',
  (group) => {
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

    test('une requête blog volumineuse authentifiée est acceptée (créée)', async ({
      client,
      assert,
    }) => {
      const { token } = await createBlogApiClient(['articles:write'])

      // Image réelle, décodable, sous les 10 Mo de `MAX_DECODED_IMAGE_BYTES`
      // mais très au-delà des 64 Kio du seuil générique — bruit aléatoire pour
      // empêcher la compression JPEG de retomber sous ce seuil.
      const width = 1500
      const height = 1500
      const raw = Buffer.alloc(width * height * 3)
      for (let i = 0; i < raw.length; i += 1) raw[i] = Math.floor(Math.random() * 256)
      const jpeg = await sharp(raw, { raw: { width, height, channels: 3 } })
        .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
        .toBuffer()
      assert.isAbove(jpeg.length, DEFAULT_MAX_BODY_BYTES)

      const response = await client
        .post('/v1/blog/articles')
        .header('Authorization', `Bearer ${token}`)
        .header('Idempotency-Key', 'body-size-guard-blog-large')
        .json({
          categorie: 'vendre',
          title: 'Article avec grande image',
          contenu: CONTENU_MINIMAL,
          image: { data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
          imageAlt: 'Texte alternatif',
        })

      response.assertStatus(201)
    }).timeout(20_000)

    test('une requête blog volumineuse sans jeton Bearer est rejetée en 401 sans lecture du corps', async ({
      client,
      assert,
    }) => {
      // Corps largement au-delà du seuil générique (64 Kio) et de la limite de
      // `/v1/estimations` (4 Ko) : si `BodySizeGuardMiddleware` ne s'exécutait
      // pas AVANT le bodyparser — ou n'exemptait pas `/v1/blog/**` sans
      // vérifier le format du jeton — cette requête ne recevrait jamais ce 401
      // (413, ou un traitement complet du corps avant l'échec d'authentification
      // du middleware nommé `BlogAuthMiddleware`).
      //
      // Volontairement PAS plusieurs dizaines de Mo ici : au-delà d'une
      // certaine taille, répondre avant que le client ait fini d'émettre le
      // corps fait réinitialiser la connexion (ECONNRESET) par l'OS avant même
      // que la réponse HTTP ne soit lisible côté client — un faux négatif de
      // test, pas une preuve d'échec de la protection.
      const response = await client.post('/v1/blog/articles').json({
        categorie: 'vendre',
        title: 'Article',
        contenu: 'x'.repeat(512 * 1024),
      })

      response.assertStatus(401)
      assert.equal(response.body().error, 'unauthorized')
    }).timeout(20_000)

    test('une requête blog volumineuse avec un en-tête Authorization mal formé est aussi rejetée en 401 sans lecture', async ({
      client,
      assert,
    }) => {
      const response = await client
        .post('/v1/blog/articles')
        .header('Authorization', 'Token pas-du-bearer')
        .json({
          categorie: 'vendre',
          title: 'Article',
          contenu: 'x'.repeat(512 * 1024),
        })

      response.assertStatus(401)
      assert.equal(response.body().error, 'unauthorized')
    }).timeout(20_000)
  }
)
