import { test } from '@japa/runner'
import { isOriginAllowed, parseOrigins } from '#config/origins'
import { parseRateLimit } from '#start/limiter'
import { allDvfDepartments, parseDepartments, DEPARTMENTS_WITHOUT_DVF } from '#dvf/importer'
import { assertCsvHeaderMatches, DVF_CSV_COLUMNS, DvfSchemaError } from '#dvf/csv_columns'
import {
  hasDvfCoverage,
  isImportable,
  isInScope,
  normalizeCommuneName,
} from '#services/cog_importer'
import { buildDvfUrl } from '#dvf/downloader'

test.group('CORS | analyse de CORS_ORIGINS (§2.5)', () => {
  test('découpe la liste CSV et normalise la barre finale', ({ assert }) => {
    assert.deepEqual(parseOrigins('https://estimer.co/, http://localhost:4322 '), [
      'https://estimer.co',
      'http://localhost:4322',
    ])
  })

  test('une valeur absente n’autorise aucune origine', ({ assert }) => {
    // Défaut fermé : une variable oubliée ne doit pas ouvrir l'API.
    assert.deepEqual(parseOrigins(undefined), [])
    assert.deepEqual(parseOrigins(''), [])
  })
})

test.group('Rate limiting | analyse des quotas (§2.6)', () => {
  test('lit le format « N/durée »', ({ assert }) => {
    assert.deepEqual(parseRateLimit('10/1 minute', { requests: 1, duration: '1 minute' }), {
      requests: 10,
      duration: '1 minute',
    })
  })

  test('retombe sur la valeur de la spec si la variable est illisible', ({ assert }) => {
    // Une variable mal saisie ne doit jamais désactiver une protection.
    const fallback = { requests: 10, duration: '1 minute' }
    for (const invalid of [undefined, '', 'abc', '0/1 minute', '-5/1 minute', '10/']) {
      assert.deepEqual(parseRateLimit(invalid, fallback), fallback)
    }
  })
})

test.group('DVF | sélection des départements', () => {
  test('« all » exclut les départements sans couverture DVF (§1.3)', ({ assert }) => {
    const all = parseDepartments('all')
    for (const missing of DEPARTMENTS_WITHOUT_DVF) {
      assert.notInclude(all, missing, `${missing} ne devrait jamais être importé`)
    }
  })

  test('la Corse utilise 2A/2B et non 20', ({ assert }) => {
    const all = allDvfDepartments()
    assert.include(all, '2A')
    assert.include(all, '2B')
    assert.notInclude(all, '20')
  })

  test('les DOM couverts par DVF sont inclus (§2.7)', ({ assert }) => {
    const all = allDvfDepartments()
    for (const dom of ['971', '972', '973', '974']) {
      assert.include(all, dom)
    }
    assert.notInclude(all, '976')
  })

  test('accepte une liste et complète les codes à un chiffre', ({ assert }) => {
    assert.deepEqual(parseDepartments('75,23'), ['75', '23'])
    assert.deepEqual(parseDepartments('1'), ['01'])
    assert.deepEqual(parseDepartments('2a'), ['2A'])
  })
})

test.group('DVF | URL de téléchargement', () => {
  test('construit l’URL Etalab attendue', ({ assert }) => {
    // Format vérifié le 2026-08-19 sur files.data.gouv.fr.
    assert.equal(
      buildDvfUrl('https://files.data.gouv.fr/geo-dvf/latest/csv', 2025, '23'),
      'https://files.data.gouv.fr/geo-dvf/latest/csv/2025/departements/23.csv.gz'
    )
  })

  test('tolère une barre finale dans la base', ({ assert }) => {
    assert.equal(
      buildDvfUrl('https://files.data.gouv.fr/geo-dvf/latest/csv/', 2025, '2a'),
      'https://files.data.gouv.fr/geo-dvf/latest/csv/2025/departements/2A.csv.gz'
    )
  })
})

