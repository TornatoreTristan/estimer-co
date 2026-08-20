import { test } from '@japa/runner'

import {
  COMPARABLES_HARD_LIMIT,
  MARKET_COHERENCE_TOLERANCE,
  buildAdministrativeQuery,
  buildRadiusQuery,
  requiredCount,
  surfaceBounds,
  windowStart,
} from '#services/comparables_repository'
import { MIN_SAMPLE } from '#services/valuation_service'

/**
 * Cascade de comparables — §3.2 et Annexe A.3, A.6, A.10, A.11.
 *
 * Ces tests portent sur le **SQL produit**, pas sur son exécution : ils
 * verrouillent les propriétés structurantes (A.6 notamment) sans dépendre du
 * contenu de la base. Une régression sur `ST_DWithin` / `ST_Distance` ne se
 * verrait pas dans un test fonctionnel sur 1 700 lignes — elle ne se verrait
 * qu'en production, sur plusieurs millions.
 */

const CRITERIA = {
  lon: 1.87,
  lat: 46.17,
  codeInsee: '23096',
  codeEpci: '200070100',
  codeDepartement: '23',
  codeRegion: '75',
  densiteGrille: null,
  propertyType: 'maison' as const,
  surface: 100,
  referenceDate: '2026-01-15',
}

const BUILT_PROFILE = {
  table: 'mutations' as const,
  surfaceColumn: 'surface_bati' as const,
  baseTolerance: 30,
  widenedTolerance: 40,
  thresholdDivisor: 1,
  cleanOptions: {},
}

/**
 * Isole la clause `WHERE` de la CTE `candidates`.
 *
 * La CTE se referme par une parenthèse en début de ligne : c'est le repère le
 * plus stable, la suite de la requête variant selon que la garde A.10 est
 * active ou non.
 */
function candidatesWhereClause(sql: string): string {
  const start = sql.indexOf('WHERE ST_DWithin')
  const end = sql.indexOf('\n)', start)
  return sql.slice(start, end === -1 ? undefined : end)
}

test.group('Fenêtre temporelle et bornes de surface (§3.2)', () => {
  test('windowStart recule du bon nombre de mois', ({ assert }) => {
    assert.equal(windowStart('2026-01-15', 24), '2024-01-15')
    assert.equal(windowStart('2026-01-15', 36), '2023-01-15')
    assert.equal(windowStart('2026-01-15', 60), '2021-01-15')
  })

  test('windowStart ne déborde pas sur le mois suivant (report JS)', ({ assert }) => {
    /*
     * `Date.UTC(2025, 1, 31)` — 31 février — est reporté au **3 mars**.
     * Partant du 31 mars 2025, une fenêtre d'un mois démarrait donc au 3 mars
     * au lieu du 28 février : trois jours de transactions perdus, quatre fois
     * par an, sans que rien ne le signale.
     */
    assert.equal(windowStart('2025-03-31', 1), '2025-02-28')
    assert.equal(windowStart('2024-03-31', 1), '2024-02-29', '2024 est bissextile')
    assert.equal(windowStart('2025-07-31', 1), '2025-06-30')
    assert.equal(windowStart('2025-05-31', 1), '2025-04-30')

    // Un jour qui existe dans le mois cible est conservé tel quel.
    assert.equal(windowStart('2025-03-15', 1), '2025-02-15')
    assert.equal(windowStart('2026-01-31', 24), '2024-01-31')
  })

  test('windowStart ne dépend pas de l’horloge du processus', ({ assert }) => {
    // La date de référence est injectée : deux appels doivent coïncider, et
    // une date illisible ne doit pas produire « Invalid Date ».
    assert.equal(windowStart('2026-01-15', 24), windowStart('2026-01-15', 24))
    assert.equal(windowStart('n’importe quoi', 24), '1970-01-01')
  })

  test('surfaceBounds applique ±30 % puis ±40 %', ({ assert }) => {
    assert.deepEqual(surfaceBounds(100, 30), [70, 130])
    assert.deepEqual(surfaceBounds(100, 40), [60, 140])
    // Terrain : ±50 % (§3.2, cas particuliers).
    assert.deepEqual(surfaceBounds(1_000, 50), [500, 1_500])
  })

  test('les seuils du terrain sont divisés par 2, sans passer sous N_min', ({ assert }) => {
    assert.equal(requiredCount(15, 1), 15)
    assert.equal(requiredCount(15, 2), 8)
    assert.equal(requiredCount(12, 2), 6)
    // §3.2 : « N_min absolu = 5 » — le plancher prime toujours.
    assert.equal(requiredCount(8, 2), MIN_SAMPLE)
    assert.equal(requiredCount(5, 1), MIN_SAMPLE)
  })
})

