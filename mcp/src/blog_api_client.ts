import type { McpConfig } from './config.js'

/**
 * Erreur HTTP renvoyée par l'API blog (4xx/5xx). Porte le statut et le corps
 * JSON tels quels : c'est `format_error.ts` qui les traduit en texte pour le
 * modèle, jamais ce module (simple client HTTP, §7 : « aucune règle métier
 * réimplémentée »).
 */
export class BlogApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(`Erreur API blog (HTTP ${status})`)
    this.name = 'BlogApiError'
  }
}

/** Erreur réseau (API injoignable, DNS, timeout...) — distincte d'une réponse HTTP d'erreur. */
export class BlogApiNetworkError extends Error {
  constructor(cause: unknown) {
    super(`Impossible de joindre l'API blog : ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'BlogApiNetworkError'
    this.cause = cause
  }
}

export interface BlogApiRequestOptions {
  /** Corps JSON de la requête (sérialisé tel quel). Absent pour un GET. */
  body?: unknown
  /** En-tête `Idempotency-Key`, obligatoire côté API sur tout POST (§4). */
  idempotencyKey?: string
}

/**
 * Client HTTP minimal de `/v1/blog/**`. Ne connaît QUE la forme du transport
 * (en-têtes, encodage JSON, préfixe de route) — jamais une règle métier : la
 * validation, l'idempotence, les gates de publication restent entièrement
 * côté API (specs §7).
 */
export class BlogApiClient {
  readonly #config: McpConfig
  readonly #fetchImpl: typeof fetch

  constructor(config: McpConfig, fetchImpl: typeof fetch = fetch) {
    this.#config = config
    this.#fetchImpl = fetchImpl
  }

  async request<T>(method: string, path: string, options: BlogApiRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      // Le jeton ne transite que dans cet en-tête, jamais journalisé (cf. index.ts).
      Authorization: `Bearer ${this.#config.token}`,
      Accept: 'application/json',
    }

    let payload: string | undefined
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(options.body)
    }

    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey
    }

    let response: Response
    try {
      response = await this.#fetchImpl(`${this.#config.apiUrl}${path}`, {
        method,
        headers,
        body: payload,
      })
    } catch (error) {
      throw new BlogApiNetworkError(error)
    }

    const text = await response.text()
    const json = text.length > 0 ? safeJsonParse(text) : undefined

    if (!response.ok) {
      throw new BlogApiError(response.status, json ?? { message: text })
    }

    return json as T
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}
