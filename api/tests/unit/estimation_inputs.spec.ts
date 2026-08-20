import { test } from '@japa/runner'
import { errors as vineErrors } from '@vinejs/vine'

import {
  ALLOWED_FIELDS,
  PII_MESSAGE,
  assertNoUnknownFields,
  assertTypeSpecificRules,
  validateEstimationPayload,
  type EstimationPayload,
} from '#validators/estimation'
import { EstimationCache, buildEstimationCacheKey } from '#services/estimation_cache'
import { hashUserAgent, hmacIp } from '#lib/anonymize'
import { buildCoefficientTable, neutralCoefficientTable } from '#services/coefficients_service'
import {
  anonymizeComparables,
  departmentFromInsee,
  departmentFromPostcode,
} from '#services/estimation_service'
import { formatQuarter } from '#services/data_version_service'
import type { AdjustedComparable } from '#services/valuation_service'

/**
 * Entrées et sorties de `POST /v1/estimations` — §6.1, §2.6, §8.3.
 * Uniquement des fonctions pures : aucune base, aucun serveur HTTP.
 */

const VALID_BODY = {
  address: '12 rue de la Paix',
  postalCode: '23000',
  city: 'Guéret',
  propertyType: 'appartement',
  surface: 65,
  rooms: 3,
  dpe: 'C',
}

async function expectValidationError(
  run: () => Promise<unknown> | unknown
): Promise<Array<{ field: string; rule: string; message: string }>> {
  try {
    await run()
  } catch (error) {
    if (error instanceof vineErrors.E_VALIDATION_ERROR) {
      return error.messages as Array<{ field: string; rule: string; message: string }>
    }
    throw error
  }
  throw new Error('Une erreur de validation était attendue')
}

/* ══════════════════════════════════════════════════════════════════════════
 * §6.1 / §2.6 — Aucune PII, aucun champ non déclaré
 * ════════════════════════════════════════════════════════════════════════ */

test.group('Validation — champs interdits (§6.1, US-8)', () => {
  test('un payload conforme passe', async ({ assert }) => {
    const payload = await validateEstimationPayload(VALID_BODY)
    assert.equal(payload.city, 'Guéret')
    assert.equal(payload.surface, 65)
  })

  for (const field of ['name', 'email', 'phone']) {
    test(`le champ « ${field} » est refusé avec un message dédié`, async ({ assert }) => {
      const errors = await expectValidationError(() =>
        assertNoUnknownFields({ ...VALID_BODY, [field]: 'valeur' })
      )

      assert.lengthOf(errors, 1)
      assert.equal(errors[0].field, field)
      assert.equal(errors[0].rule, 'forbidden_pii')
      assert.equal(errors[0].message, PII_MESSAGE)
      // Le message doit expliquer POURQUOI, sinon le front recommencera.
      assert.match(errors[0].message, /donnée personnelle/i)
    })
  }

  test('les variantes françaises de PII sont refusées elles aussi', async ({ assert }) => {
    const errors = await expectValidationError(() =>
      assertNoUnknownFields({ ...VALID_BODY, telephone: '0600000000' })
    )
    assert.equal(errors[0].rule, 'forbidden_pii')
  })

  test('tout champ non déclaré est refusé', async ({ assert }) => {
    const errors = await expectValidationError(() =>
      assertNoUnknownFields({ ...VALID_BODY, jardinSecret: true })
    )

    assert.equal(errors[0].field, 'jardinSecret')
    assert.equal(errors[0].rule, 'unknown_field')
  })

  test('plusieurs champs interdits sont tous signalés d’un coup', async ({ assert }) => {
    const errors = await expectValidationError(() =>
      assertNoUnknownFields({ ...VALID_BODY, name: 'X', email: 'x@y.z' })
    )
    assert.lengthOf(errors, 2)
  })

  test('un corps qui n’est pas un objet est refusé', async ({ assert }) => {
    const errors = await expectValidationError(() => assertNoUnknownFields('nope'))
    assert.equal(errors[0].field, 'body')
  })

  test('la liste des champs acceptés est celle du §6.1', ({ assert }) => {
    assert.deepEqual([...ALLOWED_FIELDS].sort(), [
      'address',
      'city',
      'condition',
      'dpe',
      'floor',
      'hasElevator',
      'lat',
      'lon',
      'outdoor',
      'postalCode',
      'propertyType',
      'rooms',
      'surface',
      'terrainSize',
    ])
  })
})