test.group('Annexe A.6 — forme indexable des requêtes au rayon', () => {
  const built = buildRadiusQuery(
    CRITERIA,
    BUILT_PROFILE,
    { level: 'radius', radiusM: 500, windowMonths: 24, minCount: 15 },
    30
  )!

  test('ST_DWithin est présent dans le WHERE', ({ assert }) => {
    assert.include(candidatesWhereClause(built.sql), 'ST_DWithin')
  })

  test('ST_Distance n’apparaît JAMAIS dans le WHERE de la sélection', ({ assert }) => {
    /*
     * C'est LE test qui compte. `ST_Distance(...) <= r` dans le `WHERE` est un
     * appel de fonction géodésique sur chaque ligne : aucune classe
     * d'opérateur ne s'y applique, donc Seq Scan sur plusieurs millions de
     * lignes. Des secondes contre des millisecondes — et la régression est
     * invisible tant que la base est petite.
     */
    assert.notInclude(candidatesWhereClause(built.sql), 'ST_Distance')
  })

  test('ST_Distance est utilisé en projection et pour le tri', ({ assert }) => {
    assert.include(built.sql, 'ST_Distance(m.geom')
    assert.include(built.sql, 'ORDER BY c.distance_m ASC')
  })

  test('les bornes de surface sont transtypées explicitement', ({ assert }) => {
    /*
     * Régression réelle rencontrée pendant ce lot : `surface_bati` est un
     * `integer`, PostgreSQL en déduit le type du paramètre, et une borne de
     * 45,5 m² (65 m² − 30 %) fait échouer la requête avec « invalid input
     * syntax for type integer ». Le niveau était alors abandonné et la
     * cascade descendait d'un cran **en silence** : l'estimation restait
     * plausible, mais reposait sur une tolérance de ±40 % au lieu de ±30 %.
     */
    assert.include(built.sql, 'BETWEEN ?::double precision AND ?::double precision')
    assert.deepEqual(surfaceBounds(65, 30), [45.5, 84.5])
  })

  test('le point est bien construit en geography (mètres)', ({ assert }) => {
    // Sur `geometry`, le rayon serait interprété en degrés : un « 500 » qui
    // vaudrait 55 km. La conversion explicite en `geography` est obligatoire.
    assert.include(built.sql, 'ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography')
  })
})

test.group('Annexe A.3 — géolocalisation grossière exclue du rayon', () => {
  test('les niveaux au rayon filtrent geoloc_fine = true', ({ assert }) => {
    const built = buildRadiusQuery(
      CRITERIA,
      BUILT_PROFILE,
      { level: 'radius', radiusM: 500, windowMonths: 24, minCount: 15 },
      30
    )!

    // Un point posé au centroïde communal n'a aucun sens dans un rayon de
    // 500 m : il ferait croire à une vente « à 120 m » qui peut être à 6 km.
    assert.include(candidatesWhereClause(built.sql), 'geoloc_fine = true')
  })

  test('les niveaux administratifs ne filtrent PAS geoloc_fine', ({ assert }) => {
    // À l'échelle d'une commune, seule l'appartenance compte : exclure ces
    // mutations appauvrirait l'échantillon sans rien gagner.
    const built = buildAdministrativeQuery(
      CRITERIA,
      BUILT_PROFILE,
      { level: 'commune', radiusM: null, windowMonths: 36, minCount: 8 },
      30
    )!

    assert.notInclude(built.sql, 'geoloc_fine')
  })
})

test.group('Annexe A.10 — garde de cohérence de marché', () => {
  test('la garde est inactive à 500 m et 1 km : aucune médiane n’est calculée', ({ assert }) => {
    for (const radiusM of [500, 1_000]) {
      const built = buildRadiusQuery(
        CRITERIA,
        BUILT_PROFILE,
        { level: 'radius', radiusM, windowMonths: 24, minCount: 15 },
        30
      )!
      /*
       * Le SQL ne porte plus un drapeau qui neutralise la clause : la clause
       * n'est pas produite du tout. À ces rayons, agréger les médianes
       * communales serait un travail intégralement jeté sur le chemin chaud.
       */
      assert.notInclude(built.sql, 'commune_med')
      assert.notInclude(built.sql, 'agg_commune_type')
    }
  })

  test('la garde est active à partir de 2 km', ({ assert }) => {
    for (const radiusM of [2_000, 5_000]) {
      const built = buildRadiusQuery(
        CRITERIA,
        BUILT_PROFILE,
        { level: 'radius', radiusM, windowMonths: 36, minCount: 12 },
        30
      )!
      assert.include(built.sql, 'commune_med')
    }
  })

  test('les médianes communales sont lues dans la vue matérialisée', ({ assert }) => {
    /*
     * Recalculer un `percentile_cont` sur tout l'historique à chaque requête
     * faisait dépasser le `statement_timeout` de 2 s (A.6) sur un département
     * dense : le niveau était abandonné et la cascade descendait d'un cran EN
     * SILENCE. `agg_commune_type` porte la statistique, précalculée.
     */
    const built = buildRadiusQuery(
      CRITERIA,
      BUILT_PROFILE,
      { level: 'radius', radiusM: 5_000, windowMonths: 36, minCount: 10 },
      30
    )!

    assert.include(built.sql, 'agg_commune_type')
    assert.notInclude(built.sql, 'percentile_cont')
  })

  test('la tolérance de médiane communale vaut ±35 %', ({ assert }) => {
    const built = buildRadiusQuery(
      CRITERIA,
      BUILT_PROFILE,
      { level: 'radius', radiusM: 5_000, windowMonths: 36, minCount: 10 },
      30
    )!

    assert.equal(MARKET_COHERENCE_TOLERANCE, 0.35)
    assert.include(built.bindings, MARKET_COHERENCE_TOLERANCE)
    assert.include(built.sql, 'commune_med')
  })

  test('la garde est neutralisée si la commune de référence est inconnue', ({ assert }) => {
    // Sans médiane de référence, comparer à ±35 % de rien viderait
    // l'échantillon. On préfère un échantillon large à un échantillon vide.
    const built = buildRadiusQuery(
      { ...CRITERIA, codeInsee: null },
      BUILT_PROFILE,
      { level: 'radius', radiusM: 5_000, windowMonths: 36, minCount: 10 },
      30
    )!

    assert.notInclude(built.sql, 'commune_med')
  })
})

