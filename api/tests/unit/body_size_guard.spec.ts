import { test } from '@japa/runner'
import { DEFAULT_MAX_BODY_BYTES, evaluateBodySizeGuard } from '#lib/body_size_guard'

/**
 * `app/lib/body_size_guard.ts` — revue QA, critique C1.
 *
 * Fonction pure : ces tests couvrent la décision (413/411/401/continue) sans
 * requête HTTP réelle, ce qui permet notamment de tester le cas « chunked
 * sans Content-Length » sans avoir à forger un vrai flux HTTP chunked dans un
 * test fonctionnel.
 */

function base(overrides: Partial<Parameters<typeof evaluateBodySizeGuard>[0]> = {}) {
  return {
    method: 'POST',
    pathname: '/v1/leads',
    hasBody: true,
    contentLength: '100',
    authorizationHeader: undefined,
    ...overrides,
  }
}

test.group('body_size_guard | méthodes sans corps', () => {
  test('GET/HEAD/OPTIONS ne sont jamais bloqués, quel que soit Content-Length', ({ assert }) => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const decision = evaluateBodySizeGuard(
        base({ method, hasBody: false, contentLength: undefined })
      )
      assert.deepEqual(decision, { action: 'continue' })
    }
  })
})

test.group('body_size_guard | pas de corps annoncé', () => {
  test('hasBody=false laisse toujours passer, même en POST', ({ assert }) => {
    const decision = evaluateBodySizeGuard(base({ hasBody: false, contentLength: undefined }))
    assert.deepEqual(decision, { action: 'continue' })
  })
})

test.group('body_size_guard | routes hors /v1/blog/', () => {
  test('un Content-Length sous le seuil par défaut passe', ({ assert }) => {
    const decision = evaluateBodySizeGuard(base({ contentLength: '1000' }))
    assert.deepEqual(decision, { action: 'continue' })
  })

  test('un Content-Length égal au seuil passe (limite inclusive)', ({ assert }) => {
    const decision = evaluateBodySizeGuard(base({ contentLength: String(DEFAULT_MAX_BODY_BYTES) }))
    assert.deepEqual(decision, { action: 'continue' })
  })

  test('un Content-Length au-delà du seuil est rejeté en 413, sans lecture', ({ assert }) => {
    const decision = evaluateBodySizeGuard(
      base({ contentLength: String(DEFAULT_MAX_BODY_BYTES + 1) })
    )
    assert.equal(decision.action, 'reject')
    if (decision.action === 'reject') {
      assert.equal(decision.status, 413)
      assert.equal(decision.code, 'PAYLOAD_TOO_LARGE')
    }
  })

  test('un seuil par route (ex. 4 Ko sur /v1/estimations) est respecté quand il est fourni', ({
    assert,
  }) => {
    const decision = evaluateBodySizeGuard(base({ contentLength: '4097' }), 4096)
    assert.equal(decision.action, 'reject')
    if (decision.action === 'reject') assert.equal(decision.status, 413)
  })

  test('corps annoncé (Transfer-Encoding) sans Content-Length → 411, sans lecture', ({
    assert,
  }) => {
    // hasBody() (type-is) est vrai dès que Transfer-Encoding est présent —
    // Content-Length peut alors être absent : c'est le cas chunked.
    const decision = evaluateBodySizeGuard(base({ contentLength: undefined }))
    assert.equal(decision.action, 'reject')
    if (decision.action === 'reject') {
      assert.equal(decision.status, 411)
      assert.equal(decision.code, 'LENGTH_REQUIRED')
    }
  })

  test('un Content-Length illisible (non numérique) → 411', ({ assert }) => {
    const decision = evaluateBodySizeGuard(base({ contentLength: 'pas-un-nombre' }))
    assert.equal(decision.action, 'reject')
    if (decision.action === 'reject') assert.equal(decision.status, 411)
  })

  test('une requête lead légitime de 5 000 caractères accentués reste sous le seuil par défaut', ({
    assert,
  }) => {
    // Corps JSON réaliste le plus lourd hors blog : `message` à 5 000
    // caractères (LEAD_MESSAGE_MAX_LENGTH), + les autres champs de
    // `app/validators/lead.ts`, tous à leur longueur maximale, avec des
    // caractères sur 4 octets en UTF-8 (le pire cas d'encodage). Mesuré à
    // ~25 Ko : très en-dessous des 64 Kio par défaut.
    const worstCaseLeadBytes = 26_000
    const decision = evaluateBodySizeGuard(base({ contentLength: String(worstCaseLeadBytes) }))
    assert.deepEqual(decision, { action: 'continue' })
  })
})

test.group('body_size_guard | /v1/blog/**', () => {
  test('exempté du seuil de taille, quel que soit Content-Length, si le jeton est au bon format', ({
    assert,
  }) => {
    const decision = evaluateBodySizeGuard(
      base({
        pathname: '/v1/blog/articles',
        contentLength: String(14 * 1024 * 1024),
        authorizationHeader: 'Bearer un-jeton-quelconque',
      })
    )
    assert.deepEqual(decision, { action: 'continue' })
  })

  test('en-tête Authorization absent → 401, avant lecture du corps', ({ assert }) => {
    const decision = evaluateBodySizeGuard(
      base({
        pathname: '/v1/blog/articles',
        contentLength: String(14 * 1024 * 1024),
        authorizationHeader: undefined,
      })
    )
    assert.deepEqual(decision, { action: 'blog_unauthorized' })
  })

  test('en-tête Authorization mal formé (pas "Bearer <token>") → 401', ({ assert }) => {
    for (const header of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer   ', 'token-tout-seul']) {
      const decision = evaluateBodySizeGuard(
        base({ pathname: '/v1/blog/auteurs', authorizationHeader: header })
      )
      assert.deepEqual(decision, { action: 'blog_unauthorized' }, `en-tête refusé : "${header}"`)
    }
  })

  test('une requête GET (sans corps) sur /v1/blog/** n’est pas concernée par ce garde', ({
    assert,
  }) => {
    // La vérification de forme du jeton ne s'applique qu'aux requêtes qui
    // annoncent un corps : la vraie authentification (BlogAuthMiddleware)
    // reste seule responsable des GET.
    const decision = evaluateBodySizeGuard(
      base({
        method: 'GET',
        pathname: '/v1/blog/categories',
        hasBody: false,
        contentLength: undefined,
        authorizationHeader: undefined,
      })
    )
    assert.deepEqual(decision, { action: 'continue' })
  })
})
