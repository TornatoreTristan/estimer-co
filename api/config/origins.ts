import env from '#start/env'

/**
 * Origines autorisées, dérivées de `CORS_ORIGINS` (CSV) — spec §2.5.
 *
 * Source unique de vérité partagée par la politique CORS (`config/cors.ts`)
 * et par le garde d'`Origin` (`app/middleware/origin_guard_middleware.ts`),
 * pour qu'une origine ne puisse jamais être acceptée par l'un et refusée par
 * l'autre.
 */
export function allowedOrigins(): string[] {
  return parseOrigins(env.get('CORS_ORIGINS'))
}

/**
 * Fonction pure : découpe la liste CSV, retire les espaces, les entrées vides
 * et la barre oblique finale (`https://estimer.co/` et `https://estimer.co`
 * sont la même origine, mais un navigateur envoie toujours la forme sans
 * barre finale).
 */
/**
 * Décision d'autorisation d'une origine — fonction pure.
 *
 * Extraite du middleware pour être testable sans monter un serveur HTTP ni
 * basculer l'application en mode production.
 *
 * Une requête **sans** `Origin` est refusée en production (§2.6, point 3) :
 * c'est le cas d'un appel cURL ou d'une intégration sauvage. Les sondes, qui
 * n'envoient pas d'`Origin` non plus, sont servies par `/health`, route
 * déclarée hors de ce garde.
 */
export function isOriginAllowed(origin: string | undefined | null, allowed: string[]): boolean {
  const normalized = origin?.trim().replace(/\/+$/, '')

  if (!normalized) {
    return false
  }

  return allowed.includes(normalized)
}

export function parseOrigins(csv: string | undefined): string[] {
  if (!csv) {
    return []
  }

  return csv
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0)
}
