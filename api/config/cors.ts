import { defineConfig } from '@adonisjs/cors'
import { allowedOrigins } from '#config/origins'

/**
 * Politique CORS — spec §2.5.
 *
 * Liste blanche stricte pilotée par `CORS_ORIGINS` (CSV), pour pouvoir
 * autoriser une preview sans reconstruire l'image.
 *
 * `credentials: false` est délibéré : le site n'a aucune authentification et
 * l'API n'accepte aucune PII (§2.6). Aucun cookie ne doit donc circuler.
 *
 * `GET /health` est servi hors CORS (§6.1) : voir `start/routes.ts`, la route
 * est déclarée sans dépendre de l'en-tête `Origin`, et le middleware CORS
 * n'ajoute simplement aucun en-tête `Access-Control-Allow-Origin` quand
 * l'origine est absente — ce qui est le comportement attendu pour une sonde
 * de liveness appelée par Coolify sans navigateur.
 */
const corsConfig = defineConfig({
  enabled: true,

  origin: (origin) => allowedOrigins().includes(origin),

  methods: ['GET', 'POST', 'OPTIONS'],
  headers: ['Content-Type', 'Accept'],

  // `Retry-After` : le front doit pouvoir lire le délai en cas de 429.
  // `X-Data-Version` : millésime des données servi sur toutes les 200 (§6.1).
  exposeHeaders: ['Retry-After', 'X-Data-Version'],

  credentials: false,
  maxAge: 86400,
})

export default corsConfig
