/**
 * Erreurs applicatives du module blog (specs/blog-automatisation-ia.md §3-4).
 *
 * Les erreurs de FORME de payload restent portées par VineJS
 * (`errors.E_VALIDATION_ERROR`, déjà géré par `app/exceptions/handler.ts` —
 * corps `{ code: "VALIDATION_ERROR", errors: [{ field, rule, message }] }`,
 * compatible avec `{ errors: [{ field, message }] }` du §3). Cette classe ne
 * couvre que ce que Vine ne peut pas exprimer : connaissances qui dépendent
 * de l'état du dépôt Git (auteur/catégorie/PR), de la base (idempotence,
 * verrou), ou de l'authentification.
 */
export class BlogHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: Record<string, unknown>
  ) {
    super(typeof body.error === 'string' ? body.error : 'blog_error')
  }
}

/** 401 — jeton absent, invalide ou révoqué (A). */
export class BlogUnauthorizedError extends BlogHttpError {
  constructor() {
    super(401, { error: 'unauthorized' })
  }
}

/** 403 — jeton valide, scope manquant (A). */
export class BlogForbiddenError extends BlogHttpError {
  constructor(missingScopes: string[]) {
    super(403, { error: 'forbidden', missingScopes })
  }
}

/** 404 — job d'un autre client, ou ressource inconnue (§4 : « visible que par le client qui l'a créé »). */
export class BlogNotFoundError extends BlogHttpError {
  constructor(message = 'Ressource introuvable.') {
    super(404, { error: 'not_found', message })
  }
}

/** 409 — id d'auteur déjà existant (D). */
export class BlogConflictError extends BlogHttpError {
  constructor(message: string) {
    super(409, { error: 'conflict', message })
  }
}

/** 409 — verrou de slug déjà détenu (G2). */
export class BlogOperationInProgressError extends BlogHttpError {
  constructor(jobId: string | null) {
    super(409, { error: 'operation_in_progress', jobId })
  }
}

/** 422 — même Idempotency-Key, payload différent (B3). */
export class BlogIdempotencyKeyReusedError extends BlogHttpError {
  constructor() {
    super(422, { error: 'idempotency_key_reused' })
  }
}

/** 422 — rapport de la gate de publication, ou toute erreur relevée par `validate-content.mjs` (B4, F2). */
export class BlogValidationFailedError extends BlogHttpError {
  constructor(errors: unknown[], warnings: unknown[]) {
    super(422, { error: 'validation_failed', errors, warnings })
  }
}
