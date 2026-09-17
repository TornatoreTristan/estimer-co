import vine from '@vinejs/vine'
import { errors as vineErrors } from '@vinejs/vine'
import { assertNoUnknownFields, imageInputValidator, slugField } from '#validators/blog_common'

/** Champs acceptés par `POST /v1/blog/articles` (§4). */
export const ARTICLE_UPSERT_FIELDS = [
  'slug',
  'categorie',
  'title',
  'metaTitle',
  'metaDescription',
  'extrait',
  'contenu',
  'image',
  'imageAlt',
  'imageCadrage',
  'auteur',
  'faq',
  'motsClesCibles',
  'articlesLies',
  'datePublication',
  'ordreAffichage',
] as const

const faqEntryValidator = vine.object({
  question: vine.string().trim().minLength(1),
  reponse: vine.string().trim().minLength(1),
})

/**
 * Forme du payload UNIQUEMENT. `categorie` est vérifiée comme une simple
 * chaîne non vide ici : sa valeur n'est comparée à l'enum réel (chargé depuis
 * `src/lib/blog.ts` de la copie de travail) que dans le contrôleur — voir
 * `readCategories` (specs §4, E2). `statut` n'est délibérément pas un champ
 * accepté : « statut n'est pas accepté sur POST /articles » (§4).
 */
export const articleUpsertValidator = vine.compile(
  vine.object({
    slug: vine
      .string()
      .trim()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    categorie: vine.string().trim().minLength(1),
    title: vine.string().trim().minLength(1).maxLength(200),
    metaTitle: vine.string().trim().maxLength(200).optional(),
    metaDescription: vine.string().trim().maxLength(200).optional(),
    extrait: vine.string().trim().maxLength(300).optional(),
    contenu: vine.string().trim().minLength(1),
    image: imageInputValidator.optional(),
    imageAlt: vine.string().trim().maxLength(300).optional(),
    imageCadrage: vine.number().min(0).max(100).optional(),
    auteur: slugField.optional(),
    faq: vine.array(faqEntryValidator).maxLength(10).optional(),
    motsClesCibles: vine.array(vine.string().trim().minLength(1)).optional(),
    articlesLies: vine.array(slugField).maxLength(4).optional(),
    datePublication: vine.string().trim().optional(),
    ordreAffichage: vine.number().optional(),
  })
)

export type ArticleUpsertPayload = Awaited<ReturnType<(typeof articleUpsertValidator)['validate']>>

/** C2 : `imageAlt` obligatoire dès qu'une image est fournie — même règle que `content.config.ts`, appliquée avant écriture. */
export function assertArticleCrossFieldRules(payload: ArticleUpsertPayload): void {
  if (payload.image && !payload.imageAlt) {
    throw new vineErrors.E_VALIDATION_ERROR([
      {
        field: 'imageAlt',
        rule: 'required_if_image',
        message: "imageAlt est obligatoire dès qu'un champ image est renseigné (accessibilité).",
      },
    ])
  }
}

export async function validateArticleUpsertPayload(body: unknown): Promise<ArticleUpsertPayload> {
  assertNoUnknownFields(body, ARTICLE_UPSERT_FIELDS)
  const payload = await articleUpsertValidator.validate(body)
  assertArticleCrossFieldRules(payload)
  return payload
}
