import vine from '@vinejs/vine'
import { errors as vineErrors } from '@vinejs/vine'
import { SLUG_PATTERN } from '#services/blog/slug'

/**
 * Blocs partagés entre les validateurs `blog_article.ts` et `blog_auteur.ts`
 * (specs/blog-automatisation-ia.md §4).
 *
 * Rappel de périmètre (contrainte explicite de la spec) : ces validateurs ne
 * couvrent QUE ce qu'il faut pour renvoyer un 422 propre avant d'écrire quoi
 * que ce soit — forme des champs, enum de catégorie (chargé dynamiquement,
 * voir le contrôleur), `imageAlt` obligatoire si `image`. La gate de
 * publication (champs obligatoires pour `statut: publie`, longueur du corps…)
 * vient UNIQUEMENT de `scripts/validate-content.mjs`, jamais dupliquée ici.
 */

/** `slug`/`auteur`/`articlesLies` : même motif que `src/content.config.ts`, anti path-traversal. */
export const slugField = vine.string().trim().regex(SLUG_PATTERN)

export const imageInputValidator = vine.object({
  /** Contenu de l'image, encodé en base64. */
  data: vine.string().trim().minLength(1),
  /** Déclaratif seulement : le format réel est vérifié par signature binaire (`image_service.ts`). */
  mimeType: vine.string().trim().minLength(1),
})

export interface FieldError {
  field: string
  rule: string
  message: string
}

/**
 * Refuse tout champ non déclaré à la racine du corps (même choix que
 * `app/validators/lead.ts`) : un champ ajouté côté agent IA qui « ne remonte
 * pas » doit être visible immédiatement, pas silencieusement ignoré.
 */
export function assertNoUnknownFields(body: unknown, allowed: readonly string[]): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new vineErrors.E_VALIDATION_ERROR([
      { field: 'body', rule: 'object', message: 'Le corps de la requête doit être un objet JSON.' },
    ])
  }

  const allowedSet = new Set(allowed)
  const errors: FieldError[] = []
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (!allowedSet.has(key)) {
      errors.push({
        field: key,
        rule: 'unknown_field',
        message: "Ce champ n'est pas reconnu par l'API.",
      })
    }
  }

  if (errors.length > 0) {
    throw new vineErrors.E_VALIDATION_ERROR(errors)
  }
}

/** En-tête `Idempotency-Key` — obligatoire sur tout `POST` (§4). */
export function assertIdempotencyKeyPresent(value: string | undefined): asserts value is string {
  if (!value || value.trim().length === 0) {
    throw new vineErrors.E_VALIDATION_ERROR([
      {
        field: 'Idempotency-Key',
        rule: 'required',
        message: "l'en-tête Idempotency-Key est obligatoire.",
      },
    ])
  }
}