test.group('Validation — bornes et messages français (§6.1)', () => {
  test('un code postal mal formé est refusé en français', async ({ assert }) => {
    const errors = await expectValidationError(() =>
      validateEstimationPayload({ ...VALID_BODY, postalCode: '23' })
    )

    assert.equal(errors[0].field, 'postalCode')
    assert.match(errors[0].message, /code postal/i)
  })

  test('un type de bien inconnu est refusé', async ({ assert }) => {
    const errors = await expectValidationError(() =>
      validateEstimationPayload({ ...VALID_BODY, propertyType: 'chateau' })
    )
    assert.equal(errors[0].field, 'propertyType')
  })

  test('une classe DPE inconnue est refusée', async ({ assert }) => {
    const errors = await expectValidationError(() =>
      validateEstimationPayload({ ...VALID_BODY, dpe: 'Z' })
    )
    assert.equal(errors[0].field, 'dpe')
  })

  test('une surface de logement hors [9 ; 1 000] est refusée', async ({ assert }) => {
    const errors = await expectValidationError(() =>
      assertTypeSpecificRules({ ...VALID_BODY, surface: 4 } as EstimationPayload)
    )

    assert.equal(errors[0].field, 'surface')
    assert.match(errors[0].message, /surface habitable/i)
    assert.match(errors[0].message, /9 et 1000 m²|9 et 1 000 m²/)
  })

  test('un terrain accepte une surface bien supérieure', async ({ assert }) => {
    const payload = await validateEstimationPayload({
      ...VALID_BODY,
      propertyType: 'terrain',
      surface: 8_000,
      rooms: undefined,
    })

    assert.equal(payload.surface, 8_000)
  })

  test('le nombre de pièces est obligatoire pour un bien bâti', async ({ assert }) => {
    const errors = await expectValidationError(() =>
      validateEstimationPayload({ ...VALID_BODY, rooms: undefined })
    )

    assert.equal(errors[0].field, 'rooms')
    assert.match(errors[0].message, /pièces/i)
  })

  test('des coordonnées hors France + DOM sont refusées', async ({ assert }) => {
    const errors = await expectValidationError(() =>
      validateEstimationPayload({ ...VALID_BODY, lat: 80, lon: 2 })
    )
    assert.equal(errors[0].field, 'lat')
  })

  test('une adresse trop courte est refusée', async ({ assert }) => {
    const errors = await expectValidationError(() =>
      validateEstimationPayload({ ...VALID_BODY, address: 'a' })
    )
    assert.equal(errors[0].field, 'address')
  })

  test('les champs facultatifs restent facultatifs (conversion préservée)', async ({ assert }) => {
    // §7.1 : « ces nouveaux champs sont TOUS optionnels — ne pas dégrader une
    // conversion qui fonctionne avec 3 champs requis ».
    const payload = await validateEstimationPayload(VALID_BODY)

    assert.isUndefined(payload.floor)
    assert.isUndefined(payload.outdoor)
    assert.isUndefined(payload.condition)
    assert.isUndefined(payload.hasElevator)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §2.6 — Cache applicatif
 * ════════════════════════════════════════════════════════════════════════ */

test.group('Cache applicatif (§2.6, point 4)', () => {
  const base = {
    lat: 46.170123,
    lon: 1.870456,
    cityCode: '23096',
    propertyType: 'appartement',
    surface: 63,
    dpe: 'C',
    options: ['23000'],
    datasetVersion: 'dvf-2025-10',
  }

  test('la clé arrondit les coordonnées à 3 décimales', ({ assert }) => {
    // ~110 m : deux adresses de la même rue partagent leur résultat, ce qui
    // est exactement l'intention — leurs comparables sont les mêmes.
    assert.equal(
      buildEstimationCacheKey(base),
      buildEstimationCacheKey({ ...base, lat: 46.1704, lon: 1.8701 })
    )
  })

  test('la clé distingue la surface EXACTE, jamais une tranche', ({ assert }) => {
    /*
     * Régression corrigée : la clé regroupait les surfaces par tranche de
     * 10 m² (§2.6), alors que le §3.7 pose `V = P_ref × k_total × S` — la
     * surface MULTIPLIE le résultat. 63 et 68 m² recevaient donc la même
     * `value` et le même `pricePerSqm`, si bien que le rapport affichait
     * `value ≠ pricePerSqm × surface`. Le bucketing n'apportait par ailleurs
     * aucun gain : `options` porte déjà l'adresse exacte.
     */
    assert.notEqual(
      buildEstimationCacheKey(base),
      buildEstimationCacheKey({ ...base, surface: 68 }),
      'deux surfaces de la même tranche de 10 m² ne doivent pas partager leur clé'
    )
    assert.notEqual(
      buildEstimationCacheKey(base),
      buildEstimationCacheKey({ ...base, surface: 72 })
    )
    // Une surface identique reste bien une seule clé.
    assert.equal(buildEstimationCacheKey(base), buildEstimationCacheKey({ ...base, surface: 63 }))
  })

  test('un DPE différent produit une clé différente', ({ assert }) => {
    assert.notEqual(buildEstimationCacheKey(base), buildEstimationCacheKey({ ...base, dpe: 'G' }))
  })

  test('un nouveau millésime invalide tout le cache', ({ assert }) => {
    // Sans cela, un import frais mettrait 24 h à devenir visible et deux
    // utilisateurs verraient des prix différents selon leur heure de requête.
    assert.notEqual(
      buildEstimationCacheKey(base),
      buildEstimationCacheKey({ ...base, datasetVersion: 'dvf-2026-04' })
    )
  })

  test('le cache rend la valeur puis l’oublie à l’expiration', ({ assert }) => {
    const cache = new EstimationCache<string>(60)

    cache.set('k', 'v', 1_000)
    assert.equal(cache.get('k', 1_000), 'v')
    assert.equal(cache.get('k', 60_000), 'v')
    assert.isNull(cache.get('k', 61_001))
  })

  test('le cache est borné en taille (pas de fuite mémoire)', ({ assert }) => {
    const cache = new EstimationCache<number>(60, 3)
    for (let index = 0; index < 10; index += 1) {
      cache.set(`k${index}`, index)
    }
    assert.isAtMost(cache.size, 3)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §8.3 — Anonymisation
 * ════════════════════════════════════════════════════════════════════════ */

test.group('Anonymisation (§8.3)', () => {
  test('le HMAC d’IP est stable et ne contient pas l’IP', ({ assert }) => {
    const hash = hmacIp('203.0.113.10', 'sel')

    assert.equal(hash, hmacIp('203.0.113.10', 'sel'))
    assert.lengthOf(hash!, 64)
    assert.notInclude(hash!, '203')
  })

  test('un sel différent produit un condensat différent', ({ assert }) => {
    // C'est tout l'intérêt du sel : sans lui, les 2^32 adresses IPv4 se
    // cassent par force brute en quelques minutes.
    assert.notEqual(hmacIp('203.0.113.10', 'sel-a'), hmacIp('203.0.113.10', 'sel-b'))
  })

  test('une IP absente ne produit pas de valeur factice', ({ assert }) => {
    assert.isNull(hmacIp(null, 'sel'))
    assert.isNull(hmacIp('', 'sel'))
    assert.isNull(hashUserAgent(undefined))
  })

  test('les comparables sont anonymisés : distance à 50 m, date au mois', ({ assert }) => {
    const retained: AdjustedComparable[] = [
      {
        prixM2: 1_234,
        surface: 90,
        distanceMetres: 137,
        dateMutation: '2024-06-18',
        valeurFonciere: 111_060,
        rooms: 4,
        street: 'Rue de la Paix',
        city: 'Guéret',
        propertyType: 'maison',
        adjustedPriceM2: 1_234,
        weight: 1,
        ageMonths: 12,
      },
    ]

    const [comparable] = anonymizeComparables(retained)

    assert.equal(comparable.distanceM, 150)
    assert.equal(comparable.date, '2024-06')
    assert.equal(comparable.pricePerSqm, 1_230)
    assert.equal(comparable.price, 111_000)
    // Aucun numéro de voie : la base n'en contient pas, et rien ne doit en
    // réintroduire.
    assert.notMatch(comparable.street, /^\d/)
  })

  test('seuls les 5 comparables les plus proches sont exposés (US-2)', ({ assert }) => {
    const retained: AdjustedComparable[] = Array.from({ length: 40 }, (_, index) => ({
      prixM2: 1_000,
      surface: 80,
      distanceMetres: 1_000 - index * 10,
      dateMutation: '2024-06-18',
      adjustedPriceM2: 1_000,
      weight: 1,
      ageMonths: 12,
    }))

    const list = anonymizeComparables(retained)

    assert.lengthOf(list, 5)
    assert.equal(list[0].distanceM, 600)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * Chargement des coefficients (§3.6)
 * ════════════════════════════════════════════════════════════════════════ */

test.group('Table de coefficients (§3.6)', () => {
  test('les clés sont routées vers la bonne famille', ({ assert }) => {
    const table = buildCoefficientTable([
      { cle: 'dpe.A', type_bien: 'maison', valeur: '1.1200', updated_at: null, date_source: null },
      { cle: 'etat.good', type_bien: 'all', valeur: '1.0300', updated_at: null, date_source: null },
      {
        cle: 'etage.ground-floor',
        type_bien: 'appartement',
        valeur: '0.9500',
        updated_at: null,
        date_source: null,
      },
      {
        cle: 'exterieur.balcony',
        type_bien: 'all',
        valeur: '1.0200',
        updated_at: null,
        date_source: null,
      },
      {
        cle: 'surface.alpha',
        type_bien: 'maison',
        valeur: '0.1800',
        updated_at: null,
        date_source: null,
      },
      {
        cle: 'terrain.fallback_ratio',
        type_bien: 'all',
        valeur: '0.0800',
        updated_at: null,
        date_source: null,
      },
    ])

    assert.equal(table.dpe.maison?.A, 1.12)
    assert.equal(table.condition.good, 1.03)
    assert.equal(table.floor['ground-floor'], 0.95)
    assert.equal(table.outdoor.balcony, 1.02)
    assert.equal(table.surfaceAlpha.maison, 0.18)
    assert.equal(table.terrainFallbackRatio, 0.08)
  })

  test('une clé inconnue est ignorée sans faire échouer le chargement', ({ assert }) => {
    const table = buildCoefficientTable([
      { cle: 'lot5.futur', type_bien: 'all', valeur: '2', updated_at: null, date_source: null },
    ])
    assert.deepEqual(table, neutralCoefficientTable())
  })

  test('une table vide est entièrement neutre, jamais remplie de valeurs en dur', ({ assert }) => {
    // §3.6, règle 1 : les valeurs vivent en base avec leur source. Un secours
    // écrit dans le code masquerait une base mal provisionnée.
    const table = buildCoefficientTable([])

    assert.deepEqual(table.condition, {})
    assert.isNull(table.terrainFallbackRatio)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * Utilitaires de rattachement
 * ════════════════════════════════════════════════════════════════════════ */

test.group('Rattachement département et millésime', () => {
  test('le département se déduit du code postal, DOM compris', ({ assert }) => {
    assert.equal(departmentFromPostcode('23000'), '23')
    assert.equal(departmentFromPostcode('67000'), '67')
    assert.equal(departmentFromPostcode('97600'), '976')
    assert.isNull(departmentFromPostcode('abc'))
  })

  test('le département se déduit du code INSEE, Corse et DOM compris', ({ assert }) => {
    assert.equal(departmentFromInsee('23096'), '23')
    assert.equal(departmentFromInsee('2A004'), '2A')
    assert.equal(departmentFromInsee('97601'), '976')
    assert.isNull(departmentFromInsee(null))
  })

  test('le trimestre d’indice est formaté pour le DTO', ({ assert }) => {
    assert.equal(formatQuarter('2025-04-01'), '2025-T2')
    assert.equal(formatQuarter('2025-01-01'), '2025-T1')
    assert.equal(formatQuarter('2025-12-01'), '2025-T4')
    assert.isNull(formatQuarter(null))
  })
})
