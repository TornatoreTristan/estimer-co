import vine from '@vinejs/vine'
import { errors as vineErrors } from '@vinejs/vine'
import {
  assertNoUnknownFields,
  imageInputValidator,
  slugField,
  type FieldError,
} from '#validators/blog_common'

/** Champs acceptés par `POST /v1/blog/auteurs` (§4, D2). */
export const AUTEUR_CREATE_FIELDS = ['id', 'nom', 'fonction', 'bio', 'photo', 'liens'] as const

const lienValidator = vine.object({
  type: vine.enum(['linkedin', 'x', 'site', 'email'] as const),
  url: vine.string().trim().minLength(1).maxLength(300),
  texte: vine.string().trim().minLength(1).maxLength(60),
  libelle: vine.string().trim().minLength(1).maxLength(150),
})

/**
 * Schémas d'URL autorisés (revue QA, majeur 2) : `liens[].url` est rendu tel
 * quel en `href` par `src/components/blog/AuteurEncart.astro`
 * (`<a href={lien.url}>`) — sans cette garde, un auteur créé par l'agent IA
 * pourrait porter un lien `javascript:` ou toute autre pseudo-URL exécutée
 * par le navigateur au clic.
 *
 * `linkedin`/`x`/`site` : `http://` ou `https://` (spec : « éventuellement
 * http:// »). `email` : `mailto:` exclusivement, jamais une adresse nue —
 * cohérent avec le rendu (`href={lien.url}` directement, pas de préfixe
 * ajouté côté site).
 */
const HTTP_URL_PATTERN = /^https?:\/\/.+/i
const MAILTO_PATTERN = /^mailto:.+/i

export function assertLienUrlSchemes(liens: readonly { type: string; url: string }[]): void {
  const errors: FieldError[] = []

  liens.forEach((lien, index) => {
    const pattern = lien.type === 'email' ? MAILTO_PATTERN : HTTP_URL_PATTERN
    if (!pattern.test(lien.url)) {
      errors.push({
        field: `liens.${index}.url`,
        rule: 'url_scheme',
        message:
          lien.type === 'email'
            ? 'L’URL d’un lien de type "email" doit commencer par "mailto:".'
            : 'L’URL doit commencer par "http://" ou "https://".',
      })
    }
  })

  if (errors.length > 0) {
    throw new vineErrors.E_VALIDATION_ERROR(errors)
  }
}

/**
 * Forme du payload uniquement. `bio` porte la seule contrainte de longueur
 * explicitement demandée par les critères d'acceptation (D2 : « bio ≥ 50
 * caractères ») — le reste de la fiche (`initiales`) est dérivé côté service,
 * jamais fourni par l'appelant (voir `deriveInitiales`).
 */
export const auteurCreateValidator = vine.compile(
  vine.object({
    id: slugField.optional(),
    nom: vine.string().trim().minLength(1).maxLength(150),
    fonction: vine.string().trim().minLength(1).maxLength(150),
    bio: vine.string().trim().minLength(50).maxLength(2000),
    photo: imageInputValidator.optional(),
    liens: vine.array(lienValidator).maxLength(6).optional(),
  })
)

export type AuteurCreatePayload = Awaited<ReturnType<(typeof auteurCreateValidator)['validate']>>

export async function validateAuteurCreatePayload(body: unknown): Promise<AuteurCreatePayload> {
  assertNoUnknownFields(body, AUTEUR_CREATE_FIELDS)
  const payload = await auteurCreateValidator.validate(body)
  if (payload.liens) {
    assertLienUrlSchemes(payload.liens)
  }
  return payload
}
