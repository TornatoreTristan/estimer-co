import { BlogApiError, BlogApiNetworkError } from './blog_api_client.js'

interface FieldErrorLike {
  field?: unknown
  rule?: unknown
  message?: unknown
}

function isFieldErrorLike(value: unknown): value is FieldErrorLike {
  return typeof value === 'object' && value !== null
}

/**
 * Traduit une erreur de l'API blog en texte lisible par un modèle de
 * langage, avec assez de détail pour corriger et renvoyer (§7 : « corriger
 * et renvoyer après un 422 »). Ne réinterprète aucune règle métier : se
 * contente de mettre en forme le corps déjà renvoyé par l'API.
 */
export function formatBlogApiError(error: unknown): string {
  if (error instanceof BlogApiNetworkError) {
    return error.message
  }

  if (!(error instanceof BlogApiError)) {
    return error instanceof Error ? error.message : String(error)
  }

  const body = error.body as Record<string, unknown> | undefined
  const lines: string[] = [`Échec de l'appel à l'API blog (HTTP ${error.status}).`]

  const fieldErrors = Array.isArray(body?.errors) ? (body!.errors as unknown[]) : undefined
  if (fieldErrors && fieldErrors.every(isFieldErrorLike) && body?.error !== 'validation_failed') {
    lines.push('Champs en erreur :')
    for (const raw of fieldErrors) {
      const fieldError = raw as FieldErrorLike
      lines.push(`- ${String(fieldError.field ?? '?')} : ${String(fieldError.message ?? '(pas de message)')}`)
    }
    lines.push("Corrigez ces champs dans l'appel et renvoyez-le.")
    return lines.join('\n')
  }

  switch (body?.error) {
    case 'operation_in_progress':
      lines.push(
        `Une opération est déjà en cours sur ce slug (job ${String(body.jobId ?? '?')}). ` +
          'Attendez sa fin — consultable via get_job_status — avant de réessayer.'
      )
      break
    case 'idempotency_key_reused':
      lines.push(
        "La clé d'idempotence fournie a déjà servi pour un appel avec un contenu différent. " +
          'Générez une nouvelle clé (ou omettez idempotencyKey pour en obtenir une automatiquement) ' +
          'si le contenu a réellement changé.'
      )
      break
    case 'conflict':
      lines.push(String(body.message ?? 'La ressource existe déjà.'))
      break
    case 'unauthorized':
      lines.push('Le jeton (ESTIMER_BLOG_TOKEN) est absent, invalide ou révoqué côté API.')
      break
    case 'forbidden': {
      const missingScopes = Array.isArray(body.missingScopes) ? body.missingScopes.join(', ') : '?'
      lines.push(`Le jeton configuré n'a pas le scope requis pour cette action : ${missingScopes}.`)
      break
    }
    case 'not_found':
      lines.push(String(body.message ?? 'Ressource introuvable.'))
      break
    case 'validation_failed': {
      lines.push('Rapport de la validation de contenu (gate de publication ou de brouillon) :')
      const errors = Array.isArray(body.errors) ? body.errors : []
      const warnings = Array.isArray(body.warnings) ? body.warnings : []
      for (const issue of errors) lines.push(`- [erreur] ${JSON.stringify(issue)}`)
      for (const issue of warnings) lines.push(`- [avertissement] ${JSON.stringify(issue)}`)
      lines.push('Corrigez le contenu en conséquence puis renvoyez la demande.')
      break
    }
    default:
      if (body?.code === 'RATE_LIMITED') {
        lines.push(String(body.message ?? 'Quota dépassé, réessayez plus tard.'))
      } else if (body?.code === 'VALIDATION_ERROR' && fieldErrors) {
        // Cas normalement déjà couvert ci-dessus ; filet de sécurité si `error` diffère.
        lines.push('Champs en erreur :')
        for (const raw of fieldErrors) {
          const fieldError = raw as FieldErrorLike
          lines.push(`- ${String(fieldError.field ?? '?')} : ${String(fieldError.message ?? '(pas de message)')}`)
        }
      } else {
        lines.push(body ? JSON.stringify(body) : error.message)
      }
  }

  return lines.join('\n')
}
