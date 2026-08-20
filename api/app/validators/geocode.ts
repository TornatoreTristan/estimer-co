import vine from '@vinejs/vine'

/**
 * Validation de `GET /v1/geocode` — spec §6.1.
 *
 * Bornes strictes : l'endpoint est public et sans authentification, la
 * validation est la première ligne de défense (§2.6, point 2).
 */
export const geocodeValidator = vine.compile(
  vine.object({
    q: vine.string().trim().minLength(3).maxLength(200),
    postcode: vine
      .string()
      .trim()
      .regex(/^\d{5}$/)
      .optional(),
    city: vine.string().trim().maxLength(100).optional(),
  })
)
