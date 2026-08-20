import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  GeocodingService,
  buildQueryHash,
  classifyPrecision,
  parseBanResponse,
  type BanClient,
  type BanFeature,
} from '#services/geocoding_service'

/**
 * Géocodage — spec §3.1, §6.2.
 *
 * **Aucun appel réseau** : le client BAN est bouchonné. `BAN_API_URL` pointe
 * d'ailleurs sur une adresse inatteignable en environnement de test, de sorte
 * qu'un appel réel accidentel échouerait bruyamment au lieu de passer
 * inaperçu.
 */

/** Client BAN bouchonné. */
class StubBanClient implements BanClient {
  public calls = 0

  constructor(private readonly result: BanFeature | null | (() => never)) {}

  async search(): Promise<BanFeature | null> {
    this.calls += 1
    if (typeof this.result === 'function') {
      // Simule une panne réseau : le service doit la absorber, pas la propager.
      return this.result()
    }
    return this.result
  }
}

const PARIS: BanFeature = {
  label: '12 Rue de la Paix 75002 Paris',
  score: 0.96,
  type: 'housenumber',
  citycode: '75102',
  city: 'Paris',
  postcode: '75002',
  lon: 2.331303,
  lat: 48.869141,
}

async function seedCommune(overrides: Record<string, unknown> = {}) {
  const values = {
    code_insee: '75102',
    nom: 'Paris',
    nom_normalise: 'paris',
    codes_postaux: '{75002}',
    code_departement: '75',
    code_region: '11',
    population: 20_000,
    lon: 2.34,
    lat: 48.86,
    has_dvf: true,
    ...overrides,
  }

  await db.rawQuery(
    `INSERT INTO communes (code_insee, nom, nom_normalise, codes_postaux, code_departement,
                           code_region, population, centroid, has_dvf)
     VALUES (:code_insee, :nom, :nom_normalise, :codes_postaux::text[], :code_departement,
             :code_region, :population,
             ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography, :has_dvf)
     ON CONFLICT (code_insee) DO NOTHING`,
    values
  )
}

test.group('Géocodage | règles pures (§3.1)', () => {
  test('classe la précision selon le type et le score', ({ assert }) => {
    assert.equal(classifyPrecision('housenumber', 0.96), 'exact')
    assert.equal(classifyPrecision('housenumber', 0.7), 'exact')
    // Un numéro trouvé mais peu sûr n'est plus « exact ».
    assert.equal(classifyPrecision('housenumber', 0.5), 'approximate')
    assert.equal(classifyPrecision('street', 0.9), 'approximate')
    assert.equal(classifyPrecision('locality', 0.8), 'approximate')
    // Sous 0,4, le résultat est inexploitable : on repliera sur le centroïde.
    assert.equal(classifyPrecision('housenumber', 0.2), 'reject')
  })

  test('le seuil de 0,4 s’applique AUSSI aux types street et locality', ({ assert }) => {
    /*
     * L'écriture précédente — `type === 'street' || type === 'locality' ||
     * (score >= 0.4 && score < 0.7)` — court-circuitait le seuil : un
     * `type: 'street'` noté 0,2 était classé `approximate`. §3.1 impose le
     * repli sur le centroïde communal sous 0,4. Conséquence concrète : les
     * comparables étaient cherchés dans un rayon de 500 m autour d'une rue
     * que la BAN elle-même jugeait douteuse, et l'estimation ne subissait que
     * le malus de 5 points au lieu de 12.
     */
    assert.equal(classifyPrecision('street', 0.2), 'reject')
    assert.equal(classifyPrecision('locality', 0.39), 'reject')
    // Juste au-dessus du seuil, le repli n'a plus lieu d'être.
    assert.equal(classifyPrecision('street', 0.4), 'approximate')
  })

  test('extrait la première entité BAN exploitable', ({ assert }) => {
    const parsed = parseBanResponse({
      features: [
        {
          geometry: { coordinates: [2.331303, 48.869141] },
          properties: {
            label: 'X',
            score: 0.9,
            type: 'housenumber',
            citycode: '75102',
            city: 'Paris',
            postcode: '75002',
          },
        },
      ],
    })

    assert.equal(parsed?.lon, 2.331303)
    assert.equal(parsed?.citycode, '75102')
  })

  test('renvoie null sur une réponse vide ou malformée', ({ assert }) => {
    assert.isNull(parseBanResponse({}))
    assert.isNull(parseBanResponse({ features: [] }))
    assert.isNull(parseBanResponse({ features: [{ properties: { label: 'X' } }] }))
  })

  test('la clé de cache est insensible à la casse et aux espaces', ({ assert }) => {
    const a = buildQueryHash({ address: '12 Rue de la Paix', postalCode: '75002', city: 'Paris' })
    const b = buildQueryHash({
      address: '  12   RUE DE LA PAIX ',
      postalCode: '75002',
      city: 'paris',
    })
    assert.equal(a, b)

    const other = buildQueryHash({
      address: '13 Rue de la Paix',
      postalCode: '75002',
      city: 'Paris',
    })
    assert.notEqual(a, other)
  })
})

