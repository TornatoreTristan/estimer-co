import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BlogApiError, BlogApiNetworkError } from '../src/blog_api_client.js'
import { formatBlogApiError } from '../src/format_error.js'

test('formate une 422 de validation de forme champ par champ', () => {
  const error = new BlogApiError(422, {
    code: 'VALIDATION_ERROR',
    errors: [
      { field: 'categorie', rule: 'enum', message: 'catégorie inconnue — valeurs autorisées : conseils.' },
    ],
  })
  const text = formatBlogApiError(error)
  assert.match(text, /HTTP 422/)
  assert.match(text, /categorie/)
  assert.match(text, /catégorie inconnue/)
})

test("formate une réutilisation de clé d'idempotence", () => {
  const error = new BlogApiError(422, { error: 'idempotency_key_reused' })
  const text = formatBlogApiError(error)
  assert.match(text, /idempotence/i)
})

test('formate une opération déjà en cours avec le jobId', () => {
  const error = new BlogApiError(409, { error: 'operation_in_progress', jobId: 'job-42' })
  const text = formatBlogApiError(error)
  assert.match(text, /job-42/)
})

test("formate un conflit d'id d'auteur (409)", () => {
  const error = new BlogApiError(409, { error: 'conflict', message: 'Un auteur "jean-dupont" existe déjà.' })
  const text = formatBlogApiError(error)
  assert.match(text, /existe déjà/)
})

test('formate un 401 sans jamais faire apparaître de jeton', () => {
  const error = new BlogApiError(401, { error: 'unauthorized' })
  const text = formatBlogApiError(error)
  assert.match(text, /jeton/i)
  assert.doesNotMatch(text, /Bearer/)
})

test('formate un 403 avec les scopes manquants', () => {
  const error = new BlogApiError(403, { error: 'forbidden', missingScopes: ['publish:request'] })
  const text = formatBlogApiError(error)
  assert.match(text, /publish:request/)
})

test('formate le rapport de la gate de publication (validation_failed)', () => {
  const error = new BlogApiError(422, {
    error: 'validation_failed',
    errors: [{ level: 'error', file: 'src/content/articles/x.md', field: 'metaDescription', message: 'requis' }],
    warnings: [],
  })
  const text = formatBlogApiError(error)
  assert.match(text, /metaDescription/)
  assert.match(text, /erreur/)
})

test('formate une 429 de quota dépassé', () => {
  const error = new BlogApiError(429, { code: 'RATE_LIMITED', message: 'Trop de requêtes, réessayez dans 12 secondes.', retryAfter: 12 })
  const text = formatBlogApiError(error)
  assert.match(text, /Trop de requêtes/)
})

test('formate une erreur réseau sans lever à nouveau', () => {
  const error = new BlogApiNetworkError(new Error('connect ECONNREFUSED'))
  const text = formatBlogApiError(error)
  assert.match(text, /Impossible de joindre/)
})

test('retombe sur le message brut pour une erreur inattendue', () => {
  const text = formatBlogApiError(new Error('quelque chose a explosé'))
  assert.match(text, /quelque chose a explosé/)
})
