import { test } from '@japa/runner'
import limiter from '@adonisjs/limiter/services/main'

/**
 * Rate limiting — spec §2.6, US-8.
 *
 * Le store est `memory` en test (`.env.test`) : les compteurs sont
 * déterministes et n'exigent aucun nettoyage de table.
 */

test.group('Rate limiting | GET /v1/geocode (30 req/min)', (group) => {
  group.each.setup(async () => {
    // Repart d'un compteur vierge pour chaque cas.
    await limiter.clear(['memory'])
  })

  test('un dépassement renvoie 429 avec Retry-After et un corps exploitable', async ({
    client,
    assert,
  }) => {
    /*
     * US-8 : « l'API répond 429 avec un en-tête Retry-After » et le front
     * affiche « Trop de demandes, réessayez dans N secondes » SANS retenter.
     * Le délai doit donc être lisible par le front — d'où `retryAfter` dans
     * le corps ET l'en-tête exposé par CORS.
     */
    const quota = 30
    let limited: Awaited<ReturnType<typeof client.get>> | null = null

    for (let attempt = 0; attempt < quota + 1; attempt += 1) {
      const response = await client.get('/v1/geocode').qs({ q: 'rue de la paix' })
      if (response.status() === 429) {
        limited = response
        break
      }
    }

    assert.isNotNull(limited, 'le quota devait finir par être atteint')
    if (!limited) return

    limited.assertStatus(429)

    const body = limited.body()
    assert.equal(body.code, 'RATE_LIMITED')
    assert.isNumber(body.retryAfter)
    assert.isAbove(body.retryAfter, 0)
    // Message en français, prêt à afficher.
    assert.match(body.message, /Trop de requêtes/i)

    const retryAfter = limited.headers()['retry-after']
    assert.exists(retryAfter, 'l’en-tête Retry-After est obligatoire')
    assert.equal(Number(retryAfter), body.retryAfter)
  })

  test('les quotas sont cloisonnés par IP', async ({ client, assert }) => {
    /*
     * La clé de limitation est `ctx.clientIp`. En test, la connexion vient de
     * 127.0.0.1, déclarée dans TRUSTED_PROXY : `X-Forwarded-For` est donc
     * honoré, ce qui permet de simuler deux clients distincts.
     *
     * C'est aussi la démonstration inverse : si 127.0.0.1 n'était PAS
     * déclarée de confiance, l'en-tête serait ignoré et les deux requêtes
     * partageraient le même compteur.
     */
    await limiter.clear(['memory'])

    for (let attempt = 0; attempt < 31; attempt += 1) {
      await client
        .get('/v1/geocode')
        .qs({ q: 'rue de la paix' })
        .header('X-Forwarded-For', '203.0.113.10')
    }

    // Le premier client est saturé…
    const saturated = await client
      .get('/v1/geocode')
      .qs({ q: 'rue de la paix' })
      .header('X-Forwarded-For', '203.0.113.10')
    saturated.assertStatus(429)

    // … mais un autre client conserve son quota intact.
    const other = await client
      .get('/v1/geocode')
      .qs({ q: 'rue de la paix' })
      .header('X-Forwarded-For', '198.51.100.20')
    assert.notEqual(other.status(), 429)
  })

  test('/health n’est jamais soumis au rate limiting (§6.1)', async ({ client }) => {
    await limiter.clear(['memory'])

    // Bien au-delà de tous les quotas : une sonde ne doit jamais être bloquée.
    for (let attempt = 0; attempt < 130; attempt += 1) {
      await client.get('/health')
    }

    const response = await client.get('/health')
    response.assertStatus(200)
  })
})

test.group('Garde d’Origin (§2.6)', () => {
  test('hors production, la vérification d’Origin est inactive', async ({ client }) => {
    /*
     * Le garde ne s'active qu'en production : en test et en développement, il
     * empêcherait les appels en ligne de commande et les sondes.
     *
     * La règle « Origin absente ou hors liste ⇒ 403 FORBIDDEN_ORIGIN » est
     * couverte par un test unitaire du middleware plutôt que par un test
     * HTTP, car forcer NODE_ENV=production le temps d'une requête
     * reconfigurerait tout le conteneur applicatif.
     */
    const response = await client.get('/v1/meta/data-version')
    response.assertStatus(200)
  })
})