test.group('DVF | garde de schéma CSV', () => {
  test('accepte l’en-tête réel du fichier Etalab', ({ assert }) => {
    assert.doesNotThrow(() => assertCsvHeaderMatches(DVF_CSV_COLUMNS.join(',')))
  })

  test('tolère un BOM et des espaces', ({ assert }) => {
    assert.doesNotThrow(() => assertCsvHeaderMatches('\uFEFF' + DVF_CSV_COLUMNS.join(', ')))
  })

  test('refuse un en-tête au mauvais nombre de colonnes', ({ assert }) => {
    // Mieux vaut un import qui refuse de démarrer qu'un import qui réussit
    // en chargeant des valeurs décalées d'une colonne.
    assert.throws(() => assertCsvHeaderMatches('id_mutation,date_mutation'), DvfSchemaError)
  })

  test('refuse une colonne déplacée', ({ assert }) => {
    const swapped = [...DVF_CSV_COLUMNS]
    ;[swapped[0], swapped[1]] = [swapped[1], swapped[0]]
    assert.throws(() => assertCsvHeaderMatches(swapped.join(',')), DvfSchemaError)
  })
})

test.group('COG | référentiel communal', () => {
  test('normalise les noms pour la recherche floue', ({ assert }) => {
    // Ce qui remplace le matching includes() où « Metz » matchait
    // « Metz-en-Couture ».
    assert.equal(normalizeCommuneName('Saint-Étienne'), 'saint-etienne')
    assert.equal(normalizeCommuneName("L'Abergement-Clémenciat"), "l'abergement-clemenciat")
  })

  test('marque les départements du Livre foncier et Mayotte (§1.3)', ({ assert }) => {
    for (const code of ['57', '67', '68', '976']) {
      assert.isFalse(hasDvfCoverage(code), `${code} ne doit pas être marqué couvert`)
    }
    assert.isTrue(hasDvfCoverage('75'))
    assert.isTrue(hasDvfCoverage('974'))
  })

  test('écarte une commune sans centroïde exploitable', ({ assert }) => {
    assert.isTrue(
      isImportable({
        code: '01001',
        nom: 'Test',
        centre: { type: 'Point', coordinates: [4.9, 46.1] },
      })
    )
    assert.isFalse(isImportable({ code: '01001', nom: 'Test' }))
    assert.isFalse(
      isImportable({ code: 'X', nom: 'Test', centre: { type: 'Point', coordinates: [4.9, 46.1] } })
    )
  })
})

test.group('Origin | garde de production (§2.6, point 3)', () => {
  const allowed = parseOrigins('https://estimer.co,http://localhost:4322')

  test('accepte une origine de la liste', ({ assert }) => {
    assert.isTrue(isOriginAllowed('https://estimer.co', allowed))
    // Une barre finale ne doit pas faire échouer la comparaison.
    assert.isTrue(isOriginAllowed('https://estimer.co/', allowed))
  })

  test('refuse une origine hors liste', ({ assert }) => {
    assert.isFalse(isOriginAllowed('https://exemple-malveillant.test', allowed))
    // Sous-domaine non déclaré : refusé.
    assert.isFalse(isOriginAllowed('https://evil.estimer.co', allowed))
  })

  test('refuse une requête sans Origin (cURL, intégration sauvage)', ({ assert }) => {
    assert.isFalse(isOriginAllowed(undefined, allowed))
    assert.isFalse(isOriginAllowed('', allowed))
    assert.isFalse(isOriginAllowed('   ', allowed))
  })

  test('une liste blanche vide n’autorise rien', ({ assert }) => {
    assert.isFalse(isOriginAllowed('https://estimer.co', []))
  })
})

test.group('COG | périmètre géographique (§2.7)', () => {
  const commune = (codeDepartement: string, code = '01001') => ({
    code,
    nom: 'Test',
    codeDepartement,
  })

  test('retient la métropole, la Corse et les DOM du périmètre', ({ assert }) => {
    for (const dep of ['01', '75', '2A', '2B', '95', '971', '972', '973', '974']) {
      assert.isTrue(isInScope(commune(dep)), `${dep} doit être dans le périmètre`)
    }
  })

  test('retient Mayotte, qui doit porter has_dvf = false (§1.3)', ({ assert }) => {
    assert.isTrue(isInScope(commune('976')))
  })

  test('écarte les collectivités d’outre-mer hors périmètre', ({ assert }) => {
    /*
     * Ces territoires portent un code de région à 3 caractères, incompatible
     * avec `communes.code_region char(2)` (§5.1) : les laisser passer faisait
     * échouer l'import en cours de route.
     */
    for (const dep of ['975', '977', '978', '984', '986', '987', '988', '989']) {
      assert.isFalse(isInScope(commune(dep)), `${dep} doit être écarté`)
    }
  })
})
