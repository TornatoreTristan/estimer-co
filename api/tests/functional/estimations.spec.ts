import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'

import {
  GUERET,
  STRASBOURG,
  estimationPayload,
  resetEstimationFixtures,
  seedCommunes,
  seedDatasetVersion,
  seedGueretApartments,
  seedGueretHouses,
  seedGueretTerrains,
  seedReferences,
} from '#tests/helpers/estimation_fixtures'
import { EstimationService } from '#services/estimation_service'
import { DataVersionService } from '#services/data_version_service'

/**
 * `POST /v1/estimations` — spec §6.1, US-1, US-6, US-8, US-9.
 *
 * Ces tests vérifient le **contrat HTTP** et l'orchestration. Les formules
 * elles-mêmes sont couvertes, sans base, par `tests/unit/valuation.spec.ts` :
 * dupliquer ici les assertions sur la médiane pondérée n'apporterait rien
 * qu'un temps d'exécution plus long et un diagnostic plus difficile.
 */

test.group('POST /v1/estimations — chemin nominal (US-1)', (group) => {
  group.each.setup(async () => {
    await limiter.clear(['memory'])
    await resetEstimationFixtures()
    await seedCommunes()
    await seedReferences()
    await seedDatasetVersion()
    await seedGueretApartments()
  })

  group.each.teardown(async () => {
    await resetEstimationFixtures()
  })

  test('répond 200 avec une valeur, une fourchette, une confiance et des comparables', async ({
    client,
    assert,
  }) => {
    const response = await client.post('/v1/estimations').json(estimationPayload())

    response.assertStatus(200)
    const body = response.body()

    assert.equal(body.apiVersion, 1)
    assert.isString(body.requestId)
    assert.isNumber(body.value)
    assert.isNumber(body.pricePerSqm)

    assert.isNumber(body.range.low)
    assert.isNumber(body.range.high)
    assert.isBelow(body.range.low, body.value)
    assert.isAbove(body.range.high, body.value)

    assert.isNumber(body.confidence.score)
    assert.isString(body.display.confidenceLabelFr)

    assert.equal(body.method.kind, 'comparables')
    assert.isAtLeast(body.method.comparablesCount, 5)
    assert.isAtLeast(body.comparables.length, 1)
  })

  test('le niveau retenu et le rayon effectif sont exposés (transparence §3.2)', async ({
    client,
    assert,
  }) => {
    const response = await client.post('/v1/estimations').json(estimationPayload())
    const body = response.body()

    assert.equal(body.method.level, 'radius')
    assert.isAtMost(body.method.radiusM, 5_000)
    assert.equal(body.method.windowMonths, 24)
    assert.equal(body.method.surfaceTolerancePct, 30)
  })

  test('les comparables sont anonymisés (§8.3)', async ({ client, assert }) => {
    const response = await client.post('/v1/estimations').json(estimationPayload())
    const [comparable] = response.body().comparables

    // Date au mois, jamais au jour.
    assert.match(comparable.date, /^\d{4}-\d{2}$/)
    // Distance arrondie au multiple de 50 m.
    assert.equal(comparable.distanceM % 50, 0)
    // Aucun numéro de voie.
    assert.notMatch(comparable.street, /^\d/)
    assert.isAtMost(response.body().comparables.length, 5)
  })

  test('la mention légale et l’avertissement proviennent de l’API (US-9)', async ({
    client,
    assert,
  }) => {
    const response = await client.post('/v1/estimations').json(estimationPayload())
    const { dataSource } = response.body()

    assert.equal(dataSource.dataCoverage, 'dvf')
    assert.equal(dataSource.primary, 'DVF')
    assert.equal(dataSource.licence, 'Licence Ouverte / Etalab 2.0')
    assert.include(dataSource.attributionFr, 'Licence Ouverte / Etalab 2.0')
    assert.include(dataSource.attributionFr, 'Demandes de valeurs foncières')
    assert.include(dataSource.disclaimerFr, 'ni une expertise immobilière')
    // Sur le chemin DVF, l'avertissement PEUT invoquer des comparables : il y
    // en a.
    assert.include(dataSource.disclaimerFr, 'repose sur des transactions comparables')
  })

  test('la date de publication DVF est une DATE, pas un horodatage (§5.3)', async ({
    client,
    assert,
  }) => {
    // §5.3 spécifie `"2025-10-01"`. Un ISO complet obligeait chaque
    // consommateur (page, PDF, e-mail) à le retailler, avec un risque de
    // décalage d'un jour selon le fuseau appliqué à l'affichage.
    const response = await client.post('/v1/estimations').json(estimationPayload())

    assert.match(response.body().dataSource.dvfPublicationDate, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(response.body().dataSource.dvfPublicationDate, '2025-10-01')
  })

  test('les SOURCES des coefficients appliqués remontent au front (§3.6, règle 3)', async ({
    client,
    assert,
  }) => {
    /*
     * `coefficients_reference.source_label` est NOT NULL (§5.1) précisément
     * pour qu'aucun coefficient ne puisse exister sans source. La base porte
     * la mention honnête « Valeur provisoire de la spécification produit
     * (§3.6) — à calibrer au Lot 5 » ; elle n'atteignait aucun écran,
     * `method.coefficients` n'exposant que des nombres. Le front ne pouvait
     * donc tenir l'obligation du §3.6 — dire « provisoires » — qu'en la
     * recopiant en dur, c'est-à-dire en la figeant.
     */
    const response = await client
      .post('/v1/estimations')
      .json(estimationPayload({ dpe: 'C', condition: 'good' }))

    const sources = response.body().method.coefficientSources
    assert.isArray(sources)
    assert.isAbove(sources.length, 0)

    for (const source of sources) {
      assert.isString(source.key)
      assert.isString(source.label)
      assert.isNotEmpty(source.sourceLabel)
    }

    const keys = sources.map((source: { key: string }) => source.key)
    assert.include(keys, 'dpe.C', 'le coefficient de valeur verte appliqué doit être sourcé')
    assert.include(keys, 'etat.good')
    assert.include(keys, 'surface.alpha')

    // Le caractère provisoire, tel qu'il est écrit en base, arrive bien à
    // l'écran.
    const dpe = sources.find((source: { key: string }) => source.key === 'dpe.C')
    assert.match(dpe.sourceLabel, /provisoire/i)
    assert.match(dpe.label, /valeur verte/i)
  })

  test('seuls les coefficients RÉELLEMENT appliqués sont sourcés', async ({ client, assert }) => {
    // Un DPE inconnu vaut 1,00 (aucun ajustement) : annoncer une source
    // reviendrait à documenter un calcul qui n'a pas eu lieu.
    const response = await client
      .post('/v1/estimations')
      .json(estimationPayload({ dpe: 'unknown' }))

    const keys = response
      .body()
      .method.coefficientSources.map((source: { key: string }) => source.key)

    assert.notInclude(keys, 'dpe.unknown')
    assert.isTrue(
      keys.every((key: string) => !key.startsWith('dpe.')),
      'aucun coefficient de DPE ne doit être sourcé quand le DPE est inconnu'
    )
    // Un appartement sans étage renseigné n'a pas de k_etage.
    assert.isTrue(keys.every((key: string) => !key.startsWith('etage.')))
  })

  test('l’en-tête X-Data-Version accompagne la réponse', async ({ client }) => {
    const response = await client.post('/v1/estimations').json(estimationPayload())
    response.assertHeader('x-data-version', 'dvf-2025-10')
  })

  test('DÉCISION CLIENT : display.showCentralValue vaut toujours true', async ({
    client,
    assert,
  }) => {
    const response = await client.post('/v1/estimations').json(estimationPayload())
    assert.isTrue(response.body().display.showCentralValue)
  })

  test('un DPE plus favorable donne une valeur plus élevée (§3.6)', async ({ client, assert }) => {
    const good = await client.post('/v1/estimations').json(estimationPayload({ dpe: 'A' }))
    const bad = await client.post('/v1/estimations').json(estimationPayload({ dpe: 'G' }))

    assert.isAbove(good.body().value, bad.body().value)
    assert.isAbove(good.body().method.coefficients.dpe, bad.body().method.coefficients.dpe)
  })

  test('l’estimation est journalisée SANS aucune donnée personnelle (§8.3)', async ({
    client,
    assert,
  }) => {
    await client.post('/v1/estimations').json(estimationPayload())

    const rows = await db.rawQuery('SELECT * FROM estimations_log ORDER BY id DESC LIMIT 1')
    const entry = rows.rows[0]

    assert.exists(entry)
    assert.equal(entry.code_insee.trim(), GUERET.codeInsee)
    assert.equal(entry.method_kind, 'comparables')
    assert.isAtLeast(entry.n_comparables, 5)

    // L'IP n'existe que sous forme de HMAC : 64 caractères hexadécimaux.
    if (entry.ip_hmac) {
      assert.match(entry.ip_hmac, /^[0-9a-f]{64}$/)
    }

    // Aucune colonne du journal ne peut accueillir une adresse : la garantie
    // est structurelle, ce test le vérifie explicitement.
    const columns = Object.keys(entry)
    assert.notInclude(columns, 'address')
    assert.notInclude(columns, 'adresse')
    assert.notInclude(columns, 'email')
    assert.notInclude(columns, 'ip')
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §6.1 — Validation
 * ════════════════════════════════════════════════════════════════════════ */

test.group('POST /v1/estimations — validation (§6.1, US-8)', (group) => {
  group.each.setup(async () => {
    await limiter.clear(['memory'])
    await resetEstimationFixtures()
    await seedCommunes()
    await seedReferences()
    await seedGueretApartments()
  })

  group.each.teardown(async () => {
    await resetEstimationFixtures()
  })

  test('un payload contenant name, email et phone est refusé (422)', async ({ client, assert }) => {
    const response = await client
      .post('/v1/estimations')
      .json(
        estimationPayload({ name: 'Jean Dupont', email: 'jean@exemple.fr', phone: '0600000000' })
      )

    response.assertStatus(422)

    const body = response.body()
    assert.equal(body.code, 'VALIDATION_ERROR')
    assert.lengthOf(body.errors, 3)
    assert.deepEqual(body.errors.map((error: { field: string }) => error.field).sort(), [
      'email',
      'name',
      'phone',
    ])
  })

  test('aucune valeur personnelle n’est journalisée après un refus (US-8)', async ({
    client,
    assert,
  }) => {
    await client
      .post('/v1/estimations')
      .json(estimationPayload({ name: 'Jean Dupont', email: 'jean@exemple.fr' }))

    const rows = await db.rawQuery('SELECT count(*)::int AS total FROM estimations_log')
    // Le refus intervient AVANT toute exécution : rien n'est journalisé.
    assert.equal(rows.rows[0].total, 0)
  })

  test('un champ non déclaré est refusé', async ({ client, assert }) => {
    const response = await client
      .post('/v1/estimations')
      .json(estimationPayload({ prixSouhaite: 250_000 }))

    response.assertStatus(422)
    assert.equal(response.body().errors[0].field, 'prixSouhaite')
  })

  test('les messages de validation sont en français et directement affichables', async ({
    client,
    assert,
  }) => {
    const response = await client
      .post('/v1/estimations')
      .json(estimationPayload({ postalCode: '2' }))

    response.assertStatus(422)

    const [error] = response.body().errors
    assert.equal(error.field, 'postalCode')
    assert.match(error.message, /code postal/i)
    // Aucun jargon technique ne doit remonter jusqu'à l'utilisateur.
    assert.notMatch(error.message, /regex|validation failed/i)
  })

  test('une surface hors bornes est refusée avec un message parlant', async ({
    client,
    assert,
  }) => {
    const response = await client.post('/v1/estimations').json(estimationPayload({ surface: 3 }))

    response.assertStatus(422)
    assert.match(response.body().errors[0].message, /surface habitable/i)
  })

  test('un type de bien inconnu est refusé', async ({ client }) => {
    const response = await client
      .post('/v1/estimations')
      .json(estimationPayload({ propertyType: 'chateau' }))

    response.assertStatus(422)
  })

  test('aucune trace ni message SQL n’est exposé dans une erreur', async ({ client, assert }) => {
    const response = await client.post('/v1/estimations').json({ address: 'x' })

    response.assertStatus(422)
    const serialized = JSON.stringify(response.body())

    assert.notInclude(serialized, 'SELECT')
    assert.notInclude(serialized, 'pg')
    assert.notInclude(serialized, 'at Object')
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §3.2 / §3.9 — Cas non calculés et repli
 * ════════════════════════════════════════════════════════════════════════ */

test.group('POST /v1/estimations — repli hors DVF (§3.9, US-6)', (group) => {
  group.each.setup(async () => {
    await limiter.clear(['memory'])
    await resetEstimationFixtures()
    await seedCommunes()
    await seedReferences()
    await seedGueretApartments()
  })

  group.each.teardown(async () => {
    await resetEstimationFixtures()
  })

  test('Strasbourg (67) répond 200 en mode reference-table', async ({ client, assert }) => {
    const response = await client.post('/v1/estimations').json(
      estimationPayload({
        address: '1 place Kléber',
        postalCode: STRASBOURG.postalCode,
        city: STRASBOURG.nom,
      })
    )

    // §3.9 : « l'API répond 200 (jamais une erreur : ce n'est pas une panne) ».
    response.assertStatus(200)
    const body = response.body()

    assert.equal(body.method.kind, 'reference-table')
    assert.equal(body.method.level, 'departement-reference')
    assert.equal(body.dataSource.dataCoverage, 'no-dvf')
    assert.deepEqual(body.comparables, [])
    assert.isAtMost(body.confidence.score, 35)
    assert.isNumber(body.value)
  })

  test('la mention Livre foncier est présente et aucune mention DVF ne l’est (US-6)', async ({
    client,
    assert,
  }) => {
    const response = await client.post('/v1/estimations').json(
      estimationPayload({
        address: '1 place Kléber',
        postalCode: STRASBOURG.postalCode,
        city: STRASBOURG.nom,
      })
    )

    const body = response.body()

    assert.isTrue(
      body.display.warnings.some((message: string) => /Livre foncier/.test(message)),
      'la mention Livre foncier du §3.9 est obligatoire'
    )
    /*
     * « aucune mention "source DVF" n'apparaît pour cette estimation ».
     * L'attribution ne doit revendiquer NI la base DVF, NI la DGFiP comme
     * source — la Licence Ouverte interdit de laisser croire que la DGFiP
     * cautionne un chiffre qui ne vient pas d'elle (§8.2, point 3).
     * Elle peut en revanche dire « hors DVF », qui est exactement l'inverse
     * d'une revendication.
     */
    assert.notInclude(body.dataSource.attributionFr, 'Demandes de valeurs foncières')
    assert.notInclude(body.dataSource.attributionFr, 'Direction générale des finances publiques')
    assert.equal(body.dataSource.primary, 'REFERENCE')
    assert.include(body.dataSource.attributionFr, 'Estimation interne, hors DVF')
    assert.isNull(body.dataSource.dvfPublicationDate)
  })

  test('la licence Etalab n’est PAS revendiquée sur un chiffre qui ne vient pas de DVF', async ({
    client,
    assert,
  }) => {
    /*
     * §8.2, point 3 : la Licence Ouverte interdit de laisser croire que la
     * DGFiP cautionne un chiffre qui ne vient pas d'elle. Les références
     * départementales ne sont pas diffusées sous cette licence ; l'annoncer
     * était une attribution fausse dans un champ contractuel.
     */
    const response = await client.post('/v1/estimations').json(
      estimationPayload({
        address: '1 place Kléber',
        postalCode: STRASBOURG.postalCode,
        city: STRASBOURG.nom,
      })
    )

    const { licence } = response.body().dataSource
    assert.notEqual(licence, 'Licence Ouverte / Etalab 2.0')
    assert.match(licence, /hors Licence Ouverte/i)
  })

  test('l’avertissement n’invoque pas des comparables inexistants (§8.4)', async ({
    client,
    assert,
  }) => {
    /*
     * `DISCLAIMER_FR` affirme « Elle repose sur des transactions
     * comparables ». Sur ce chemin, `comparables = []` PAR CONSTRUCTION : la
     * phrase contredisait, à quelques lignes de distance, le bandeau Livre
     * foncier affiché juste au-dessus.
     */
    const response = await client.post('/v1/estimations').json(
      estimationPayload({
        address: '1 place Kléber',
        postalCode: STRASBOURG.postalCode,
        city: STRASBOURG.nom,
      })
    )

    const body = response.body()
    assert.deepEqual(body.comparables, [])
    assert.notInclude(body.dataSource.disclaimerFr, 'repose sur des transactions comparables')
    assert.include(body.dataSource.disclaimerFr, 'ne repose sur aucune transaction comparable')
    // Le reste de la mention du §8.1 est intact.
    assert.include(body.dataSource.disclaimerFr, 'ni une expertise immobilière')
  })

  test('un terrain hors DVF est annoncé no-dvf, pas dvf', async ({ client, assert }) => {
    /*
     * `#notSupported` renvoyait `dataCoverage: 'dvf'` même lorsqu'il était
     * atteint depuis le repli §3.9 : le front affichait alors une attribution
     * DVF sur un chemin qui n'a jamais touché DVF.
     */
    const response = await client.post('/v1/estimations').json(
      estimationPayload({
        address: '1 place Kléber',
        postalCode: STRASBOURG.postalCode,
        city: STRASBOURG.nom,
        propertyType: 'terrain',
        surface: 800,
        rooms: undefined,
      })
    )

    response.assertStatus(200)
    const body = response.body()

    assert.equal(body.method.kind, 'not-supported')
    assert.equal(body.dataSource.dataCoverage, 'no-dvf')
    assert.equal(body.dataSource.primary, 'REFERENCE')
    assert.notEqual(body.dataSource.licence, 'Licence Ouverte / Etalab 2.0')
    assert.notInclude(body.dataSource.attributionFr, 'Demandes de valeurs foncières')
  })

  test('la cascade de comparables n’est PAS exécutée sur un territoire hors DVF', async ({
    client,
    assert,
  }) => {
    /*
     * C'est la garde la plus importante du §3.9. Sans elle, la cascade
     * descendrait jusqu'au niveau national et présenterait une moyenne
     * nationale comme un prix strasbourgeois — une erreur indétectable par
     * l'utilisateur, donc la pire de toutes.
     *
     * Preuve indirecte mais solide : les seules mutations en base sont à
     * Guéret ; si la cascade s'était exécutée, elle aurait fini par les
     * trouver au niveau national et `method.kind` vaudrait `comparables`.
     */
    const response = await client.post('/v1/estimations').json(
      estimationPayload({
        address: '1 place Kléber',
        postalCode: STRASBOURG.postalCode,
        city: STRASBOURG.nom,
      })
    )

    const body = response.body()
    assert.equal(body.method.kind, 'reference-table')
    assert.equal(body.method.comparablesCount, 0)
    assert.equal(body.method.radiusM, null)
  })

  test('le prix reste affiché malgré une confiance faible (décision client)', async ({
    client,
    assert,
  }) => {
    const response = await client.post('/v1/estimations').json(
      estimationPayload({
        address: '1 place Kléber',
        postalCode: STRASBOURG.postalCode,
        city: STRASBOURG.nom,
        dpe: 'unknown',
      })
    )

    const body = response.body()
    /*
     * §3.9 : « confidence plafonnée à 35 → l'UI bascule automatiquement en
     * mode "confiance faible" ». Un score de 18 (35 − malus) faisait afficher
     * « Données insuffisantes » sur un chemin qui, lui, produit bien un prix
     * sourcé.
     */
    assert.equal(body.confidence.score, 35)
    assert.equal(body.confidence.label, 'low')
    assert.equal(body.display.confidenceLabelFr, 'Confiance faible')
    assert.isTrue(body.display.showCentralValue)
    assert.isNumber(body.value)
  })
})

test.group('POST /v1/estimations — cas non calculés (§3.2)', (group) => {
  group.each.setup(async () => {
    await limiter.clear(['memory'])
    await resetEstimationFixtures()
    await seedCommunes()
    await seedReferences()
    await seedGueretApartments()
  })

  group.each.teardown(async () => {
    await resetEstimationFixtures()
  })

  test('un local commercial répond 200 avec method.kind = not-supported', async ({
    client,
    assert,
  }) => {
    const response = await client
      .post('/v1/estimations')
      .json(estimationPayload({ propertyType: 'local-commercial' }))

    response.assertStatus(200)
    const body = response.body()

    assert.equal(body.method.kind, 'not-supported')
    assert.isNull(body.value)
    assert.isNull(body.pricePerSqm)
    assert.deepEqual(body.comparables, [])
    assert.isAbove(body.display.warnings.length, 0)

    /*
     * Annexe B.1 : « `display.showCentralValue` reste dans le DTO mais
     * renvoie TOUJOURS `true` ». Ce chemin renvoyait `false`.
     *
     * Sans conséquence visible ici — `value` est `null`, il n'y a aucune
     * valeur centrale à masquer — mais l'annexe existe précisément pour
     * empêcher qu'on « recorrige » le code vers la version initiale de la
     * spec. Un consommateur du DTO (page, PDF, e-mail interne) doit lire la
     * même règle sur tous les chemins.
     */
    assert.isTrue(body.display.showCentralValue, 'Annexe B.1 : toujours true')
  })

  test('un secteur sans transaction comparable répond not-supported, sans prix inventé', async ({
    client,
    assert,
  }) => {
    // Une maison de 400 m² : aucun comparable dans la fourchette de surface,
    // à aucun niveau de la cascade.
    const response = await client
      .post('/v1/estimations')
      .json(estimationPayload({ propertyType: 'maison', surface: 400 }))

    response.assertStatus(200)
    const body = response.body()

    assert.equal(body.method.kind, 'not-supported')
    assert.isNull(body.value)
    assert.isTrue(
      body.display.warnings.some((message: string) => /conseiller|comparables/i.test(message))
    )
  })

  test('base sans aucune mutation ⇒ 503 DATA_UNAVAILABLE', async ({ client, assert }) => {
    await db.rawQuery('DELETE FROM mutations')
    EstimationService.clearCache()
    DataVersionService.resetCache()

    const response = await client.post('/v1/estimations').json(estimationPayload())

    response.assertStatus(503)
    assert.equal(response.body().code, 'DATA_UNAVAILABLE')
  })

  test('un not-supported n’est PAS figé 24 h en cache', async ({ client, assert }) => {
    /*
     * ══════════════════════════════════════════════════════════════════════
     * LE COMMENTAIRE LE DISAIT, L'APPEL NE LE FAISAIT PAS.
     * ══════════════════════════════════════════════════════════════════════
     * `responseCache.set()` était inconditionnel. Un dépassement transitoire
     * du `statement_timeout` de 2 s (A.6) — un incident, pas un fait de
     * marché — figeait donc un `not-supported` pendant 24 h pour cette
     * adresse, et le bouton « Relancer le calcul » du front devenait
     * inopérant : il ne pouvait que relire la même réponse en cache.
     *
     * Preuve : on produit un `not-supported` (aucune maison de 400 m² en
     * base), PUIS on rend le calcul possible. La seconde requête, identique,
     * doit repartir du calcul — donc trouver un prix — et non resservir le
     * `not-supported` mis en cache.
     */
    const first = await client
      .post('/v1/estimations')
      .json(estimationPayload({ propertyType: 'maison', surface: 110, rooms: 5 }))

    assert.equal(first.body().method.kind, 'not-supported')

    await seedGueretHouses()

    const second = await client
      .post('/v1/estimations')
      .json(estimationPayload({ propertyType: 'maison', surface: 110, rooms: 5 }))

    assert.equal(
      second.body().method.kind,
      'comparables',
      'la réponse d’échec ne devait pas être mise en cache'
    )

    const rows = await db.rawQuery('SELECT cache_hit FROM estimations_log ORDER BY id ASC')
    assert.isFalse(rows.rows[1].cache_hit)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §2.6 — Cache et quotas
 * ════════════════════════════════════════════════════════════════════════ */

test.group('POST /v1/estimations — cache applicatif (§2.6)', (group) => {
  group.each.setup(async () => {
    await limiter.clear(['memory'])
    await resetEstimationFixtures()
    await seedCommunes()
    await seedReferences()
    await seedDatasetVersion()
    await seedGueretApartments()
  })

  group.each.teardown(async () => {
    await resetEstimationFixtures()
  })

  test('deux requêtes identiques donnent exactement le même résultat', async ({
    client,
    assert,
  }) => {
    const first = await client.post('/v1/estimations').json(estimationPayload())
    const second = await client.post('/v1/estimations').json(estimationPayload())

    assert.equal(first.body().value, second.body().value)
    assert.equal(first.body().range.low, second.body().range.low)
    assert.deepEqual(first.body().comparables, second.body().comparables)
  })

  test('la seconde requête est servie par le cache et le journal le trace', async ({
    client,
    assert,
  }) => {
    await client.post('/v1/estimations').json(estimationPayload())
    await client.post('/v1/estimations').json(estimationPayload())

    const rows = await db.rawQuery('SELECT cache_hit FROM estimations_log ORDER BY id ASC')

    assert.lengthOf(rows.rows, 2)
    assert.isFalse(rows.rows[0].cache_hit)
    assert.isTrue(rows.rows[1].cache_hit)
  })

  test('le requestId reste propre à chaque requête, même servie par le cache', async ({
    client,
    assert,
  }) => {
    const first = await client.post('/v1/estimations').json(estimationPayload())
    const second = await client.post('/v1/estimations').json(estimationPayload())

    // Sinon un incident serait impossible à corréler dans les journaux.
    assert.notEqual(first.body().requestId, second.body().requestId)
  })

  test('une surface d’une autre tranche de 10 m² n’est pas servie par le cache', async ({
    client,
    assert,
  }) => {
    await client.post('/v1/estimations').json(estimationPayload({ surface: 62 }))
    await client.post('/v1/estimations').json(estimationPayload({ surface: 95 }))

    const rows = await db.rawQuery('SELECT cache_hit FROM estimations_log ORDER BY id ASC')
    assert.isFalse(rows.rows[1].cache_hit)
  })

  test('deux surfaces de la MÊME tranche de 10 m² donnent des valeurs différentes', async ({
    client,
    assert,
  }) => {
    /*
     * ══════════════════════════════════════════════════════════════════════
     * SYMÉTRIQUE DU TEST PRÉCÉDENT — C'EST CELUI QUI MANQUAIT.
     * ══════════════════════════════════════════════════════════════════════
     * La clé de cache arrondissait la surface par tranches de 10 m² (§2.6),
     * alors que le §3.7 pose `V = P_ref × k_total × S` : la surface MULTIPLIE
     * le résultat. 62, 65 et 68 m² partageaient donc une clé et recevaient le
     * même prix — un écart de 10 % sur la valeur, servi comme un fait.
     */
    const small = await client.post('/v1/estimations').json(estimationPayload({ surface: 62 }))
    const mid = await client.post('/v1/estimations').json(estimationPayload({ surface: 65 }))
    const large = await client.post('/v1/estimations').json(estimationPayload({ surface: 68 }))

    const values = [small.body().value, mid.body().value, large.body().value]
    assert.isTrue(
      values.every((value) => typeof value === 'number'),
      'les trois requêtes doivent produire un prix'
    )

    // Strictement croissantes : à prix au m² comparable, 68 m² vaut plus que
    // 62 m².
    assert.isAbove(values[1], values[0])
    assert.isAbove(values[2], values[1])

    // Et aucune des trois n'a été servie par le cache.
    const rows = await db.rawQuery('SELECT cache_hit FROM estimations_log ORDER BY id ASC')
    assert.lengthOf(rows.rows, 3)
    assert.isFalse(rows.rows[1].cache_hit)
    assert.isFalse(rows.rows[2].cache_hit)
  })

  test('INVARIANT : value ≈ pricePerSqm × surface, à l’arrondi près', async ({
    client,
    assert,
  }) => {
    /*
     * L'invariant qui aurait suffi, seul, à attraper le bug de cache : le DTO
     * publie `value` ET `pricePerSqm`, et §5.3 définit le second comme
     * `round(value / surface)`. Un lecteur du rapport ou du PDF peut refaire
     * la multiplication de tête ; elle doit tomber juste.
     *
     * Tolérance : `pricePerSqm = round(value / S)` implique exactement
     * |pricePerSqm × S − value| ≤ 0,5 × S.
     */
    for (const surface of [62, 65, 68]) {
      const response = await client.post('/v1/estimations').json(estimationPayload({ surface }))
      const body = response.body()

      assert.isNumber(body.value, `surface ${surface} : un prix est attendu`)
      assert.isNumber(body.pricePerSqm)
      assert.closeTo(
        body.pricePerSqm * surface,
        body.value,
        surface / 2,
        `surface ${surface} : value (${body.value}) et pricePerSqm (${body.pricePerSqm}) ` +
          'doivent être arithmétiquement cohérents'
      )
    }
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * Terrains — §3.2 (cas particuliers) et §3.6
 * ════════════════════════════════════════════════════════════════════════ */

test.group('POST /v1/estimations — terrain (§3.2, §3.6)', (group) => {
  group.each.setup(async () => {
    await limiter.clear(['memory'])
    await resetEstimationFixtures()
    await seedCommunes()
    await seedReferences()
    await seedDatasetVersion()
    await seedGueretApartments()
    await seedGueretHouses()
    await seedGueretTerrains()
  })

  group.each.teardown(async () => {
    await resetEstimationFixtures()
  })

  test('un terrain est estimé par comparaison, pas rejeté en not-supported', async ({
    client,
    assert,
  }) => {
    /*
     * ══════════════════════════════════════════════════════════════════════
     * `mutations_terrain` N'ÉTAIT ALIMENTÉE PAR AUCUN PIPELINE.
     * ══════════════════════════════════════════════════════════════════════
     * `propertyType: 'terrain'` — proposé par le wizard, validé par VineJS,
     * profilé dans la cascade, testé unitairement — échouait donc à 100 %
     * partout en France, avec un message qui invoquait un manque de
     * transactions locales alors qu'aucune transaction de terrain n'avait
     * jamais été ingérée où que ce soit.
     */
    const response = await client.post('/v1/estimations').json(
      estimationPayload({
        propertyType: 'terrain',
        surface: 900,
        rooms: undefined,
      })
    )

    response.assertStatus(200)
    const body = response.body()

    assert.equal(body.method.kind, 'comparables')
    assert.isNumber(body.value)
    assert.isNumber(body.pricePerSqm)
    assert.isAtLeast(body.method.comparablesCount, 5)
    assert.isAtLeast(body.comparables.length, 1)
  })

  test('les seuils du terrain sont divisés par 2 et la tolérance est de ±50 % (§3.2)', async ({
    client,
    assert,
  }) => {
    const response = await client
      .post('/v1/estimations')
      .json(estimationPayload({ propertyType: 'terrain', surface: 900, rooms: undefined }))

    assert.equal(response.body().method.surfaceTolerancePct, 50)
  })

  test('la médiane des terrains alimente V_terrain, à la place du repli de 8 % (§3.6)', async ({
    client,
    assert,
  }) => {
    /*
     * §3.6 : « P_terrain_m2 = médiane des prix/m² des mutations de terrains
     * (table `mutations_terrain`) dans le même périmètre géographique ; à
     * défaut, 8 % de P_ref (valeur de repli, à sourcer/calibrer) ».
     *
     * Tant que la table restait vide, `landPricePerSqm()` rendait toujours
     * `null` : la branche « médiane sourcée » n'était jamais exercée, et le
     * repli forfaitaire était systématique — sans que le rapport le dise.
     *
     * Ici, la médiane des terrains de Guéret est d'environ 52 €/m², tandis que
     * le repli vaudrait 8 % de ~1 250 €/m², soit ~100 €/m². Les deux voies
     * donnent donc des `landValue` nettement distincts.
     */
    const large = await client.post('/v1/estimations').json(
      estimationPayload({
        propertyType: 'maison',
        surface: 100,
        rooms: 4,
        terrainSize: 2_000,
      })
    )
    const standard = await client
      .post('/v1/estimations')
      .json(estimationPayload({ propertyType: 'maison', surface: 100, rooms: 4 }))

    large.assertStatus(200)
    standard.assertStatus(200)
    assert.equal(large.body().method.kind, 'comparables')

    // Sans terrain déclaré, V_terrain vaut 0 (§3.6, dernier point).
    assert.equal(standard.body().method.landValue, 0)

    /*
     * Avec 2 000 m² là où les comparables en ont ~700, l'écart est valorisé.
     * Le prix au m² utilisé est la médiane observée (~52 €/m²), pas le repli
     * forfaitaire de 8 % de P_ref (~100 €/m²) : la valeur est donc nettement
     * inférieure à ce qu'aurait donné le forfait.
     */
    const landValue = large.body().method.landValue
    assert.isAbove(landValue, 0, 'V_terrain doit être valorisé')

    const medianTerrainSurface = 700
    const fallbackRatio = 0.08
    const referencePriceM2 = large.body().method.medianPriceM2Raw
    const fallbackLandValue = fallbackRatio * referencePriceM2 * (2_000 - medianTerrainSurface)

    assert.isBelow(
      landValue,
      fallbackLandValue,
      'la médiane sourcée doit être utilisée, pas le repli forfaitaire du §3.6'
    )
  })
})

test.group('POST /v1/estimations — quotas (§2.6, US-8)', (group) => {
  group.each.setup(async () => {
    await limiter.clear(['memory'])
    await resetEstimationFixtures()
    await seedCommunes()
    await seedReferences()
    await seedGueretApartments()
  })

  group.each.teardown(async () => {
    await resetEstimationFixtures()
  })

  test('la 11e requête d’une même minute renvoie 429 avec Retry-After', async ({
    client,
    assert,
  }) => {
    let limited: Awaited<ReturnType<typeof client.post>> | null = null

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await client
        .post('/v1/estimations')
        .header('X-Forwarded-For', '203.0.113.42')
        // Une surface différente à chaque fois : le cache ne doit pas
        // court-circuiter le compteur de quota.
        .json(estimationPayload({ surface: 40 + attempt * 11 }))

      if (response.status() === 429) {
        limited = response
        break
      }
    }

    assert.isNotNull(limited, 'le quota de 10 req/min devait être atteint')
    if (!limited) return

    const body = limited.body()
    assert.equal(body.code, 'RATE_LIMITED')
    assert.isNumber(body.retryAfter)
    assert.match(body.message, /Trop de requêtes/i)
    assert.equal(Number(limited.headers()['retry-after']), body.retryAfter)
  })
})
