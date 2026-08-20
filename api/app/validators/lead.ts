import vine from '@vinejs/vine'
import { errors as vineErrors } from '@vinejs/vine'

/**
 * Validation de `POST /v1/leads` — endpoint transactionnel.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CET ENDPOINT REÇOIT DES DONNÉES PERSONNELLES. C'EST LE SEUL.
 * ══════════════════════════════════════════════════════════════════════════
 * `POST /v1/estimations` les REFUSE explicitement (422 `forbidden_pii`) et
 * cette règle ne bouge pas : le calcul n'a aucun besoin de savoir qui demande.
 * Le contact, lui, en a besoin par définition — on ne rappelle pas un
 * prospect anonyme. D'où deux endpoints séparés, avec deux contrats opposés,
 * plutôt qu'un seul endpoint qui « accepte des champs optionnels ».
 *
 * Ce que cette séparation achète concrètement :
 *  - `estimations_log` (§8.3) ne contient toujours AUCUNE donnée
 *    d'identification, puisque le calcul ne les voit jamais ;
 *  - les coordonnées ne sont écrites NULLE PART côté serveur : elles
 *    traversent le processus, partent par SMTP, et disparaissent. Aucune
 *    table, aucun fichier, aucun journal en clair (cf. `maskEmail`) ;
 *  - le jour où un formulaire front est mal câblé, l'erreur est bruyante
 *    (422) au lieu d'être silencieuse.
 *
 * Tous les messages sont en français et directement affichables par le front.
 */

/** Deux origines de lead, deux gabarits d'e-mail. */
export const LEAD_KINDS = ['estimation', 'contact'] as const
export type LeadKind = (typeof LEAD_KINDS)[number]

/** Champs acceptés à la racine du corps. */
export const LEAD_ALLOWED_FIELDS = [
  'kind',
  'name',
  'email',
  'phone',
  'subject',
  'message',
  'consent',
  'website',
  'property',
  'estimation',
] as const

/** Champs acceptés dans `property` (miroir du wizard, §7.1). */
export const LEAD_PROPERTY_FIELDS = [
  'address',
  'postalCode',
  'city',
  'propertyType',
  'surface',
  'rooms',
  'dpe',
  'dpeRequest',
  'hasTerrain',
  'terrainSize',
  'floor',
  'hasElevator',
  'outdoor',
  'condition',
  'isOwner',
  'wantToSell',
] as const

/** Champs acceptés dans `estimation` (résultat déjà calculé, cf. §5.3). */
export const LEAD_ESTIMATION_FIELDS = [
  'status',
  'prixM2',
  'estimationMin',
  'estimationMoyenne',
  'estimationMax',
  'confidenceScore',
  'comparablesCount',
] as const

export const UNKNOWN_FIELD_MESSAGE = "Ce champ n'est pas reconnu par l'API."

/** Longueur maximale du message libre : au-delà, c'est un envoi automatisé. */
export const LEAD_MESSAGE_MAX_LENGTH = 5_000

export interface FieldError {
  field: string
  rule: string
  message: string
}

/**
 * Refus explicite de tout champ non déclaré, à la racine comme dans les deux
 * objets imbriqués.
 *
 * VineJS ignore silencieusement les propriétés inconnues. Sur un endpoint qui
 * fabrique un e-mail, ce silence est le pire des comportements : un champ
 * ajouté côté front « qui ne remonte pas » se diagnostique en une minute avec
 * un 422, et en une demi-journée sans.
 *
 * **Fonction pure** : testable sans requête HTTP.
 */
export function assertNoUnknownFields(body: unknown): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new vineErrors.E_VALIDATION_ERROR([
      {
        field: 'body',
        rule: 'object',
        message: 'Le corps de la requête doit être un objet JSON.',
      },
    ])
  }

  const errors: FieldError[] = []

  const collect = (value: unknown, allowed: readonly string[], prefix: string) => {
    if (value === null || value === undefined) {
      return
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push({
        field: prefix.replace(/\.$/, ''),
        rule: 'object',
        message: 'Ce champ doit être un objet JSON.',
      })
      return
    }
    const allowedSet = new Set(allowed)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!allowedSet.has(key)) {
        errors.push({
          field: `${prefix}${key}`,
          rule: 'unknown_field',
          message: UNKNOWN_FIELD_MESSAGE,
        })
      }
    }
  }

  const record = body as Record<string, unknown>
  collect(record, LEAD_ALLOWED_FIELDS, '')
  if ('property' in record) {
    collect(record.property, LEAD_PROPERTY_FIELDS, 'property.')
  }
  if ('estimation' in record) {
    collect(record.estimation, LEAD_ESTIMATION_FIELDS, 'estimation.')
  }

  if (errors.length > 0) {
    throw new vineErrors.E_VALIDATION_ERROR(errors)
  }
}

/**
 * Un numéro de téléphone n'est pas validé sur sa forme nationale : un prospect
 * qui saisit « 06 12 34 56 78 », « +33 6 12 34 56 78 » ou « 06-12-34-56-78 »
 * doit être rappelé, pas rejeté. On borne seulement les caractères plausibles
 * et la longueur, ce qui suffit à écarter un champ rempli n'importe comment.
 */
