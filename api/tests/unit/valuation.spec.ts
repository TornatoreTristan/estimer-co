import { test } from '@japa/runner'

import {
  COEFFICIENT_BOUNDS,
  K_TOTAL_MAX,
  K_TOTAL_MIN,
  MIN_SAMPLE,
  RANGE_MAX,
  RANGE_MIN,
  SAMPLE_CAP,
  cleanSample,
  clamp,
  computeCoefficients,
  computeLandValue,
  computeReferenceValuation,
  computeValuation,
  confidenceLabel,
  confidenceLabelFr,
  floorKey,
  geoWeight,
  median,
  monthsBetween,
  outdoorKey,
  proximityScore,
  quantile,
  roundValue,
  surfaceCoefficient,
  surfaceWeight,
  terrainValueAt,
  timeWeight,
  weightedQuantile,
  type CoefficientTable,
  type PropertyInput,
  type RawComparable,
  type ValuationInput,
} from '#services/valuation_service'

/**
 * Moteur de valorisation — §3.3 à §3.9.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN DE CES TESTS NE TOUCHE LA BASE NI LE RÉSEAU.
 * ══════════════════════════════════════════════════════════════════════════
 * C'est la contrepartie directe de la règle d'architecture du §6.2 : « le
 * module de valorisation est pur et testable sans base ni réseau. C'est la
 * condition pour pouvoir recalibrer, backtester (Lot 7) et faire réviser les
 * formules sans monter une infrastructure. »
 *
 * Si un jour l'un de ces tests exige un conteneur PostgreSQL, c'est que la
 * frontière A.12 a été franchie et qu'il faut corriger le code, pas le test.
 */

/* ══════════════════════════════════════════════════════════════════════════
 * Fixtures
 * ════════════════════════════════════════════════════════════════════════ */

const REFERENCE_DATE = '2026-01-15'

/** Table de coefficients conforme au §3.6 (valeurs de `reference_data.ts`). */
function coefficients(overrides: Partial<CoefficientTable> = {}): CoefficientTable {
  return {
    dpe: {
      appartement: { A: 1.06, B: 1.05, C: 1.03, D: 1.0, E: 0.96, F: 0.91, G: 0.87 },
      maison: { A: 1.12, B: 1.09, C: 1.05, D: 1.0, E: 0.94, F: 0.88, G: 0.84 },
    },
    condition: { 'to-renovate': 0.88, 'fair': 1.0, 'good': 1.03, 'new': 1.07 },
    floor: {
      'ground-floor': 0.95,
      'top-with-elevator': 1.05,
      'high-no-elevator': 0.93,
      'low-no-elevator': 0.98,
    },
    outdoor: { none: 1.0, balcony: 1.02, terrace: 1.04, garden: 1.06 },
    surfaceAlpha: { appartement: 0.12, maison: 0.18 },
    terrainFallbackRatio: 0.08,
    ...overrides,
  }
}

function property(overrides: Partial<PropertyInput> = {}): PropertyInput {
  return {
    propertyType: 'appartement',
    surface: 65,
    rooms: 3,
    dpe: 'D',
    ...overrides,
  }
}

/** Échantillon homogène : n comparables au même prix, à la même date. */
function sample(
  count: number,
  overrides: Partial<RawComparable> = {},
  priceAt: (index: number) => number = () => 3_000
): RawComparable[] {
  return Array.from({ length: count }, (_, index) => ({
    prixM2: priceAt(index),
    surface: 65,
    distanceMetres: 100 + index,
    dateMutation: '2025-06-15',
    valeurFonciere: priceAt(index) * 65,
    surfaceTerrain: 0,
    rooms: 3,
    street: 'Rue de la Paix',
    city: 'Guéret',
    propertyType: 'appartement' as const,
    timeIndexFactor: 1,
    ...overrides,
  }))
}

