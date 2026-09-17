import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

import BlogApiClient, { type BlogScope } from '#models/blog_api_client'
import { sha256Hex } from '#services/blog/hash'
import { BlogForbiddenError, BlogUnauthorizedError } from '#exceptions/blog_errors'

/**
 * Authentification Bearer + scopes de `/v1/blog/**` (US A1/A2 — specs/blog-
 * automatisation-ia.md §5). Le jeton n'est JAMAIS stocké en clair : on
 * compare son empreinte SHA-256 à `blog_api_clients.token_hash`.
 *
 * Usage : `middleware.blogAuth()` (jeton valide requis, aucun scope
 * particulier) ou `middleware.blogAuth({ scopes: ['articles:write'] })`.
 */
export default class BlogAuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options?: { scopes?: BlogScope[] }) {
    const header = ctx.request.header('authorization')
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]

    if (!token) {
      throw new BlogUnauthorizedError()
    }

    const client = await BlogApiClient.query().where('tokenHash', sha256Hex(token)).first()

    if (!client || client.isRevoked) {
      throw new BlogUnauthorizedError()
    }

    const requiredScopes = options?.scopes ?? []
    const missingScopes = requiredScopes.filter((scope) => !client.hasScope(scope))
    if (missingScopes.length > 0) {
      throw new BlogForbiddenError(missingScopes)
    }

    ctx.blogClient = client
    return next()
  }
}

declare module '@adonisjs/core/http' {
  export interface HttpContext {
    /** Client authentifié sur `/v1/blog/**`, posé par `BlogAuthMiddleware`. */
    blogClient: BlogApiClient
  }
}