const PHONE_REGEX = /^[+0-9 ().\-/]{6,30}$/

/**
 * Schéma de forme. `property` et `estimation` restent optionnels ici : leur
 * exigence dépend de `kind`, et cette règle est appliquée juste après par
 * `assertKindSpecificRules` — même découpage que le validateur d'estimation,
 * pour la même raison (un `vine.group` produirait un type en union qui
 * alourdirait tout le code appelant sans rien garantir de plus).
 */
export const leadValidator = vine.compile(
  vine.object({
    kind: vine.enum(LEAD_KINDS),
    name: vine.string().trim().minLength(2).maxLength(100),
    email: vine.string().trim().email().maxLength(180),
    phone: vine.string().trim().regex(PHONE_REGEX).optional(),
    subject: vine.string().trim().maxLength(120).optional(),
    message: vine.string().trim().maxLength(LEAD_MESSAGE_MAX_LENGTH).optional(),
    consent: vine.boolean().optional(),

    /*
     * Piège à robots (« honeypot ») : un champ invisible pour l'utilisateur,
     * rempli par les automates qui remplissent tout ce qu'ils trouvent. Il est
     * accepté par le schéma — c'est le contrôleur qui décide quoi en faire,
     * et sa décision est de répondre 200 sans envoyer. Refuser en 422
     * apprendrait au robot quel champ éviter au prochain passage.
     */
    website: vine.string().trim().maxLength(200).optional(),

    property: vine
      .object({
        address: vine.string().trim().minLength(3).maxLength(200),
        postalCode: vine
          .string()
          .trim()
          .regex(/^\d{5}$/),
        city: vine.string().trim().minLength(1).maxLength(100),
        propertyType: vine.enum(['appartement', 'maison', 'terrain', 'local-commercial'] as const),
        surface: vine.number().min(1).max(100_000),
        rooms: vine.number().withoutDecimals().min(1).max(30).optional(),
        dpe: vine.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'unknown'] as const),
        dpeRequest: vine.enum(['yes', 'no'] as const).optional(),
        hasTerrain: vine.enum(['yes', 'no'] as const).optional(),
        terrainSize: vine.number().min(0).max(100_000).optional(),
        floor: vine.number().withoutDecimals().min(0).max(50).optional(),
        hasElevator: vine.enum(['yes', 'no', 'unknown'] as const).optional(),
        outdoor: vine.enum(['none', 'balcony', 'terrace', 'garden'] as const).optional(),
        condition: vine.enum(['to-renovate', 'fair', 'good', 'new'] as const).optional(),
        isOwner: vine.enum(['yes', 'no'] as const).optional(),
        wantToSell: vine.enum(['yes', 'no', 'maybe'] as const).optional(),
      })
      .optional(),

    estimation: vine
      .object({
        status: vine.enum(['ok', 'static-fallback', 'deferred'] as const),
        prixM2: vine.number().min(0).max(1_000_000).optional(),
        estimationMin: vine.number().min(0).max(1_000_000_000).optional(),
        estimationMoyenne: vine.number().min(0).max(1_000_000_000).optional(),
        estimationMax: vine.number().min(0).max(1_000_000_000).optional(),
        confidenceScore: vine.number().min(0).max(100).optional(),
        comparablesCount: vine.number().withoutDecimals().min(0).max(100_000).optional(),
      })
      .optional(),
  })
)

export type LeadPayload = Awaited<ReturnType<(typeof leadValidator)['validate']>>

/**
 * Règles conditionnelles au type de lead — **fonction pure**.
 *
 *  - `estimation` : le bloc `property` est obligatoire. Un lead d'estimation
 *    sans bien décrit est ininterprétable par le commercial qui le reçoit ;
 *  - `contact` : le `message` est obligatoire. Un e-mail « quelqu'un vous a
 *    écrit, sans texte » ne sert personne.
 */
export function assertKindSpecificRules(payload: LeadPayload): void {
  const errors: FieldError[] = []

  if (payload.kind === 'estimation' && !payload.property) {
    errors.push({
      field: 'property',
      rule: 'required',
      message: 'Les caractéristiques du bien sont obligatoires pour une demande d’estimation.',
    })
  }

  if (payload.kind === 'contact' && !payload.message) {
    errors.push({
      field: 'message',
      rule: 'required',
      message: 'Le message est obligatoire.',
    })
  }

  if (errors.length > 0) {
    throw new vineErrors.E_VALIDATION_ERROR(errors)
  }
}

/**
 * Point d'entrée unique : champs inconnus, puis forme, puis règles
 * conditionnelles. L'ordre compte — un corps hors contrat est refusé avant
 * qu'on n'ait manipulé la moindre valeur.
 */
export async function validateLeadPayload(body: unknown): Promise<LeadPayload> {
  assertNoUnknownFields(body)
  const payload = await leadValidator.validate(body)
  assertKindSpecificRules(payload)
  return payload
}
