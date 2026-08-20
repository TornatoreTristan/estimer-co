import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  DataVersionService,
  MUTATIONS_APPROXIMATE_COUNT_SQL,
  MUTATIONS_PRESENCE_SQL,
} from '#services/data_version_service'

/**
 * Surface HTTP du Lot 0 — spec §6.1.
 *
 * `/health` et `/v1/meta/data-version` doivent répondre **base vide** : le
 * front consomme le second au build Astro, et un orchestrateur interroge le
 * premier avant tout import.
 */

test.group('GET /health', () => {
  test('répond 200 avec l’état de la base', async ({ client, assert }) => {
    const response = await client.get('/health')

    response.assertStatus(200)
    response.assertBodyContains({ status: 'ok', db: true })

    const body = response.body()
    assert.isNumber(body.mutationsCount)
    assert.property(body, 'lastImportAt')
  })

  test('reste accessible sans en-tête Origin (sonde Coolify)', async ({ client }) => {
    // Une sonde de liveness n'envoie pas d'Origin : elle ne doit jamais se
    // voir opposer un 403 ni un 429.
    const response = await client.get('/health')
    response.assertStatus(200)
  })

  test('expose la présence de données sans parcourir la table', async ({ client, assert }) => {
    /*
     * La sonde tourne toutes les 30 s (HEALTHCHECK du Dockerfile, timeout
     * 5 s), hors quota et hors garde d'Origin. Un `COUNT(*)` sans filtre sur
     * `mutations` — 6-7 M de lignes en production (A.9) — y était un parcours
     * complet de table : boucle de redémarrage du conteneur d'un côté,
     * amplification triviale pour un tiers non authentifié de l'autre.
     */
    const response = await client.get('/health')
    response.assertStatus(200)

    const body = response.body()
    assert.isBoolean(body.hasMutations, 'la présence est exacte, via EXISTS')
    assert.isNumber(body.mutationsCount, 'le décompte n’est qu’un ordre de grandeur')
  })

  test('aucune requête de /health n’est en O(n) sur mutations', async ({ assert }) => {
    /*
     * Test de non-régression structurel : on demande le plan d'exécution des
     * deux requêtes que la sonde adresse à `mutations` et on vérifie qu'aucune
     * n'annonce un parcours complet.
     *
     * `EXPLAIN` sans `ANALYZE` : on inspecte le plan, on n'exécute rien.
     */
    const presence = await db.rawQuery(`EXPLAIN ${MUTATIONS_PRESENCE_SQL}`)
    const presencePlan = presence.rows
      .map((row: Record<string, string>) => row['QUERY PLAN'])
      .join('\n')
    // Un `EXISTS` s'arrête à la première ligne : le plan porte toujours un
    // `Limit`, et jamais d'agrégat sur la table entière.
    assert.notInclude(presencePlan, 'Aggregate', 'un COUNT(*) rôde de nouveau dans /health')

    const approximate = await db.rawQuery(`EXPLAIN ${MUTATIONS_APPROXIMATE_COUNT_SQL}`)
    const approximatePlan = approximate.rows
      .map((row: Record<string, string>) => row['QUERY PLAN'])
      .join('\n')
    // L'ordre de grandeur se lit dans le catalogue, jamais dans les données.
    assert.notInclude(approximatePlan, ' on mutations', 'la jauge ne doit lire que pg_class')
    assert.include(approximatePlan, 'pg_class')
  })
})