test.group('Géocodage | service (ne rejette jamais)', (group) => {
  group.each.setup(async () => {
    await db.rawQuery('DELETE FROM geocode_cache')
    await db.rawQuery('DELETE FROM communes')
  })

  test('un résultat BAN précis est retourné et mis en cache', async ({ assert }) => {
    await seedCommune()
    const ban = new StubBanClient(PARIS)
    const service = new GeocodingService(ban)

    const input = { address: '12 Rue de la Paix', postalCode: '75002', city: 'Paris' }
    const first = await service.geocode(input)

    assert.equal(first.precision, 'exact')
    assert.equal(first.cityCode, '75102')
    assert.equal(first.source, 'ban')

    // Deuxième appel : servi par le cache, la BAN n'est pas réinterrogée.
    const second = await service.geocode(input)
    assert.equal(second.source, 'cache')
    assert.equal(ban.calls, 1, 'la BAN ne doit être appelée qu’une fois')
  })

  test('BAN injoignable ⇒ repli sur le centroïde communal, jamais une erreur', async ({
    assert,
  }) => {
    /*
     * §3.1 : « Un échec BAN ne fait jamais échouer l'estimation : on descend
     * en précision. » Une panne d'un service public tiers ne doit pas
     * devenir une panne de notre tunnel de conversion.
     */
    await seedCommune()
    const ban = new StubBanClient(() => {
      throw new Error('réseau indisponible')
    })

    const result = await new GeocodingService(ban).geocode({
      address: '12 Rue de la Paix',
      postalCode: '75002',
      city: 'Paris',
    })

    assert.equal(result.precision, 'city-centroid')
    assert.equal(result.source, 'commune-centroid')
    assert.equal(result.cityCode, '75102')
    assert.equal(result.lon, 2.34)
  })

  test('un score trop faible déclenche aussi le repli communal', async ({ assert }) => {
    await seedCommune()
    const ban = new StubBanClient({ ...PARIS, score: 0.1, type: 'housenumber' })

    const result = await new GeocodingService(ban).geocode({
      address: 'adresse illisible',
      postalCode: '75002',
      city: 'Paris',
    })

    assert.equal(result.precision, 'city-centroid')
  })

  test('sans commune connue, le service renvoie tout de même un résultat', async ({ assert }) => {
    // Base de communes pas encore alimentée : on ne rejette toujours pas.
    const ban = new StubBanClient(null)

    const result = await new GeocodingService(ban).geocode({
      address: 'quelque part',
      postalCode: '99999',
      city: 'Inconnue',
    })

    assert.equal(result.precision, 'city-centroid')
    assert.isNull(result.lon)
  })

  test('la couverture DVF de la commune est remontée (§1.3)', async ({ assert }) => {
    await seedCommune({
      code_insee: '67482',
      nom: 'Strasbourg',
      nom_normalise: 'strasbourg',
      codes_postaux: '{67000}',
      code_departement: '67',
      has_dvf: false,
      lon: 7.75,
      lat: 48.58,
    })

    const ban = new StubBanClient({
      ...PARIS,
      citycode: '67482',
      city: 'Strasbourg',
      postcode: '67000',
    })

    const result = await new GeocodingService(ban).geocode({
      address: '1 place Kléber',
      postalCode: '67000',
      city: 'Strasbourg',
    })

    assert.isFalse(result.hasDvf, 'Strasbourg relève du Livre foncier : hors DVF')
  })
})

test.group('GET /v1/geocode', (group) => {
  group.each.setup(async () => {
    await db.rawQuery('DELETE FROM geocode_cache')
    await db.rawQuery('DELETE FROM communes')
  })

  test('refuse une requête sans paramètre q (422)', async ({ client, assert }) => {
    const response = await client.get('/v1/geocode')

    response.assertStatus(422)
    const body = response.body()
    assert.equal(body.code, 'VALIDATION_ERROR')
    assert.isArray(body.errors)
    // Message en français, directement affichable (§6.1).
    assert.match(body.errors[0].message, /obligatoire|adresse/i)
  })

  test('refuse un code postal mal formé (422)', async ({ client, assert }) => {
    const response = await client.get('/v1/geocode').qs({ q: 'rue de la paix', postcode: '7500' })

    response.assertStatus(422)
    assert.equal(response.body().code, 'VALIDATION_ERROR')
  })

  test('retourne 404 quand aucune position ne peut être déterminée', async ({ client, assert }) => {
    // La BAN de test est inatteignable et aucune commune n'est connue.
    const response = await client
      .get('/v1/geocode')
      .qs({ q: 'adresse introuvable', postcode: '99999' })

    response.assertStatus(404)
    assert.equal(response.body().code, 'NOT_FOUND')
  })

  test('retourne la position issue du repli communal', async ({ client, assert }) => {
    await seedCommune()

    const response = await client
      .get('/v1/geocode')
      .qs({ q: 'rue de la paix', postcode: '75002', city: 'Paris' })

    response.assertStatus(200)
    const body = response.body()

    assert.equal(body.cityCode, '75102')
    assert.equal(body.precision, 'city-centroid')
    assert.isTrue(body.hasDvf)
    assert.isNumber(body.lon)
  })
})
