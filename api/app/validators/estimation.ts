import vine from '@vinejs/vine'
import { errors as vineErrors } from '@vinejs/vine'

/**
 * Validation de `POST /v1/estimations` — spec §6.1 et §2.6.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUNE DONNÉE PERSONNELLE N'EST ACCEPTÉE — ET LE REFUS EST EXPLICITE.
 * ══════════════════════════════════════════════════════════════════════════
 * §6.1 : « Champs interdits : `name`, `email`, `phone`, ou tout champ non
 * déclaré → 422 (mode strict, pas de passthrough) ».
 *
 * VineJS **ignore silencieusement** les propriétés non déclarées : c'est un
 * comportement raisonnable en général, mais inacceptable ici. Ignorer un
 * `email` reviendrait à laisser un front mal câblé nous envoyer des données
 * personnelles pendant des mois sans que personne ne le voie ; le refus
 * bruyant est justement ce qui garantit que la minimisation RGPD (§2.6,
 * point 1) reste vraie dans le temps. D'où le contrôle explicite ci-dessous,
 * exécuté **avant** la validation de forme.
 *
 * Tous les messages sont en français et directement affichables par le front
 * (§6.1), qui les reporte champ par champ sous l'input concerné.
 */

/** Seuls champs acceptés par l'endpoint (§6.1). */
export const ALLOWED_FIELDS = [
  'address',
  'postalCode',
  'city',
  'propertyType',
  'surface',
  'rooms',
  'dpe',
  'floor',
  'hasElevator',
  'outdoor',
  'condition',
  'terrainSize',
  'lat',
  'lon',
] as const

/**
 * Champs porteurs de données personnelles, refusés avec un message dédié.
 * La liste couvre les variantes françaises et anglaises : un développeur
 * front qui se trompe doit lire une explication, pas un « champ inconnu ».
 */
const PII_FIELDS = new Set([
  'name',
  'email',
  'phone',
  'firstname',
  'lastname',
  'fullname',
  'nom',
  'prenom',
  'telephone',
  'tel',
  'mail',
  'e-mail',
  'contact',
])

export const PII_MESSAGE =
  'Ce champ n’est pas accepté : l’API d’estimation ne reçoit aucune donnée personnelle ' +
  '(nom, e-mail, téléphone). Ces informations restent côté site.'

export const UNKNOWN_FIELD_MESSAGE = 'Ce champ n’est pas reconnu par l’API d’estimation.'

export interface FieldError {
  field: string
  rule: string
  message: string
}

/**
 * Lève une `E_VALIDATION_ERROR` si le corps contient un champ non déclaré.
 *
 * **Fonction pure** : testable sans requête HTTP, ce qui permet de figer la
 * liste des champs interdits dans un test unitaire et de détecter toute
 * régression du contrat.
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

  const allowed = new Set<string>(ALLOWED_FIELDS)
  const errors: FieldError[] = []

  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (allowed.has(key)) {
      continue
    }
    const isPii = PII_FIELDS.has(key.toLowerCase())
    errors.push({
      field: key,
      rule: isPii ? 'forbidden_pii' : 'unknown_field',
      message: isPii ? PII_MESSAGE : UNKNOWN_FIELD_MESSAGE,
    })
  }

  if (errors.length > 0) {
    throw new vineErrors.E_VALIDATION_ERROR(errors)
  }
}

/**
 * Schéma de forme.
 *
 * Les bornes numériques sont volontairement **larges** ici : les bornes
 * réelles dépendent du type de bien (§6.1 : `min(9)`/`max(1000)`, ou
 * `min(1)`/`max(100000)` si terrain) et sont appliquées juste après, avec un
 * message qui nomme le type. Un schéma unique évite d'avoir à choisir le bon
 * validateur avant même de savoir si `propertyType` est valide.
 */
export const estimationValidator = vine.compile(
  vine.object({
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
    floor: vine.number().withoutDecimals().min(0).max(50).optional(),
    hasElevator: vine.boolean().optional(),
    outdoor: vine.enum(['none', 'balcony', 'terrace', 'garden'] as const).optional(),
    condition: vine.enum(['to-renovate', 'fair', 'good', 'new'] as const).optional(),
    terrainSize: vine.number().min(0).max(100_000).optional(),
    /*
     * Bornes France + DOM (§6.1). Elles couvrent la Guadeloupe (-61,5°),
     * la Guyane (-52°), La Réunion (55,5° / -21°) et Mayotte (45° / -13°).
     */
    lat: vine.number().min(-22).max(52).optional(),
    lon: vine.number().min(-63).max(56).optional(),
  })
)

export type EstimationPayload = Awaited<ReturnType<(typeof estimationValidator)['validate']>>

/** Bornes de surface par type de bien — §6.1. */
export const SURFACE_RULES = {
  built: { min: 9, max: 1_000 },
  land: { min: 1, max: 100_000 },
} as const

/**
 * Règles conditionnelles au type de bien — §6.1 :
 *  - `surface` : 9 à 1 000 m² pour un bâti, 1 à 100 000 m² pour un terrain ;
 *  - `rooms` : requis si le bien est bâti.
 *
 * **Fonction pure**, séparée du schéma pour rester lisible et testable :
 * exprimer ces deux règles dans un `vine.group` produirait un type de sortie
 * en union, alourdissant tout le code appelant pour un gain nul.
 */
export function assertTypeSpecificRules(payload: EstimationPayload): void {
  const errors: FieldError[] = []
  const isLand = payload.propertyType === 'terrain'
  const bounds = isLand ? SURFACE_RULES.land : SURFACE_RULES.built

  if (payload.surface < bounds.min || payload.surface > bounds.max) {
    errors.push({
      field: 'surface',
      rule: 'range',
      message: isLand
        ? `La surface du terrain doit être comprise entre ${bounds.min} et ${bounds.max} m².`
        : `La surface habitable doit être comprise entre ${bounds.min} et ${bounds.max} m².`,
    })
  }

  if (!isLand && (payload.rooms === undefined || payload.rooms === null)) {
    errors.push({
      field: 'rooms',
      rule: 'required',
      message: 'Le nombre de pièces est obligatoire pour un bien bâti.',
    })
  }

  if (errors.length > 0) {
    throw new vineErrors.E_VALIDATION_ERROR(errors)
  }
}

/**
 * Point d'entrée unique : contrôle de champs, forme, puis règles
 * conditionnelles. L'ordre compte — on refuse un `email` avant même de
 * regarder le reste, pour ne jamais avoir manipulé la valeur.
 */
export async function validateEstimationPayload(body: unknown): Promise<EstimationPayload> {
  assertNoUnknownFields(body)
  const payload = await estimationValidator.validate(body)
  assertTypeSpecificRules(payload)
  return payload
}