test.group('GET /v1/meta/data-version', (group) => {
  group.each.setup(async () => {
    await db.rawQuery('DELETE FROM dataset_versions')
    await db.rawQuery('DELETE FROM dvf_imports')
    // `DataVersionService.current()` est mémorisé 60 s (M2) : sans ce reset,
    // le test lirait l'inventaire du test précédent.
    DataVersionService.resetCache()
  })

  test('répond 200 même lorsque la base est vide', async ({ client, assert }) => {
    /*
     * Exigence du Lot 0 : sans cela, le site Astro ne pourrait pas se
     * construire avant la première ingestion — un couplage inacceptable
     * entre calendrier de déploiement et calendrier des données.
     */
    const response = await client.get('/v1/meta/data-version')

    response.assertStatus(200)
    const body = response.body()

    assert.isNull(body.dvfPublicationDate)
    assert.isNull(body.lastImportAt)
    assert.equal(body.coveredDepartmentsCount, 0)
    assert.equal(body.licence, 'Licence Ouverte / Etalab 2.0')
    assert.isString(body.attributionFr)
  })

  test('expose les départements non couverts par DVF (§1.3)', async ({ client, assert }) => {
    const response = await client.get('/v1/meta/data-version')

    const body = response.body()
    assert.deepEqual(body.missingDepartments, ['57', '67', '68', '976'])
  })

  test('reflète le millésime courant et le pose en en-tête X-Data-Version', async ({
    client,
    assert,
  }) => {
    await db.rawQuery(
      `INSERT INTO dataset_versions (dataset_version, published_at, sources, is_current)
       VALUES ('dvf-2025-10', '2025-10-01T00:00:00Z', '[]'::jsonb, true)`
    )
    await db.rawQuery(
      `INSERT INTO dvf_imports (source_url, annee, code_departement, status, finished_at)
       VALUES ('http://x', 2025, '23', 'success', '2026-05-18T10:00:00Z')`
    )

    const response = await client.get('/v1/meta/data-version')

    response.assertStatus(200)
    response.assertHeader('x-data-version', 'dvf-2025-10')

    const body = response.body()
    assert.equal(body.datasetVersion, 'dvf-2025-10')
    assert.equal(body.coveredDepartmentsCount, 1)
    // La mention légale porte la date réelle, jamais une constante du front.
    assert.include(body.attributionFr, 'octobre 2025')
    assert.include(body.attributionFr, 'Licence Ouverte / Etalab 2.0')
  })
})

test.group('CORS (§2.5)', () => {
  test('autorise une origine de la liste blanche', async ({ client }) => {
    const response = await client
      .get('/v1/meta/data-version')
      .header('Origin', 'https://estimer.co')

    response.assertStatus(200)
    response.assertHeader('access-control-allow-origin', 'https://estimer.co')
  })

  test('n’autorise pas une origine hors liste', async ({ client, assert }) => {
    const response = await client
      .get('/v1/meta/data-version')
      .header('Origin', 'https://exemple-malveillant.test')

    // Le navigateur bloquera la lecture faute d'en-tête d'autorisation.
    assert.isUndefined(response.headers()['access-control-allow-origin'])
  })

  test('expose Retry-After et X-Data-Version au navigateur', async ({ client, assert }) => {
    // Sans `exposeHeaders`, le front ne pourrait pas lire le délai d'un 429.
    const response = await client
      .get('/v1/meta/data-version')
      .header('Origin', 'https://estimer.co')

    // Les noms d'en-tête sont insensibles à la casse (RFC 9110) : le
    // middleware les normalise en minuscules.
    const exposed = String(response.headers()['access-control-expose-headers'] ?? '').toLowerCase()
    assert.include(exposed, 'retry-after')
    assert.include(exposed, 'x-data-version')
  })

  test('la requête préalable OPTIONS annonce les méthodes autorisées', async ({
    client,
    assert,
  }) => {
    const response = await client
      .options('/v1/geocode')
      .header('Origin', 'https://estimer.co')
      .header('Access-Control-Request-Method', 'GET')

    const allowed = String(response.headers()['access-control-allow-methods'] ?? '')
    assert.include(allowed, 'GET')
    assert.include(allowed, 'POST')

    // Aucune session, aucun cookie : les identifiants ne doivent jamais
    // être autorisés (§2.5).
    assert.notEqual(response.headers()['access-control-allow-credentials'], 'true')
  })
})
