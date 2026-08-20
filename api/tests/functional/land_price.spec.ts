import { test } from '@japa/runner'

import {
  GUERET,
  insertTerrains,
  monthsAgo,
  resetEstimationFixtures,
  type TerrainFixture,
} from '#tests/helpers/estimation_fixtures'
import { ComparablesRepository } from '#services/comparables_repository'

/**
 * `landPricePerSqm()` — §3.6.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CES TESTS PROTÈGENT
 * ══════════════════════════════════════════════════════════════════════════
 * Cette médiane ne sert pas à afficher une statistique : elle **multiplie la
 * surface entière du jardin** dans la valorisation d'une maison. Elle n'avait
 * ni fenêtre temporelle ni effectif minimum — **une seule vente de terrain
 * fixait donc la médiane communale**. Dans une commune rurale où une seule
 * parcelle change de main dans l'année, une cession entre voisins ou un
 * terrain enclavé devenait la référence de tous les jardins de la commune, et
 * cela n'apparaissait nulle part dans le rapport de méthode.
 *
 * Le repli n'a jamais manqué : le ratio forfaitaire du §3.6 est sourcé et
 * documenté. Une médiane d'un seul point ne l'est pas.
 */

const repository = new ComparablesRepository()

/** Terrains d'une commune donnée, tous au même prix au m². */
function terrainsAt(
  prefix: string,
  count: number,
  pricePerSqm: number,
  overrides: Partial<TerrainFixture> = {}
): TerrainFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    idMutation: `${prefix}-${index}`,
    dateMutation: monthsAgo(6),
    surfaceTerrain: 1_000,
    valeurFonciere: 1_000 * pricePerSqm,
    lonOffset: index * 0.0004,
    ...overrides,
  }))
}

test.group('landPricePerSqm — effectif minimum et fenêtre (§3.6)', (group) => {
  group.each.setup(async () => {
    await resetEstimationFixtures()
    return async () => resetEstimationFixtures()
  })

  test('une seule vente de terrain ne fixe pas la médiane communale', async ({ assert }) => {
    // 400 €/m² dans la Creuse : le genre de point isolé qui, seul, faisait
    // référence pour tous les jardins de la commune.
    await insertTerrains(GUERET, terrainsAt('solo', 1, 400))

    const median = await repository.landPricePerSqm(GUERET.codeInsee, GUERET.codeDepartement)

    assert.isNull(median, 'le repli forfaitaire sourcé vaut mieux qu’une médiane d’un seul point')
  })

  test('quatre ventes ne suffisent pas davantage', async ({ assert }) => {
    // Le plancher est à 5 : la cascade du §3.2 pose déjà qu'« un échantillon
    // de 3 ventes ne produit pas un prix défendable ».
    await insertTerrains(GUERET, terrainsAt('quatre', 4, 400))

    const median = await repository.landPricePerSqm(GUERET.codeInsee, GUERET.codeDepartement)

    assert.isNull(median)
  })

  test('cinq ventes communales suffisent, et la médiane est bien celle de la commune', async ({
    assert,
  }) => {
    await insertTerrains(GUERET, terrainsAt('commune', 5, 60))
    // Bruit départemental, à un tout autre niveau de prix : il ne doit PAS
    // être consulté tant que la commune se suffit à elle-même.
    await insertTerrains(GUERET, terrainsAt('dep', 20, 12, { codeInsee: '23001' }))

    const median = await repository.landPricePerSqm(GUERET.codeInsee, GUERET.codeDepartement)

    assert.closeTo(median ?? 0, 60, 0.01, 'la commune prime sur le département')
  })

  test('à défaut de commune, le département prend le relais', async ({ assert }) => {
    // Une seule vente dans la commune, largement assez dans le département :
    // s'éloigner d'un cran vaut mieux que le forfait, et bien mieux qu'un
    // point unique.
    await insertTerrains(GUERET, terrainsAt('locale', 1, 400))
    await insertTerrains(GUERET, terrainsAt('dept', 9, 25, { codeInsee: '23001' }))

    const median = await repository.landPricePerSqm(GUERET.codeInsee, GUERET.codeDepartement)

    assert.isNotNull(median)
    // 9 ventes à 25 €/m² + la vente locale à 400 €/m² : la médiane
    // départementale reste à 25 €/m², le point isolé ne la déplace pas.
    assert.closeTo(median ?? 0, 25, 0.01)
  })

  test('les ventes hors fenêtre de 60 mois ne comptent pas', async ({ assert }) => {
    /*
     * Sans fenêtre, une vente de 2014 pesait autant qu'une vente de l'an
     * dernier, alors que le foncier constructible a connu depuis des
     * évolutions à deux chiffres.
     */
    await insertTerrains(GUERET, terrainsAt('vieux', 10, 400, { dateMutation: monthsAgo(72) }))

    const median = await repository.landPricePerSqm(GUERET.codeInsee, GUERET.codeDepartement)

    assert.isNull(median, '10 ventes de plus de 5 ans ne font pas un prix d’aujourd’hui')
  })

  test('les aberrants marqués sont exclus, terrain_mixte compris', async ({ assert }) => {
    // `is_outlier = false` est le seul filtre qui protège la médiane des lots
    // mixtes réintroduits par l'ingestion (cf. `terrain_mixte`).
    await insertTerrains(GUERET, terrainsAt('propre', 5, 60))
    await insertTerrains(GUERET, terrainsAt('mixte', 20, 500, { isOutlier: true }))

    const median = await repository.landPricePerSqm(GUERET.codeInsee, GUERET.codeDepartement)

    assert.closeTo(median ?? 0, 60, 0.01)
  })

  test('aucun périmètre connu : aucune médiane inventée', async ({ assert }) => {
    const median = await repository.landPricePerSqm(null, null)
    assert.isNull(median)
  })
})
