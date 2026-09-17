import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BlogApiClient, BlogApiError, BlogApiNetworkError } from '../src/blog_api_client.js'
import { startFakeApiServer } from './helpers/fake_api_server.js'

test('POST envoie Authorization Bearer, Idempotency-Key et un corps JSON', async () => {
  const fakeServer = await startFakeApiServer()
  try {
    fakeServer.setResponse(201, {
      slug: 'x',
      statut: 'brouillon',
      job: { id: 'job-1', status: 'pr_open' },
      prUrl: 'https://github.com/x/pull/1',
    })
    const client = new BlogApiClient({ apiUrl: fakeServer.url, token: 'jeton-de-test' })
    const result = await client.request('POST', '/v1/blog/articles', {
      body: { title: 'Titre' },
      idempotencyKey: 'abc-123',
    })
    assert.deepEqual(result, {
      slug: 'x',
      statut: 'brouillon',
      job: { id: 'job-1', status: 'pr_open' },
      prUrl: 'https://github.com/x/pull/1',
    })

    const recorded = fakeServer.lastRequest()
    assert.equal(recorded?.method, 'POST')
    assert.equal(recorded?.headers['authorization'], 'Bearer jeton-de-test')
    assert.equal(recorded?.headers['idempotency-key'], 'abc-123')
    assert.match(String(recorded?.headers['content-type']), /application\/json/)
    assert.deepEqual(recorded?.body, { title: 'Titre' })
  } finally {
    await fakeServer.close()
  }
})

test('GET ne pose ni Content-Type ni Idempotency-Key', async () => {
  const fakeServer = await startFakeApiServer()
  try {
    fakeServer.setResponse(200, { categories: [] })
    const client = new BlogApiClient({ apiUrl: fakeServer.url, token: 'jeton-de-test' })
    await client.request('GET', '/v1/blog/categories')
    const recorded = fakeServer.lastRequest()
    assert.equal(recorded?.method, 'GET')
    assert.equal(recorded?.headers['idempotency-key'], undefined)
    assert.equal(recorded?.headers['content-type'], undefined)
  } finally {
    await fakeServer.close()
  }
})

test('une réponse non-2xx lève BlogApiError avec le statut et le corps exacts', async () => {
  const fakeServer = await startFakeApiServer()
  try {
    fakeServer.setResponse(422, {
      code: 'VALIDATION_ERROR',
      errors: [{ field: 'categorie', rule: 'enum', message: 'catégorie inconnue' }],
    })
    const client = new BlogApiClient({ apiUrl: fakeServer.url, token: 'jeton-de-test' })
    await assert.rejects(
      () => client.request('POST', '/v1/blog/articles', { body: {}, idempotencyKey: 'k' }),
      (error: unknown) => {
        if (!(error instanceof BlogApiError)) return false
        assert.equal(error.status, 422)
        assert.deepEqual(error.body, {
          code: 'VALIDATION_ERROR',
          errors: [{ field: 'categorie', rule: 'enum', message: 'catégorie inconnue' }],
        })
        return true
      }
    )
  } finally {
    await fakeServer.close()
  }
})

test('un serveur injoignable lève BlogApiNetworkError, jamais une exception brute', async () => {
  const client = new BlogApiClient({ apiUrl: 'http://127.0.0.1:1', token: 'jeton-de-test' })
  await assert.rejects(
    () => client.request('GET', '/v1/blog/categories'),
    (error: unknown) => error instanceof BlogApiNetworkError
  )
})