function input(overrides: Partial<ValuationInput> = {}): ValuationInput {
  return {
    property: property(),
    comparables: sample(20),
    coefficients: coefficients(),
    geocodePrecision: 'exact',
    level: 'radius',
    radiusM: 500,
    windowMonths: 24,
    surfaceTolerancePct: 30,
    surfaceToleranceWidened: false,
    landPricePerSqm: null,
    referenceDate: REFERENCE_DATE,
    ...overrides,
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Primitives
 * ════════════════════════════════════════════════════════════════════════ */

test.group('Primitives numériques (§3.5, §3.7)', () => {
  test('clamp borne des deux côtés et absorbe NaN', ({ assert }) => {
    assert.equal(clamp(5, 0, 10), 5)
    assert.equal(clamp(-1, 0, 10), 0)
    assert.equal(clamp(99, 0, 10), 10)
    // NaN doit produire une borne, jamais se propager dans un prix.
    assert.equal(clamp(Number.NaN, 0.7, 1.35), 0.7)
  })

  test('quantile interpole linéairement, comme percentile_cont', ({ assert }) => {
    // Q1 et Q3 doivent coïncider avec ce qu'un contrôle en SQL donnerait,
    // sinon l'écrêtage §3.3 ne serait pas reproductible côté base.
    assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
    assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75)
    assert.equal(quantile([1, 2, 3, 4], 0.75), 3.25)
  })

  test('quantile rend null sur un échantillon vide', ({ assert }) => {
    assert.isNull(quantile([], 0.5))
  })

  test('quantile rend la valeur unique sur un échantillon à un élément', ({ assert }) => {
    assert.equal(quantile([42], 0.5), 42)
  })

  test('median est robuste à une valeur extrême, la moyenne ne l’est pas', ({ assert }) => {
    const values = [1_000, 1_100, 1_200, 1_300, 50_000]
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length

    assert.equal(median(values), 1_200)
    assert.isAbove(mean, 10_000)
  })

  test('weightedQuantile suit la somme cumulée des poids (§3.5)', ({ assert }) => {
    // Le poids écrasant de 1 000 doit imposer sa valeur comme médiane.
    const entries = [
      { value: 100, weight: 1 },
      { value: 200, weight: 1_000 },
      { value: 300, weight: 1 },
    ]
    assert.equal(weightedQuantile(entries, 0.5), 200)
  })

  test('weightedQuantile retombe sur le quantile simple si tous les poids sont nuls', ({
    assert,
  }) => {
    const entries = [
      { value: 100, weight: 0 },
      { value: 300, weight: 0 },
    ]
    assert.equal(weightedQuantile(entries, 0.5), 200)
  })

  test('roundValue arrondit au millier au-dessus de 100 000 €, à la centaine sinon', ({
    assert,
  }) => {
    assert.equal(roundValue(99_949), 99_900)
    assert.equal(roundValue(123_456), 123_000)
    assert.equal(roundValue(123_654), 124_000)
  })

  test('monthsBetween est déterministe et indépendant du fuseau', ({ assert }) => {
    const first = monthsBetween('2025-01-15', '2026-01-15')
    const second = monthsBetween('2025-01-15', '2026-01-15')

    assert.equal(first, second)
    assert.closeTo(first, 12, 0.05)
  })

  test('monthsBetween absorbe une date illisible sans exploser', ({ assert }) => {
    assert.equal(monthsBetween('pas-une-date', REFERENCE_DATE), 0)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §3.3 — Nettoyage
 * ════════════════════════════════════════════════════════════════════════ */

test.group('Nettoyage et écrêtage (§3.3)', () => {
  test('les prix au m² hors [200 ; 25 000] sont écartés', ({ assert }) => {
    const result = cleanSample([
      ...sample(4),
      { ...sample(1)[0], prixM2: 50 },
      { ...sample(1)[0], prixM2: 40_000 },
    ])

    assert.equal(result.kept.length, 4)
    assert.equal(result.rejected.prix_hors_bornes, 2)
  })

  test('les surfaces hors [9 ; 1 000] sont écartées', ({ assert }) => {
    const result = cleanSample([
      ...sample(4),
      { ...sample(1)[0], surface: 4 },
      { ...sample(1)[0], surface: 2_500 },
    ])

    assert.equal(result.rejected.surface_hors_bornes, 2)
  })

  test('une valeur foncière symbolique est écartée', ({ assert }) => {
    const result = cleanSample([...sample(4), { ...sample(1)[0], valeurFonciere: 1 }])

    assert.equal(result.rejected.valeur_hors_bornes, 1)
  })

  test('l’écrêtage IQR retire une valeur extrême survivante', ({ assert }) => {
    const values = [3_000, 3_100, 3_050, 2_950, 3_020, 24_000]
    const result = cleanSample(sample(6, {}, (index) => values[index]))

    assert.equal(result.rejected.iqr, 1)
    assert.notInclude(
      result.kept.map((item) => item.prixM2),
      24_000
    )
  })

  test('l’écrêtage IQR ne s’applique pas sous 4 observations', ({ assert }) => {
    // Calculer des quartiles sur 3 valeurs reviendrait à écarter une
    // observation sur la foi d'une statistique construite sur elle-même.
    const result = cleanSample(sample(3, {}, (index) => [1_000, 1_010, 9_000][index]))

    assert.equal(result.kept.length, 3)
    assert.isUndefined(result.rejected.iqr)
  })

  test('l’échantillon est plafonné aux 150 comparables les plus proches', ({ assert }) => {
    const result = cleanSample(
      Array.from({ length: 200 }, (_, index) => ({
        ...sample(1)[0],
        distanceMetres: 200 - index,
      }))
    )

    assert.equal(result.kept.length, SAMPLE_CAP)
    assert.equal(result.rejected.plafond_echantillon, 50)
    // Les plus proches sont conservés : le plus lointain retenu vaut 50 m.
    assert.equal(Math.max(...result.kept.map((item) => item.distanceMetres ?? 0)), 150)
  })

  test('les bornes de terrain remplacent celles du bâti', ({ assert }) => {
    // Un terrain de 4 000 m² à 12 €/m² est parfaitement normal : les bornes
    // du bâti l'écarteraient deux fois (prix ET surface).
    const terrains: RawComparable[] = Array.from({ length: 6 }, () => ({
      prixM2: 12,
      surface: 4_000,
      distanceMetres: 300,
      dateMutation: '2025-03-01',
      valeurFonciere: 48_000,
    }))

    assert.equal(cleanSample(terrains).kept.length, 0)
    assert.equal(
      cleanSample(terrains, { priceMin: 1, priceMax: 25_000, surfaceMin: 1, surfaceMax: 100_000 })
        .kept.length,
      6
    )
  })

  test('un échantillon vide reste vide, sans erreur', ({ assert }) => {
    const result = cleanSample([])
    assert.deepEqual(result.kept, [])
    assert.deepEqual(result.rejected, {})
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §3.5 — Pondérations
 * ════════════════════════════════════════════════════════════════════════ */

test.group('Pondérations (§3.5)', () => {
  test('w_geo suit les repères de la spec', ({ assert }) => {
    assert.closeTo(geoWeight(0), 1, 0.001)
    assert.closeTo(geoWeight(500), 0.5, 0.001)
    assert.closeTo(geoWeight(1_000), 0.2, 0.001)
    assert.closeTo(geoWeight(2_000), 0.0588, 0.001)
  })

  test('w_geo est neutre quand la distance est inconnue', ({ assert }) => {
    // Un poids nul écarterait de fait tous les comparables des niveaux
    // administratifs, ce qui n'est pas ce que demande la spec.
    assert.equal(geoWeight(null), 1)
  })

  test('w_temps a bien une demi-vie de 24 mois', ({ assert }) => {
    assert.closeTo(timeWeight(0), 1, 0.001)
    assert.closeTo(timeWeight(24), 0.5, 0.001)
    assert.closeTo(timeWeight(48), 0.25, 0.001)
  })

  test('w_surface vaut 1 à surface égale et 0,77 à ±30 %', ({ assert }) => {
    assert.closeTo(surfaceWeight(65, 65), 1, 0.001)
    assert.closeTo(surfaceWeight(84.5, 65), 0.769, 0.005)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §3.6 — Coefficients
 * ════════════════════════════════════════════════════════════════════════ */

test.group('Coefficients d’ajustement (§3.6)', () => {
  test('k_surface est neutre quand le bien est à la médiane de l’échantillon', ({ assert }) => {
    // C'est ce qui évite le double comptage avec le filtre de surface ±30 %.
    assert.equal(surfaceCoefficient(65, 65, 0.12), 1)
  })

  test('k_surface majore un petit logement et minore un grand', ({ assert }) => {
    assert.isAbove(surfaceCoefficient(40, 65, 0.12), 1)
    assert.isBelow(surfaceCoefficient(120, 65, 0.12), 1)
  })

  test('k_surface reste dans [0,85 ; 1,15]', ({ assert }) => {
    const extreme = surfaceCoefficient(10, 900, 0.18)
    assert.equal(extreme, COEFFICIENT_BOUNDS.surface[1])
  })

  test('k_surface vaut 1 si l’exposant α est absent de la base', ({ assert }) => {
    // Coefficient non sourcé ⇒ neutre, jamais une valeur inventée.
    assert.equal(surfaceCoefficient(40, 65, undefined), 1)
  })

  test('floorKey ne s’applique qu’aux appartements', ({ assert }) => {
    assert.isNull(floorKey(property({ propertyType: 'maison', floor: 0 })))
  })

  test('floorKey — rez-de-chaussée', ({ assert }) => {
    assert.equal(floorKey(property({ floor: 0 })), 'ground-floor')
  })

  test('floorKey — étage 1-2 sans ascenseur', ({ assert }) => {
    assert.equal(floorKey(property({ floor: 2, hasElevator: false })), 'low-no-elevator')
  })

  test('floorKey — étage ≥ 3 sans ascenseur', ({ assert }) => {
    assert.equal(floorKey(property({ floor: 4, hasElevator: false })), 'high-no-elevator')
  })

  test('floorKey — dernier étage avec ascenseur', ({ assert }) => {
    assert.equal(
      floorKey(property({ floor: 6, hasElevator: true, isTopFloor: true })),
      'top-with-elevator'
    )
  })

  test('floorKey — étage inconnu ⇒ neutre', ({ assert }) => {
    assert.isNull(floorKey(property({ floor: null })))
  })

  test('k_exterieur n’est jamais appliqué à une maison', ({ assert }) => {
    // §3.6 : « pour une maison, non appliqué — déjà dans le comparable ».
    assert.isNull(outdoorKey(property({ propertyType: 'maison', outdoor: 'garden' })))
  })

  test('k_exterieur retient l’option déclarée pour un appartement', ({ assert }) => {
    assert.equal(outdoorKey(property({ outdoor: 'terrace' })), 'terrace')
    assert.isNull(outdoorKey(property({ outdoor: 'none' })))
  })

  test('k_dpe est différencié appartement / maison', ({ assert }) => {
    const flat = computeCoefficients(property({ dpe: 'G' }), 65, coefficients())
    const house = computeCoefficients(
      property({ propertyType: 'maison', dpe: 'G' }),
      65,
      coefficients()
    )

    assert.equal(flat.dpe, 0.87)
    assert.equal(house.dpe, 0.84)
  })

  test('DPE inconnu ⇒ coefficient neutre', ({ assert }) => {
    assert.equal(computeCoefficients(property({ dpe: 'unknown' }), 65, coefficients()).dpe, 1)
  })

  test('un coefficient absent de la base vaut 1,00', ({ assert }) => {
    const empty = coefficients({ condition: {}, dpe: {}, outdoor: {}, floor: {} })
    const result = computeCoefficients(
      property({ dpe: 'G', condition: 'to-renovate', outdoor: 'garden', floor: 0 }),
      65,
      empty
    )

    assert.equal(result.dpe, 1)
    assert.equal(result.condition, 1)
    assert.equal(result.outdoor, 1)
    assert.equal(result.floor, 1)
  })

  test('chaque coefficient est borné individuellement', ({ assert }) => {
    const absurd = coefficients({
      condition: { 'to-renovate': 0.1 },
      outdoor: { garden: 3 },
      floor: { 'ground-floor': 0.1 },
    })
    const result = computeCoefficients(
      property({ condition: 'to-renovate', outdoor: 'garden', floor: 0 }),
      65,
      absurd
    )

    assert.equal(result.condition, COEFFICIENT_BOUNDS.condition[0])
    assert.equal(result.outdoor, COEFFICIENT_BOUNDS.outdoor[1])
    assert.equal(result.floor, COEFFICIENT_BOUNDS.floor[0])
  })

  test('k_total est écrêté à 0,70 et le signale', ({ assert }) => {
    const punitive = coefficients({
      condition: { 'to-renovate': 0.85 },
      dpe: { appartement: { G: 0.8 } },
      floor: { 'ground-floor': 0.9 },
    })
    const result = computeCoefficients(
      property({ condition: 'to-renovate', dpe: 'G', floor: 0, surface: 900 }),
      65,
      punitive
    )

    assert.equal(result.total, K_TOTAL_MIN)
    assert.isTrue(result.clamped)
  })

  test('k_total est écrêté à 1,35 et le signale', ({ assert }) => {
    const generous = coefficients({
      condition: { new: 1.08 },
      dpe: { appartement: { A: 1.15 } },
      outdoor: { garden: 1.08 },
      floor: { 'top-with-elevator': 1.06 },
    })
    const result = computeCoefficients(
      property({
        condition: 'new',
        dpe: 'A',
        outdoor: 'garden',
        floor: 5,
        hasElevator: true,
        isTopFloor: true,
        surface: 20,
      }),
      65,
      generous
    )

    assert.equal(result.total, K_TOTAL_MAX)
    assert.isTrue(result.clamped)
  })

  test('un bien ordinaire n’est pas écrêté', ({ assert }) => {
    const result = computeCoefficients(
      property({ dpe: 'C', condition: 'good' }),
      65,
      coefficients()
    )

    assert.isFalse(result.clamped)
    assert.closeTo(result.total, 1.0609, 0.0001)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §3.6 — Terrain
 * ════════════════════════════════════════════════════════════════════════ */

test.group('Valorisation du terrain (§3.6)', () => {
  test('terrainValueAt applique la dégressivité au-delà de 5 000 m²', ({ assert }) => {
    // 6 000 m² à 10 €/m² : 5 000 pleins + 1 000 à 30 %.
    assert.equal(terrainValueAt(6_000, 10), 5_000 * 10 + 1_000 * 3)
  })

  test('un terrain dans la norme du secteur ne change rien', ({ assert }) => {
    // La valeur foncière DVF inclut déjà le terrain : seul l'écart compte.
    const value = computeLandValue({
      property: property({ propertyType: 'maison', terrainSize: 800 }),
      builtValue: 200_000,
      medianTerrainSurface: 800,
      landPricePerSqm: 30,
      referencePriceM2: 1_500,
      fallbackRatio: 0.08,
    })

    assert.equal(value, 0)
  })

  test('un terrain plus grand que la médiane ajoute de la valeur', ({ assert }) => {
    const value = computeLandValue({
      property: property({ propertyType: 'maison', terrainSize: 1_800 }),
      builtValue: 200_000,
      medianTerrainSurface: 800,
      landPricePerSqm: 30,
      referencePriceM2: 1_500,
      fallbackRatio: 0.08,
    })

    // 1 000 m² supplémentaires à 30 €, plafonnés à 25 % de 200 000 = 50 000.
    assert.equal(value, 30_000)
  })

  test('un terrain plus petit que la médiane retire de la valeur', ({ assert }) => {
    const value = computeLandValue({
      property: property({ propertyType: 'maison', terrainSize: 300 }),
      builtValue: 200_000,
      medianTerrainSurface: 800,
      landPricePerSqm: 30,
      referencePriceM2: 1_500,
      fallbackRatio: 0.08,
    })

    assert.equal(value, -15_000)
  })

  test('V_terrain est plafonné à ±25 % de la valeur bâtie', ({ assert }) => {
    const value = computeLandValue({
      property: property({ propertyType: 'maison', terrainSize: 4_000 }),
      builtValue: 200_000,
      medianTerrainSurface: 500,
      landPricePerSqm: 100,
      referencePriceM2: 1_500,
      fallbackRatio: 0.08,
    })

    assert.equal(value, 50_000)
  })

  test('sans mutation de terrain, on applique le ratio de repli sourcé', ({ assert }) => {
    const value = computeLandValue({
      property: property({ propertyType: 'maison', terrainSize: 1_000 }),
      builtValue: 500_000,
      medianTerrainSurface: 0,
      landPricePerSqm: null,
      referencePriceM2: 1_500,
      fallbackRatio: 0.08,
    })

    // 1 000 m² × (8 % de 1 500 €) = 120 000, sous le plafond de 125 000.
    assert.equal(value, 120_000)
  })

  test('sans ratio de repli en base, V_terrain vaut 0 plutôt qu’une valeur inventée', ({
    assert,
  }) => {
    const value = computeLandValue({
      property: property({ propertyType: 'maison', terrainSize: 1_000 }),
      builtValue: 200_000,
      medianTerrainSurface: 0,
      landPricePerSqm: null,
      referencePriceM2: 1_500,
      fallbackRatio: null,
    })

    assert.equal(value, 0)
  })

  test('un appartement n’a jamais de valeur de terrain', ({ assert }) => {
    const value = computeLandValue({
      property: property({ terrainSize: 5_000 }),
      builtValue: 200_000,
      medianTerrainSurface: 0,
      landPricePerSqm: 50,
      referencePriceM2: 1_500,
      fallbackRatio: 0.08,
    })

    assert.equal(value, 0)
  })

  test('hasTerrain absent ⇒ V_terrain = 0', ({ assert }) => {
    const value = computeLandValue({
      property: property({ propertyType: 'maison', terrainSize: null }),
      builtValue: 200_000,
      medianTerrainSurface: 800,
      landPricePerSqm: 30,
      referencePriceM2: 1_500,
      fallbackRatio: 0.08,
    })

    assert.equal(value, 0)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §3.8 — Confiance
 * ════════════════════════════════════════════════════════════════════════ */

test.group('Indice de confiance (§3.8)', () => {
  test('C_geo décroît avec le rayon', ({ assert }) => {
    assert.closeTo(proximityScore('radius', 500), 22.5, 0.01)
    assert.closeTo(proximityScore('radius', 2_000), 15, 0.01)
    assert.equal(proximityScore('radius', 5_000), 0)
  })

  test('C_geo — pénalité propre à chaque niveau administratif', ({ assert }) => {
    assert.equal(proximityScore('commune', null), 12)
    assert.equal(proximityScore('epci', null), 7)
    assert.equal(proximityScore('departement', null), 3)
    assert.equal(proximityScore('region', null), 0)
    assert.equal(proximityScore('national', null), 0)
  })

  test('les libellés de confiance suivent les seuils du §3.8', ({ assert }) => {
    assert.equal(confidenceLabel(82), 'high')
    assert.equal(confidenceLabel(75), 'high')
    assert.equal(confidenceLabel(74), 'medium')
    assert.equal(confidenceLabel(50), 'medium')
    assert.equal(confidenceLabel(41), 'low')
    assert.equal(confidenceLabel(30), 'low')
    assert.equal(confidenceLabel(29), 'insufficient')
  })

  test('les libellés français sont prêts à afficher', ({ assert }) => {
    assert.equal(confidenceLabelFr('high'), 'Confiance élevée')
    assert.equal(confidenceLabelFr('insufficient'), 'Données insuffisantes')
  })

  test('un géocodage approché coûte 5 points, un centroïde communal 12', ({ assert }) => {
    const exact = computeValuation(input())
    const approximate = computeValuation(input({ geocodePrecision: 'approximate' }))
    const centroid = computeValuation(input({ geocodePrecision: 'city-centroid' }))

    assert.equal(exact.confidence.breakdown.penalties, 0)
    assert.equal(approximate.confidence.breakdown.penalties, 5)
    assert.equal(centroid.confidence.breakdown.penalties, 12)
    assert.equal(exact.confidence.score - centroid.confidence.score, 12)
  })

  test('un DPE inconnu coûte 5 points', ({ assert }) => {
    const known = computeValuation(input())
    const unknown = computeValuation(input({ property: property({ dpe: 'unknown' }) }))

    assert.equal(unknown.confidence.breakdown.penalties, 5)
    assert.isBelow(unknown.confidence.score, known.confidence.score)
  })

  test('une tolérance de surface élargie coûte 5 points', ({ assert }) => {
    const widened = computeValuation(
      input({ surfaceTolerancePct: 40, surfaceToleranceWidened: true })
    )
    assert.equal(widened.confidence.breakdown.penalties, 5)
  })

  test('un k_total écrêté coûte 10 points', ({ assert }) => {
    const punitive = coefficients({ dpe: { appartement: { G: 0.8 } }, surfaceAlpha: {} })
    const result = computeValuation(
      input({
        property: property({ dpe: 'G', condition: 'to-renovate', floor: 5, hasElevator: false }),
        coefficients: punitive,
      })
    )

    assert.isTrue(result.method.coefficients.clamped)
    assert.isAtLeast(result.confidence.breakdown.penalties, 10)
  })

  test('la confiance reste bornée à [0 ; 100]', ({ assert }) => {
    const result = computeValuation(
      input({
        comparables: sample(3, { distanceMetres: 4_900 }, (index) => 1_000 + index * 900),
        level: 'national',
        radiusM: null,
        geocodePrecision: 'city-centroid',
        property: property({ dpe: 'unknown' }),
        surfaceToleranceWidened: true,
      })
    )

    assert.isAtLeast(result.confidence.score, 0)
    assert.isAtMost(result.confidence.score, 100)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §3.5 à §3.7 — Le calcul complet
 * ════════════════════════════════════════════════════════════════════════ */

test.group('computeValuation — valeur centrale et fourchette (§3.5 à §3.7)', () => {
  test('le prix de référence est la médiane pondérée, pas la moyenne (US-1)', ({ assert }) => {
    const prices = [2_000, 2_050, 2_100, 2_150, 9_000]
    const result = computeValuation(
      input({ comparables: sample(5, { distanceMetres: 100 }, (index) => prices[index]) })
    )

    const mean = prices.reduce((sum, value) => sum + value, 0) / prices.length
    assert.closeTo(mean, 3_460, 1)

    // Double protection : la valeur extrême est d'abord écartée par l'IQR…
    assert.equal(result.method.comparablesRejected.iqr, 1)
    // …et même si elle avait survécu, la médiane pondérée n'aurait pas bougé.
    assert.equal(result.method.medianPriceM2Raw, 2_050)
    assert.notEqual(result.method.medianPriceM2Raw, Math.round(mean))
  })

  test('une valeur extrême qui survit à l’IQR ne déplace pas la médiane', ({ assert }) => {
    // Échantillon volontairement large : l'IQR ne rejette rien, et pourtant
    // la médiane reste ancrée sur le cœur de la distribution — c'est
    // exactement la propriété que le §3.5 recherche.
    const prices = [1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 9_500]
    const result = computeValuation(
      input({ comparables: sample(7, { distanceMetres: 100 }, (index) => prices[index]) })
    )

    const mean = prices.reduce((sum, value) => sum + value, 0) / prices.length

    assert.isUndefined(result.method.comparablesRejected.iqr)
    assert.equal(result.method.comparablesCount, 7)
    assert.equal(result.method.medianPriceM2Raw, 4_000)
    // La moyenne, elle, est tirée vers le haut de près de 9 %.
    assert.closeTo(mean, 4_357, 1)
  })

  test('la valeur centrale suit P_ref × k_total × S', ({ assert }) => {
    const result = computeValuation(
      input({ property: property({ dpe: 'D', surface: 65 }), comparables: sample(20) })
    )

    // Échantillon homogène à 3 000 €/m², bien à la médiane, DPE D : k = 1.
    assert.equal(result.method.medianPriceM2Raw, 3_000)
    assert.equal(result.method.coefficients.total, 1)
    assert.equal(result.value, 195_000)
    assert.equal(result.pricePerSqm, 3_000)
  })

  test('la fourchette dérive de l’IQR, pas d’un ±10 % fixe (US-4)', ({ assert }) => {
    const prices = [2_400, 2_600, 2_800, 3_000, 3_200, 3_400, 3_600, 3_800]
    const result = computeValuation(
      input({
        comparables: sample(40, { distanceMetres: 100 }, (index) => prices[index % prices.length]),
      })
    )

    assert.equal(result.range.basis, 'iqr')
    assert.notEqual(result.range.halfWidthPct, 0.1)
    assert.isAbove(result.range.halfWidthPct, RANGE_MIN)
  })

  test('la demi-amplitude est plancherée à 4 % sur un marché parfaitement homogène', ({
    assert,
  }) => {
    const result = computeValuation(input({ comparables: sample(60) }))

    assert.equal(result.range.halfWidthPct, RANGE_MIN)
    assert.equal(result.range.low, roundValue(result.value! * 0.96))
  })

  test('la demi-amplitude est plafonnée à 25 % sur un marché très dispersé', ({ assert }) => {
    const prices = [800, 1_200, 2_000, 3_000, 4_200, 5_000, 6_000]
    const result = computeValuation(
      input({ comparables: sample(7, { distanceMetres: 300 }, (index) => prices[index]) })
    )

    assert.equal(result.range.halfWidthPct, RANGE_MAX)
  })

  test('la demi-amplitude reste toujours dans [0,04 ; 0,25] (US-4)', ({ assert }) => {
    for (const spread of [0, 50, 200, 800, 2_000]) {
      const result = computeValuation(
        input({
          comparables: sample(12, { distanceMetres: 200 }, (index) => 3_000 + index * spread),
        })
      )
      assert.isAtLeast(result.range.halfWidthPct, RANGE_MIN)
      assert.isAtMost(result.range.halfWidthPct, RANGE_MAX)
    }
  })

  test('un échantillon faible élargit la fourchette (pénalité f(N))', ({ assert }) => {
    const prices = (index: number) => 2_600 + (index % 5) * 200

    const small = computeValuation(
      input({ comparables: sample(6, { distanceMetres: 200 }, prices) })
    )
    const large = computeValuation(
      input({ comparables: sample(60, { distanceMetres: 200 }, prices) })
    )

    assert.isAtLeast(small.range.halfWidthPct, large.range.halfWidthPct)
  })

  test('les comparables anciens pèsent moins que les récents', ({ assert }) => {
    const recentCheap = [
      ...sample(10, { dateMutation: '2025-12-01', distanceMetres: 100 }, () => 2_000),
      ...sample(10, { dateMutation: '2019-01-01', distanceMetres: 100 }, () => 6_000),
    ]

    const result = computeValuation(input({ comparables: recentCheap }))

    // La demi-vie de 24 mois écrase les ventes de 2019 : la médiane pondérée
    // bascule du côté récent.
    assert.equal(result.method.medianPriceM2Raw, 2_000)
  })

  test('les comparables lointains pèsent moins que les proches', ({ assert }) => {
    const mixed = [
      ...sample(10, { distanceMetres: 50 }, () => 2_000),
      ...sample(10, { distanceMetres: 4_500 }, () => 6_000),
    ]

    assert.equal(computeValuation(input({ comparables: mixed })).method.medianPriceM2Raw, 2_000)
  })

  test('le facteur d’ajustement temporel est exposé (§3.4)', ({ assert }) => {
    const result = computeValuation(input({ comparables: sample(20, { timeIndexFactor: 1.08 }) }))

    assert.equal(result.method.timeAdjustmentFactor, 1.08)
    // 3 000 × 1,08 = 3 240 €/m².
    assert.equal(result.method.medianPriceM2Raw, 3_240)
  })

  test('le détail des rejets est retourné pour audit (§3.3)', ({ assert }) => {
    const result = computeValuation(
      input({ comparables: [...sample(10), { ...sample(1)[0], prixM2: 30 }] })
    )

    assert.equal(result.method.comparablesRejected.prix_hors_bornes, 1)
    assert.equal(result.method.comparablesCount, 10)
  })

  test('la valeur du terrain est ajoutée à la valeur bâtie, jamais substituée', ({ assert }) => {
    const houses = sample(20, {
      propertyType: 'maison',
      surfaceTerrain: 500,
      distanceMetres: 200,
    })

    const withoutLand = computeValuation(
      input({
        property: property({ propertyType: 'maison', terrainSize: 500 }),
        comparables: houses,
      })
    )
    const withLand = computeValuation(
      input({
        property: property({ propertyType: 'maison', terrainSize: 2_500 }),
        comparables: houses,
        landPricePerSqm: 20,
      })
    )

    assert.equal(withoutLand.method.landValue, 0)
    assert.isAbove(withLand.method.landValue, 0)
    assert.isAbove(withLand.value!, withoutLand.value!)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * Cas limites
 * ════════════════════════════════════════════════════════════════════════ */

test.group('computeValuation — cas limites', () => {
  test('un échantillon vide ne produit AUCUN prix', ({ assert }) => {
    const result = computeValuation(input({ comparables: [] }))

    assert.isTrue(result.insufficientSample)
    assert.isNull(result.value)
    assert.isNull(result.pricePerSqm)
    assert.equal(result.confidence.score, 0)
  })

  test('un échantillon entièrement écarté ne produit AUCUN prix', ({ assert }) => {
    const result = computeValuation(input({ comparables: sample(6, {}, () => 40_000) }))

    assert.isTrue(result.insufficientSample)
    assert.isNull(result.value)
    assert.equal(result.method.comparablesRejected.prix_hors_bornes, 6)
  })

  test('un échantillon à un seul élément reste calculable', ({ assert }) => {
    const result = computeValuation(input({ comparables: sample(1) }))

    assert.equal(result.method.comparablesCount, 1)
    assert.equal(result.value, 195_000)
    // Dispersion nulle sur un point unique ⇒ plancher d'amplitude.
    assert.equal(result.range.halfWidthPct, RANGE_MIN)

    /*
     * La composante « nombre de comparables » s'effondre (≈ 8 points sur 40),
     * ce qui empêche toute confiance élevée.
     *
     * Elle ne suffit pas, en revanche, à faire tomber le score sous 50 : sur
     * un échantillon d'un seul élément, `C_disp` est maximal **par
     * construction** (une valeur unique n'a pas de dispersion). C'est une
     * limite connue des formules du §3.8, consignée ici plutôt que masquée —
     * à corriger au Lot 7, où les seuils sont recalibrés.
     */
    assert.isBelow(result.confidence.breakdown.count, 10)
    assert.isBelow(result.confidence.score, 75)
    assert.notEqual(result.confidence.label, 'high')
    assert.equal(result.confidence.breakdown.dispersion, 20)
  })

  test('MIN_SAMPLE vaut 5 — la valeur qui gouverne le rejet de niveau', ({ assert }) => {
    assert.equal(MIN_SAMPLE, 5)
  })

  test('deux appels identiques donnent un résultat identique (pureté)', ({ assert }) => {
    const payload = input()
    assert.deepEqual(computeValuation(payload), computeValuation(payload))
  })

  test('le résultat ne dépend pas de l’horloge du processus', ({ assert }) => {
    // La date de référence est injectée : deux dates différentes doivent
    // produire des âges différents, et rien d'autre ne doit varier.
    const january = computeValuation(input({ referenceDate: '2026-01-15' }))
    const july = computeValuation(input({ referenceDate: '2026-07-15' }))

    assert.isAbove(july.method.medianAgeMonths, january.method.medianAgeMonths)
    assert.equal(january.value, july.value)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * Affichage — décision client
 * ════════════════════════════════════════════════════════════════════════ */

test.group('Affichage et avertissements', () => {
  test('DÉCISION CLIENT : le prix est TOUJOURS affiché, même à très faible confiance', ({
    assert,
  }) => {
    /*
     * Le §3.8 prévoyait `display.showCentralValue = false` sous 30 points.
     * Le client a tranché en sens inverse : le champ reste au contrat mais
     * vaut toujours `true`. Ce test est le garde-fou de cette décision — s'il
     * casse, c'est que quelqu'un a réappliqué la règle d'origine.
     */
    const fragile = computeValuation(
      input({
        comparables: sample(3, { distanceMetres: 4_900 }, (index) => 900 + index * 1_500),
        level: 'national',
        radiusM: null,
        geocodePrecision: 'city-centroid',
        property: property({ dpe: 'unknown' }),
      })
    )

    assert.isBelow(fragile.confidence.score, 30)
    assert.equal(fragile.confidence.label, 'insufficient')
    assert.isTrue(fragile.display.showCentralValue)
    assert.isNotNull(fragile.value)
  })

  test('une confiance très faible s’accompagne d’un avertissement explicite', ({ assert }) => {
    const fragile = computeValuation(
      input({
        comparables: sample(3, { distanceMetres: 4_900 }, (index) => 900 + index * 1_500),
        level: 'national',
        radiusM: null,
        geocodePrecision: 'city-centroid',
        property: property({ dpe: 'unknown' }),
      })
    )

    // Puisque le prix n'est plus masqué, ce sont les avertissements qui
    // portent seuls le signal de fragilité : ils ne peuvent pas être vides.
    assert.isAbove(fragile.display.warnings.length, 0)
    assert.isTrue(fragile.display.warnings.some((message) => /fourchette/i.test(message)))
  })

  test('un niveau national est annoncé comme tel', ({ assert }) => {
    const result = computeValuation(input({ level: 'national', radiusM: null }))
    assert.isTrue(result.display.warnings.some((message) => /national/i.test(message)))
  })

  test('un niveau au rayon ne déclenche aucun avertissement de niveau', ({ assert }) => {
    const result = computeValuation(input({ comparables: sample(30) }))
    assert.isFalse(
      result.display.warnings.some((message) => /commune|national|région/i.test(message))
    )
  })

  test('un DPE inconnu est signalé à l’utilisateur', ({ assert }) => {
    const result = computeValuation(input({ property: property({ dpe: 'unknown' }) }))
    assert.isTrue(result.display.warnings.some((message) => /DPE/i.test(message)))
  })

  test('un k_total écrêté est signalé à l’utilisateur', ({ assert }) => {
    const punitive = coefficients({ dpe: { appartement: { G: 0.8 } }, surfaceAlpha: {} })
    const result = computeValuation(
      input({
        property: property({ dpe: 'G', condition: 'to-renovate', floor: 5, hasElevator: false }),
        coefficients: punitive,
      })
    )

    assert.isTrue(result.display.warnings.some((message) => /plafonné/i.test(message)))
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §3.9 — Repli hors DVF
 * ════════════════════════════════════════════════════════════════════════ */

test.group('Repli départemental hors DVF (§3.9, US-6)', () => {
  test('la confiance est plafonnée à 35', ({ assert }) => {
    const result = computeReferenceValuation({
      property: property({ dpe: 'D' }),
      referencePriceM2: 2_980,
      coefficients: coefficients(),
      geocodePrecision: 'exact',
    })

    assert.isAtMost(result.confidence.score, 35)
    assert.equal(result.confidence.score, 35)
    assert.equal(result.confidence.label, 'low')
  })

  test('l’amplitude est fixe à ±20 %, faute de dispersion observée', ({ assert }) => {
    const result = computeReferenceValuation({
      property: property(),
      referencePriceM2: 2_980,
      coefficients: coefficients(),
      geocodePrecision: 'exact',
    })

    assert.equal(result.range.halfWidthPct, 0.2)
    assert.equal(result.range.basis, 'fixed')
    assert.equal(result.range.low, roundValue(result.value! * 0.8))
    assert.equal(result.range.high, roundValue(result.value! * 1.2))
  })

  test('aucun comparable n’est retourné', ({ assert }) => {
    const result = computeReferenceValuation({
      property: property(),
      referencePriceM2: 2_980,
      coefficients: coefficients(),
      geocodePrecision: 'exact',
    })

    assert.deepEqual(result.retained, [])
    assert.equal(result.method.comparablesCount, 0)
    assert.equal(result.method.level, 'departement-reference')
  })

  test('la mention Livre foncier est présente et prête à afficher', ({ assert }) => {
    const result = computeReferenceValuation({
      property: property(),
      referencePriceM2: 2_980,
      coefficients: coefficients(),
      geocodePrecision: 'exact',
    })

    assert.isTrue(result.display.warnings.some((message) => /Livre foncier/.test(message)))
    assert.isTrue(result.display.warnings.some((message) => /Bas-Rhin/.test(message)))
  })

  test('k_surface reste neutre : aucun échantillon, donc aucune dégressivité inventée', ({
    assert,
  }) => {
    const result = computeReferenceValuation({
      property: property({ surface: 200 }),
      referencePriceM2: 2_980,
      coefficients: coefficients(),
      geocodePrecision: 'exact',
    })

    assert.equal(result.method.coefficients.surface, 1)
  })

  test('les coefficients du bien s’appliquent tout de même', ({ assert }) => {
    const good = computeReferenceValuation({
      property: property({ dpe: 'A' }),
      referencePriceM2: 2_980,
      coefficients: coefficients(),
      geocodePrecision: 'exact',
    })
    const bad = computeReferenceValuation({
      property: property({ dpe: 'G' }),
      referencePriceM2: 2_980,
      coefficients: coefficients(),
      geocodePrecision: 'exact',
    })

    assert.isAbove(good.value!, bad.value!)
  })

  test('les malus ne font PAS descendre le score sous le plafond (§3.8)', ({ assert }) => {
    /*
     * §3.8, tableau des malus : « Département sans DVF (§3.9) → plafonnement
     * à 35 (**et non un malus**) », et §3.9 : « confidence plafonnée à 35 →
     * l'UI bascule **automatiquement** en mode “confiance faible” ».
     *
     * L'implémentation calculait `35 − malus`. Strasbourg + DPE inconnu +
     * géocodage au centroïde donnait donc 18, c'est-à-dire « Données
     * insuffisantes » (0-29) : le repli départemental — qui est un
     * fonctionnement nominal, documenté, avec un prix sourcé — était présenté
     * comme une panne de données, et l'encart « confiance faible + CTA
     * expert » prévu par §3.9 ne s'affichait jamais.
     */
    const result = computeReferenceValuation({
      property: property({ dpe: 'unknown' }),
      referencePriceM2: 2_980,
      coefficients: coefficients(),
      geocodePrecision: 'city-centroid',
    })

    assert.equal(result.confidence.score, 35)
    assert.equal(result.confidence.label, 'low')
    assert.equal(result.display.confidenceLabelFr, 'Confiance faible')

    // Les malus restent publiés : le plafond ne les efface pas du rapport.
    assert.equal(result.confidence.breakdown.penalties, 17)
  })

  test('le prix reste affiché malgré la faible confiance (décision client)', ({ assert }) => {
    const result = computeReferenceValuation({
      property: property({ dpe: 'unknown' }),
      referencePriceM2: 2_980,
      coefficients: coefficients(),
      geocodePrecision: 'city-centroid',
    })

    assert.isTrue(result.display.showCentralValue)
    assert.isNotNull(result.value)
  })
})
