/*
|--------------------------------------------------------------------------
| Limiteurs HTTP — spec §2.6
|--------------------------------------------------------------------------
|
| | Route                      | Limite                  | Clé       |
| |----------------------------|-------------------------|-----------|
| | POST /v1/estimations       | 10 / min ET 60 / jour   | IP client |
| | GET  /v1/geocode           | 30 / min                | IP client |
| | GET  /v1/marche/:codeInsee | 60 / min                | IP client |
| | Global (toutes routes)     | 120 / min               | IP client |
|
| La clé est TOUJOURS `ctx.clientIp`, résolu par `ClientIpMiddleware` en
| tenant compte de `TRUSTED_PROXY`. Elle est préfixée par la portée pour que
| les compteurs de deux routes ne se mélangent jamais dans le store.
|
| Le rendu du 429 (corps `{ code: 'RATE_LIMITED', … }` + en-tête `Retry-After`)
| est centralisé dans `app/exceptions/handler.ts`.
|
*/

import limiter from '@adonisjs/limiter/services/main'
import type { HttpContext } from '@adonisjs/core/http'
import env from '#start/env'
import { rateLimitKey } from '#lib/client_ip'

/**
 * Analyse une limite exprimée en « N/durée » (ex. « 10/1 minute »), telle que
 * fournie par l'environnement. Retombe sur la valeur par défaut de la spec si
 * la variable est absente ou illisible : une variable mal saisie ne doit pas
 * désactiver silencieusement une protection.
 */
export function parseRateLimit(
  value: string | undefined,
  fallback: { requests: number; duration: string }
): { requests: number; duration: string } {
  if (!value) {
    return fallback
  }

  const match = value.trim().match(/^(\d+)\s*\/\s*(.+)$/)
  if (!match) {
    return fallback
  }

  const requests = Number.parseInt(match[1], 10)
  const duration = match[2].trim()

  if (!Number.isFinite(requests) || requests <= 0 || duration.length === 0) {
    return fallback
  }

  return { requests, duration }
}

function keyFor(scope: string, ctx: HttpContext): string {
  return rateLimitKey(scope, ctx.clientIp)
}

/** 120 req/min, appliqué à l'ensemble des routes `/v1`. */
export const throttleGlobal = limiter.define('global', (ctx) => {
  const { requests, duration } = parseRateLimit(env.get('RATE_LIMIT_GLOBAL'), {
    requests: 120,
    duration: '1 minute',
  })

  return limiter.allowRequests(requests).every(duration).usingKey(keyFor('global', ctx))
})

/** 30 req/min sur `GET /v1/geocode`. */
export const throttleGeocode = limiter.define('geocode', (ctx) => {
  const { requests, duration } = parseRateLimit(env.get('RATE_LIMIT_GEOCODE'), {
    requests: 30,
    duration: '1 minute',
  })

  return limiter.allowRequests(requests).every(duration).usingKey(keyFor('geocode', ctx))
})

/** 60 req/min sur `GET /v1/marche/:codeInsee` (consommé au Lot 2). */
export const throttleMarche = limiter.define('marche', (ctx) => {
  const { requests, duration } = parseRateLimit(env.get('RATE_LIMIT_MARCHE'), {
    requests: 60,
    duration: '1 minute',
  })

  return limiter.allowRequests(requests).every(duration).usingKey(keyFor('marche', ctx))
})

/**
 * 10 req/min sur `POST /v1/estimations`.
 * Le Lot 2 appliquera `throttleEstimation` ET `throttleEstimationDaily`.
 */
export const throttleEstimation = limiter.define('estimation', (ctx) => {
  const { requests, duration } = parseRateLimit(env.get('RATE_LIMIT_ESTIMATION'), {
    requests: 10,
    duration: '1 minute',
  })

  return limiter.allowRequests(requests).every(duration).usingKey(keyFor('estimation', ctx))
})

/** 60 req/jour sur `POST /v1/estimations`, cumulé avec la limite par minute. */
export const throttleEstimationDaily = limiter.define('estimation_daily', (ctx) => {
  const { requests, duration } = parseRateLimit(env.get('RATE_LIMIT_ESTIMATION_DAILY'), {
    requests: 60,
    duration: '1 day',
  })

  return limiter.allowRequests(requests).every(duration).usingKey(keyFor('estimation_day', ctx))
})
