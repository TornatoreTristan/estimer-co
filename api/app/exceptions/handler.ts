import app from '@adonisjs/core/services/app'
import { HttpContext, ExceptionHandler } from '@adonisjs/core/http'
import { errors as vineErrors } from '@vinejs/vine'
import { errors as limiterErrors } from '@adonisjs/limiter'

/**
 * Gestionnaire d'erreurs HTTP — spec §6.1.
 *
 * Deux règles impératives :
 *  1. Les messages destinés à l'utilisateur sont **en français** et
 *     directement affichables par le front.
 *  2. **Aucune trace, aucun message SQL, aucun détail interne** ne franchit
 *     la frontière HTTP en production. Une erreur inattendue renvoie
 *     uniquement un `requestId`, qui permet de retrouver la trace complète
 *     dans les journaux serveur.
 */
export default class HttpExceptionHandler extends ExceptionHandler {
  protected debug = !app.inProduction

  async handle(error: unknown, ctx: HttpContext) {
    /*
     * 429 — quota dépassé (§2.6).
     * Corps `{ code, message, retryAfter }` + en-tête `Retry-After` en
     * secondes. Le front affiche le message tel quel et ne retente pas.
     */
    if (error instanceof limiterErrors.E_TOO_MANY_REQUESTS) {
      const retryAfter = Math.max(1, Math.ceil(error.response.availableIn))

      ctx.response.header('Retry-After', String(retryAfter))

      return ctx.response.status(429).send({
        code: 'RATE_LIMITED',
        message: `Trop de requêtes, réessayez dans ${retryAfter} secondes.`,
        retryAfter,
      })
    }

    /*
     * 422 — payload invalide. Les messages VineJS sont déjà francisés par
     * `start/validator.ts`. Le front les reporte champ par champ.
     */
    if (error instanceof vineErrors.E_VALIDATION_ERROR) {
      return ctx.response.status(422).send({
        code: 'VALIDATION_ERROR',
        errors: (error.messages as ValidationMessage[]).map((message) => ({
          field: message.field,
          rule: message.rule,
          message: message.message,
        })),
      })
    }

    /*
     * 404 — route inconnue. On ne divulgue pas la table des routes.
     */
    if (isHttpError(error) && error.status === 404) {
      return ctx.response.status(404).send({
        code: 'NOT_FOUND',
        message: 'Ressource introuvable.',
      })
    }

    /*
     * Erreurs applicatives explicitement typées (403, 503…) : elles portent
     * déjà un corps conforme, on laisse AdonisJS les rendre.
     */
    if (isHttpError(error) && error.status < 500) {
      return super.handle(error, ctx)
    }

    /*
     * 500 — tout le reste. Jamais de détail exposé.
     */
    return ctx.response.status(500).send({
      code: 'INTERNAL_ERROR',
      message: 'Une erreur interne est survenue. Réessayez dans quelques instants.',
      requestId: ctx.request.id(),
    })
  }

  async report(error: unknown, ctx: HttpContext) {
    return super.report(error, ctx)
  }
}

interface ValidationMessage {
  field: string
  rule: string
  message: string
}

function isHttpError(error: unknown): error is { status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  )
}
