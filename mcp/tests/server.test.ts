import { test } from 'node:test'
import assert from 'node:assert/strict'

import { startServer } from '../src/server.js'
import { MissingConfigError } from '../src/config.js'

test('startServer rejette immédiatement si la configuration est incomplète (jamais de transport ouvert)', async () => {
  await assert.rejects(
    () => startServer({}),
    (error: unknown) => error instanceof MissingConfigError
  )
})
