import env from '#start/env'
import { defineConfig, stores } from '@adonisjs/limiter'
import type { InferLimiters } from '@adonisjs/limiter/types'

/**
 * Rate limiting — spec §2.6.
 *
 * Store `database` (PostgreSQL) au Lot 0 : pas de Redis à exploiter tant que
 * la charge ne le justifie pas. Le passage à Redis se fera en changeant
 * `LIMITER_STORE`, sans toucher aux définitions de `start/limiter.ts`.
 *
 * Le store `memory` est réservé aux tests : il évite d'avoir à nettoyer une
 * table entre chaque cas, et rend les tests de quota déterministes.
 */
const limiterConfig = defineConfig({
  default: env.get('LIMITER_STORE'),
  stores: {
    database: stores.database({
      connectionName: 'postgres',
      tableName: 'rate_limits',
    }),
    memory: stores.memory({}),
  },
})

export default limiterConfig

declare module '@adonisjs/limiter/types' {
  export interface LimitersList extends InferLimiters<typeof limiterConfig> {}
}