test.group('Annexe A.12 — plafond K et frontière SQL / calcul', () => {
  test('le SQL ne rend jamais plus de 200 lignes', ({ assert }) => {
    const radius = buildRadiusQuery(
      CRITERIA,
      BUILT_PROFILE,
      { level: 'radius', radiusM: 500, windowMonths: 24, minCount: 15 },
      30
    )!
    const admin = buildAdministrativeQuery(
      CRITERIA,
      BUILT_PROFILE,
      { level: 'departement', radiusM: null, windowMonths: 60, minCount: 8 },
      40
    )!

    assert.equal(COMPARABLES_HARD_LIMIT, 200)
    assert.include(radius.bindings, COMPARABLES_HARD_LIMIT)
    assert.include(admin.bindings, COMPARABLES_HARD_LIMIT)
  })

  test('le SQL ne calcule ni médiane ni quartile de l’échantillon retourné', ({ assert }) => {
    const built = buildAdministrativeQuery(
      CRITERIA,
      BUILT_PROFILE,
      { level: 'commune', radiusM: null, windowMonths: 36, minCount: 8 },
      30
    )!

    // A.12 : « le SQL filtre, classe et limite. Il ne calcule ni médiane, ni
    // quartiles, ni coefficients. »
    assert.notInclude(built.sql, 'percentile_cont')
  })
})

test.group('Niveaux administratifs (§3.2, L5 à L9)', () => {
  const levels = [
    { level: 'commune' as const, fragment: 'm.code_insee = ?' },
    { level: 'epci' as const, fragment: 'code_epci = ?' },
    { level: 'departement' as const, fragment: 'm.code_departement = ?' },
    { level: 'region' as const, fragment: 'code_region = ?' },
  ]

  for (const { level, fragment } of levels) {
    test(`le niveau ${level} restreint bien son périmètre`, ({ assert }) => {
      const built = buildAdministrativeQuery(
        CRITERIA,
        BUILT_PROFILE,
        { level, radiusM: null, windowMonths: 36, minCount: 8 },
        30
      )!

      assert.include(built.sql, fragment)
    })
  }

  test('un rattachement administratif inconnu annule le niveau', ({ assert }) => {
    // Pas d'EPCI connu ⇒ le niveau est sauté, pas exécuté « sans filtre ».
    const built = buildAdministrativeQuery(
      { ...CRITERIA, codeEpci: null },
      BUILT_PROFILE,
      { level: 'epci', radiusM: null, windowMonths: 36, minCount: 8 },
      30
    )

    assert.isNull(built)
  })

  test('le niveau national applique la strate de densité si elle est connue', ({ assert }) => {
    const withDensity = buildAdministrativeQuery(
      { ...CRITERIA, densiteGrille: 5 },
      BUILT_PROFILE,
      { level: 'national', radiusM: null, windowMonths: 60, minCount: 5 },
      40
    )!

    assert.include(withDensity.sql, 'densite_grille = ?')
  })

  test('une strate de densité inconnue ne vide pas l’échantillon de dernier recours', ({
    assert,
  }) => {
    const withoutDensity = buildAdministrativeQuery(
      CRITERIA,
      BUILT_PROFILE,
      { level: 'national', radiusM: null, windowMonths: 60, minCount: 5 },
      40
    )!

    assert.notInclude(withoutDensity.sql, 'densite_grille')
  })

  test('la distance n’est calculée qu’après la limitation à 200 lignes', ({ assert }) => {
    const built = buildAdministrativeQuery(
      CRITERIA,
      BUILT_PROFILE,
      { level: 'region', radiusM: null, windowMonths: 60, minCount: 8 },
      40
    )!

    // Le `LIMIT` appartient à la CTE, l'appel `ST_Distance` à la projection
    // externe : projeter une distance géodésique sur toute une région
    // coûterait plus cher que le reste de la requête.
    const limitIndex = built.sql.indexOf('LIMIT ?')
    const distanceIndex = built.sql.indexOf('ST_Distance(c.geom')

    assert.isAbove(limitIndex, 0)
    assert.isAbove(distanceIndex, limitIndex)
  })
})
