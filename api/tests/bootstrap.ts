import { assert } from '@japa/assert'
import { apiClient } from '@japa/api-client'
import app from '@adonisjs/core/services/app'
import type { Config } from '@japa/runner/types'
import { pluginAdonisJS } from '@japa/plugin-adonisjs'
import testUtils from '@adonisjs/core/services/test_utils'

/**
 * This file is imported by the "bin/test.ts" entrypoint file
 */

export const plugins: Config['plugins'] = [assert(), apiClient(), pluginAdonisJS(app)]

/**
 * Les migrations sont jouées une fois pour toute la campagne de tests, puis
 * annulées.
 *
 * On ne peut pas se contenter d'une transaction globale ici : plusieurs
 * suites vérifient du DDL (création de partition annuelle, table temporaire
 * de l'ingestion) et l'import DVF gère ses propres transactions. Chaque
 * fichier de test nettoie donc les tables qu'il utilise.
 */
export const runnerHooks: Required<Pick<Config, 'setup' | 'teardown'>> = {
  setup: [() => testUtils.db().migrate()],
  teardown: [],
}

export const configureSuite: Config['configureSuite'] = (suite) => {
  if (['browser', 'functional', 'e2e'].includes(suite.name)) {
    return suite.setup(() => testUtils.httpServer().start())
  }
}
