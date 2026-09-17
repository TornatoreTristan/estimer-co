/**
 * Configuration du serveur MCP (specs/blog-automatisation-ia.md §7).
 *
 * Deux variables d'environnement obligatoires : `ESTIMER_API_URL` (racine de
 * l'API AdonisJS, sans le préfixe `/v1/blog`) et `ESTIMER_BLOG_TOKEN` (jeton
 * Bearer créé via `node ace blog:client:create`, cf. `api/README.md`).
 *
 * Le jeton n'est JAMAIS journalisé ni renvoyé dans un message d'erreur : seul
 * son ABSENCE est signalée.
 */
export interface McpConfig {
  /** Racine de l'API, sans slash final ni suffixe `/v1/blog` (ex. `https://api.estimer.co`). */
  readonly apiUrl: string
  /** Jeton Bearer du client `/v1/blog/**`. */
  readonly token: string
}

export class MissingConfigError extends Error {
  constructor(missingVars: string[]) {
    super(
      `Variable(s) d'environnement manquante(s) : ${missingVars.join(', ')}. ` +
        "Renseignez ESTIMER_API_URL (racine de l'API, ex. https://api.estimer.co) et " +
        'ESTIMER_BLOG_TOKEN (jeton créé via `node ace blog:client:create`) avant de démarrer ' +
        'le serveur MCP — voir mcp/README.md.'
    )
    this.name = 'MissingConfigError'
  }
}

/**
 * Lit et valide la configuration depuis l'environnement. Lève
 * `MissingConfigError` (message clair, sans secret) si une variable requise
 * est absente ou vide.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const rawApiUrl = env.ESTIMER_API_URL?.trim()
  const rawToken = env.ESTIMER_BLOG_TOKEN?.trim()

  const missing: string[] = []
  if (!rawApiUrl) missing.push('ESTIMER_API_URL')
  if (!rawToken) missing.push('ESTIMER_BLOG_TOKEN')
  if (missing.length > 0) {
    throw new MissingConfigError(missing)
  }

  return {
    // Retire un éventuel slash final : les chemins d'appel commencent tous par `/v1/blog/...`.
    apiUrl: (rawApiUrl as string).replace(/\/+$/, ''),
    token: rawToken as string,
  }
}
