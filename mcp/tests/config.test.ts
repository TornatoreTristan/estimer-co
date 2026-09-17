import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadConfig, MissingConfigError } from '../src/config.js'

test('loadConfig échoue avec un message clair si les deux variables sont absentes', () => {
  assert.throws(
    () => loadConfig({}),
    (error: unknown) => {
      if (!(error instanceof MissingConfigError)) return false
      assert.match(error.message, /ESTIMER_API_URL/)
      assert.match(error.message, /ESTIMER_BLOG_TOKEN/)
      return true
    }
  )
})

test('loadConfig ne réclame que la variable réellement absente', () => {
  assert.throws(
    () => loadConfig({ ESTIMER_API_URL: 'https://api.example.test' }),
    (error: unknown) => {
      if (!(error instanceof MissingConfigError)) return false
      assert.match(error.message, /Variable\(s\) d'environnement manquante\(s\) : ESTIMER_BLOG_TOKEN\./)
      return true
    }
  )
})

test('loadConfig retire le slash final de apiUrl et conserve le jeton tel quel', () => {
  const config = loadConfig({
    ESTIMER_API_URL: 'https://api.example.test/',
    ESTIMER_BLOG_TOKEN: 'secret-token',
  })
  assert.equal(config.apiUrl, 'https://api.example.test')
  assert.equal(config.token, 'secret-token')
})

test('loadConfig traite une variable vide comme absente', () => {
  assert.throws(
    () => loadConfig({ ESTIMER_API_URL: '   ', ESTIMER_BLOG_TOKEN: 'secret-token' }),
    MissingConfigError
  )
})
