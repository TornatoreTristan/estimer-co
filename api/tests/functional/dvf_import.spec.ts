import { test } from '@japa/runner'
import pg from 'pg'
import env from '#start/env'
import { DVF_RULES_VERSION, DvfImporter, type ImportOptions } from '#dvf/importer'
import { buildDvfUrl } from '#dvf/downloader'
import { FakeDvfSource } from '#tests/helpers/fake_dvf_source'
import { dvfRow, toCsv } from '#tests/helpers/dvf_fixtures'

/**
 * Ingestion DVF de bout en bout — US-7.
 *
 * Couvre le chemin réel de production (COPY en staging, transformation
 * set-based, upsert, partitions) **sans réseau** : le fichier est servi
 * gzippé par `FakeDvfSource`.
 */

const BASE_URL = 'https://dvf.test/csv'
const YEAR = 2025
const DEP = '23'
const URL = buildDvfUrl(BASE_URL, YEAR, DEP)

function newClient() {
  return new pg.Client({
    host: env.get('DB_HOST'),
    port: env.get('DB_PORT'),
    user: env.get('DB_USER'),
    password: env.get('DB_PASSWORD'),
    database: env.get('DB_DATABASE'),
  })
}

/** Jeu de lignes couvrant les cas décisifs de l'Annexe A.1 et A.2. */
function sampleCsv(): string {
  return toCsv([
    // Maison + parcelle de landes : 2 lignes, 1 vente à 119 500 €.
    dvfRow({ id_mutation: 'M1', valeur_fonciere: '119500', surface_reelle_bati: '66' }),
    dvfRow({
      id_mutation: 'M1',
      valeur_fonciere: '119500',
      type_local: '',
      code_type_local: '',
      surface_reelle_bati: '',
      nombre_pieces_principales: '',
      id_parcelle: '231030000A1167',
      surface_terrain: '666',
    }),

    // Appartement + cave + parking : CONSERVÉ (Annexe A.1).
    dvfRow({
      id_mutation: 'M2',
      type_local: 'Appartement',
      code_type_local: '2',
      surface_reelle_bati: '65',
      nombre_pieces_principales: '3',
      valeur_fonciere: '300000',
      adresse_numero: '12',
      adresse_nom_voie: 'RUE DE LA PAIX',
    }),
    dvfRow({
      id_mutation: 'M2',
      type_local: 'Dépendance',
      code_type_local: '3',
      surface_reelle_bati: '',
      nombre_pieces_principales: '',
      id_parcelle: 'CAVE',
      valeur_fonciere: '300000',
    }),

    // Multi-type : REJETÉ.
    dvfRow({
      id_mutation: 'M3',
      type_local: 'Maison',
      code_type_local: '1',
      surface_reelle_bati: '90',
    }),
    dvfRow({
      id_mutation: 'M3',
      type_local: 'Appartement',
      code_type_local: '2',
      surface_reelle_bati: '50',
      id_parcelle: 'AUTRE',
    }),

    // Échange : REJETÉ.
    dvfRow({ id_mutation: 'M4', nature_mutation: 'Echange' }),

    // Cession symbolique : conservée, MARQUÉE aberrante (Annexe A.2).
    dvfRow({ id_mutation: 'M5', valeur_fonciere: '1' }),
  ])
}

function optionsFor(source: FakeDvfSource, overrides: Partial<ImportOptions> = {}): ImportOptions {
  return {
    annee: YEAR,
    departements: [DEP],
    baseUrl: BASE_URL,
    dryRun: false,
    force: false,
    source,
    ...overrides,
  }
}

test.group('DVF | import de bout en bout', (group) => {
  let client: pg.Client
  let importer: DvfImporter

  group.each.setup(async () => {
    client = newClient()
    await client.connect()
    importer = new DvfImporter(client)
    await importer.ensureHelpers()

    // Table non tronquée par la transaction de test : on nettoie explicitement.
    await client.query('DELETE FROM mutations')
    await client.query('DELETE FROM mutations_terrain')
    await client.query('DELETE FROM dvf_imports')

    return async () => {
      await client.query('DELETE FROM mutations').catch(() => undefined)
      await client.query('DELETE FROM mutations_terrain').catch(() => undefined)
      await client.query('DELETE FROM dvf_imports').catch(() => undefined)
      await client.end().catch(() => undefined)
    }
  })

  test('import initial : les mutations exploitables sont insérées', async ({ assert }) => {
    const source = new FakeDvfSource()
    source.register(URL, sampleCsv())

    const result = await importer.importDepartment(DEP, optionsFor(source))

    assert.equal(result.status, 'success', result.error)
    assert.equal(result.rowsRead, 8, '8 lignes de données dans le CSV')
    assert.equal(result.mutationsSeen, 5, '5 mutations distinctes')

    // M1, M2, M5 conservées ; M3 (multi-type) et M4 (échange) rejetées.
    assert.equal(result.rowsKept, 3)
    assert.equal(result.rowsInserted, 3)
    assert.equal(result.rowsUpdated, 0)
    assert.deepEqual(result.rejectedCounts, { multi_type: 1, nature_non_vente: 1 })

    const rows = await client.query(
      'SELECT id_mutation, valeur_fonciere, surface_bati, prix_m2, is_outlier, exclusion_reason, ' +
        'nb_locaux, nb_dependances, adresse_voie, surface_terrain ' +
        'FROM mutations ORDER BY id_mutation'
    )
    assert.lengthOf(rows.rows, 3)

    const [m1, m2, m5] = rows.rows

    // La valeur foncière n'a PAS été doublée par la seconde ligne.
    assert.equal(Number(m1.valeur_fonciere), 119_500)
    assert.equal(m1.surface_bati, 66)
    assert.closeTo(Number(m1.prix_m2), 119_500 / 66, 0.01)
    assert.equal(m1.surface_terrain, 726)

    // L'appartement conserve sa seule surface ; la cave est tracée.
    assert.equal(m2.surface_bati, 65)
    assert.equal(m2.nb_locaux, 1)
    assert.equal(m2.nb_dependances, 1)
    // §8.3 : aucun numéro de voie en base.
    assert.equal(m2.adresse_voie, 'Rue De La Paix')
    assert.notInclude(String(m2.adresse_voie), '12')

    // L'aberrant est conservé, marqué, jamais supprimé (Annexe A.2).
    assert.isTrue(m5.is_outlier)
    assert.equal(m5.exclusion_reason, 'valeur_symbolique')
  })

  test('rejeu du même import : nombre de lignes identique, aucun doublon (US-7)', async ({
    assert,
  }) => {
    const source = new FakeDvfSource()
    source.register(URL, sampleCsv())

    await importer.importDepartment(DEP, optionsFor(source))

    const first = await client.query('SELECT count(*)::int AS total FROM mutations')

    // `--force` pour contourner le court-circuit ETag et exercer réellement
    // l'upsert : c'est lui qui doit garantir l'idempotence.
    const second = await importer.importDepartment(DEP, optionsFor(source, { force: true }))

    const after = await client.query('SELECT count(*)::int AS total FROM mutations')

    assert.equal(second.status, 'success')
    assert.equal(after.rows[0].total, first.rows[0].total, 'le nombre de lignes doit être stable')
    assert.equal(second.rowsInserted, 0, 'aucune insertion au rejeu')
    assert.equal(second.rowsUpdated, 3, 'les 3 mutations sont mises à jour en place')

    const duplicates = await client.query(
      'SELECT dedup_key FROM mutations GROUP BY dedup_key, date_mutation HAVING count(*) > 1'
    )
    assert.lengthOf(duplicates.rows, 0, 'aucune mutation dupliquée')
  })

  test('un fichier déjà ingéré est ignoré sans être retéléchargé', async ({ assert }) => {
    const source = new FakeDvfSource()
    source.register(URL, sampleCsv())

    await importer.importDepartment(DEP, optionsFor(source))

    const metadata = await source.head(URL)
    await client.query(
      `INSERT INTO dvf_imports (source_url, annee, code_departement, etag, sha256,
                                status, rules_version, finished_at)
       VALUES ($1, $2, $3, $4, $5, 'success', $6, now())`,
      [URL, YEAR, DEP, metadata.etag, null, DVF_RULES_VERSION]
    )

    const opensBefore = source.opens
    const result = await importer.importDepartment(DEP, optionsFor(source))

    assert.equal(result.status, 'skipped')
    assert.equal(source.opens, opensBefore, 'aucun téléchargement du corps du fichier')
  })

  test('--dry-run n’écrit rien en base (US-7)', async ({ assert }) => {
    const source = new FakeDvfSource()
    source.register(URL, sampleCsv())

    const result = await importer.importDepartment(DEP, optionsFor(source, { dryRun: true }))

    assert.equal(result.status, 'dry-run')
    // Le rapport de comptage est bien produit…
    assert.equal(result.mutationsSeen, 5)
    assert.equal(result.rowsKept, 3)
    assert.deepEqual(result.rejectedCounts, { multi_type: 1, nature_non_vente: 1 })

    // … mais rien n'est écrit.
    const count = await client.query('SELECT count(*)::int AS total FROM mutations')
    assert.equal(count.rows[0].total, 0)

    const staging = await client.query('SELECT count(*)::int AS total FROM mutations_staging')
    assert.equal(staging.rows[0].total, 0, 'le staging est également annulé')
  })

  test('un en-tête CSV inattendu fait échouer l’import au lieu de décaler les colonnes', async ({
    assert,
  }) => {
    const source = new FakeDvfSource()
    source.register(URL, 'colonne_a,colonne_b\n1,2\n')

    const result = await importer.importDepartment(DEP, optionsFor(source))

    assert.equal(result.status, 'failed')
    assert.include(result.error ?? '', 'colonnes')

    const count = await client.query('SELECT count(*)::int AS total FROM mutations')
    assert.equal(count.rows[0].total, 0)
  })

  test('la partition annuelle est créée à la demande', async ({ assert }) => {
    const source = new FakeDvfSource()
    source.register(URL, sampleCsv())

    await importer.importDepartment(DEP, optionsFor(source))

    const partition = await client.query(
      `SELECT relname FROM pg_class WHERE relname = 'mutations_y2025'`
    )
    assert.lengthOf(partition.rows, 1)

    // Les lignes atterrissent bien dans la partition de leur année.
    const inPartition = await client.query('SELECT count(*)::int AS total FROM mutations_y2025')
    assert.equal(inPartition.rows[0].total, 3)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * Terrains nus — §5.1, table `mutations_terrain`
 * ════════════════════════════════════════════════════════════════════════ */

/** Une ligne de terrain nu : aucun local, une parcelle en nature « sols ». */
function terrainRow(overrides: Partial<Record<string, string>> = {}) {
  return dvfRow({
    type_local: '',
    code_type_local: '',
    surface_reelle_bati: '',
    nombre_pieces_principales: '',
    code_nature_culture: 'S',
    nature_culture: 'sols',
    ...overrides,
  })
}

test.group('DVF | ingestion des terrains nus (§5.1)', (group) => {
  let client: pg.Client
  let importer: DvfImporter

  group.each.setup(async () => {
    client = newClient()
    await client.connect()
    importer = new DvfImporter(client)
    await importer.ensureHelpers()

    await client.query('DELETE FROM mutations')
    await client.query('DELETE FROM mutations_terrain')
    await client.query('DELETE FROM dvf_imports')

    return async () => {
      await client.query('DELETE FROM mutations').catch(() => undefined)
      await client.query('DELETE FROM mutations_terrain').catch(() => undefined)
      await client.query('DELETE FROM dvf_imports').catch(() => undefined)
      await client.end().catch(() => undefined)
    }
  })

  test('une vente de terrain nu alimente mutations_terrain', async ({ assert }) => {
    /*
     * Le Lot 1 avait créé la table sans jamais l'alimenter. Conséquences :
     * `propertyType: 'terrain'` échouait à 100 % partout en France avec un
     * message trompeur, et `landPricePerSqm()` rendait toujours `null`, donc
     * le repli forfaitaire de 8 % du §3.6 était systématique.
     */
    const source = new FakeDvfSource()
    source.register(
      URL,
      toCsv([
        terrainRow({
          id_mutation: 'T1',
          valeur_fonciere: '45000',
          surface_terrain: '900',
          id_parcelle: 'PARC-T1',
        }),
      ])
    )

    const result = await importer.importDepartment(DEP, optionsFor(source))

    assert.equal(result.status, 'success', result.error)
    assert.equal(result.rowsKept, 0, 'aucun bâti dans ce fichier')
    assert.equal(result.terrainKept, 1)
    assert.equal(result.terrainInserted, 1)

    const rows = await client.query(
      'SELECT id_mutation, type_local, surface_bati, surface_terrain, prix_m2, is_outlier ' +
        'FROM mutations_terrain'
    )

    assert.lengthOf(rows.rows, 1)
    // §5.1 : « type_local = 'terrain', surface_bati NULL, prix_m2 calculé sur
    // surface_terrain ».
    assert.equal(rows.rows[0].type_local, 'terrain')
    assert.isNull(rows.rows[0].surface_bati)
    assert.equal(rows.rows[0].surface_terrain, 900)
    assert.equal(Number(rows.rows[0].prix_m2), 50, '45 000 € / 900 m²')
    assert.isFalse(rows.rows[0].is_outlier)
  })

  test('une maison avec jardin n’est PAS réingérée comme un terrain', async ({ assert }) => {
    /*
     * C'est le risque central de cette table : la valeur foncière d'une
     * maison inclut déjà son terrain (§3.6). La compter une seconde fois
     * comme prix de terrain ferait passer un prix de maison — plusieurs
     * centaines d'euros le m² — pour un prix de parcelle.
     */
    const source = new FakeDvfSource()
    source.register(
      URL,
      toCsv([
        dvfRow({ id_mutation: 'H1', valeur_fonciere: '119500', surface_reelle_bati: '66' }),
        dvfRow({
          id_mutation: 'H1',
          valeur_fonciere: '119500',
          type_local: '',
          code_type_local: '',
          surface_reelle_bati: '',
          nombre_pieces_principales: '',
          id_parcelle: 'JARDIN',
          surface_terrain: '800',
        }),
      ])
    )

    const result = await importer.importDepartment(DEP, optionsFor(source))

    assert.equal(result.status, 'success', result.error)
    assert.equal(result.rowsKept, 1, 'la maison est bien ingérée')
    assert.equal(result.terrainKept, 0, 'et PAS une seconde fois comme terrain')

    const terrains = await client.query('SELECT count(*)::int AS total FROM mutations_terrain')
    assert.equal(terrains.rows[0].total, 0)
  })

  test('un garage vendu seul n’est pas un terrain', async ({ assert }) => {
    // Le €/m² de sa parcelle n'a aucun sens comme prix de terrain.
    const source = new FakeDvfSource()
    source.register(
      URL,
      toCsv([
        terrainRow({
          id_mutation: 'G1',
          type_local: 'Dépendance',
          code_type_local: '3',
          valeur_fonciere: '15000',
          surface_terrain: '30',
        }),
      ])
    )

    const result = await importer.importDepartment(DEP, optionsFor(source))

    assert.equal(result.status, 'success', result.error)
    assert.equal(result.terrainKept, 0)
  })

  test('une terre agricole est écartée du prix du terrain à bâtir', async ({ assert }) => {
    /*
     * Choix d'ingestion assumé, commenté dans `dvf_transform.ts` : une terre
     * (`code_nature_culture = 'T'`) se vend 0,50 à 2 €/m², un terrain à bâtir
     * 30 à 300 €/m². Mêler les deux produirait une médiane communale
     * d'environ 1 €/m², qui servirait ensuite à valoriser le jardin d'une
     * maison (§3.6) — c'est-à-dire à ne le valoriser pas du tout, et bien en
     * dessous du repli forfaitaire qu'elle remplacerait.
     */
    const source = new FakeDvfSource()
    source.register(
      URL,
      toCsv([
        terrainRow({
          id_mutation: 'A1',
          code_nature_culture: 'T',
          nature_culture: 'terres',
          valeur_fonciere: '20000',
          surface_terrain: '20000',
          id_parcelle: 'CHAMP',
        }),
      ])
    )

    const result = await importer.importDepartment(DEP, optionsFor(source))

    assert.equal(result.status, 'success', result.error)
    assert.equal(result.terrainKept, 0)
  })

  test('une vente 100 % agricole n’est plus comptée en « surface_absente »', async ({ assert }) => {
    /*
     * Elle a une surface, et parfaitement lisible : 20 000 m². La rejeter en
     * `surface_absente` rendait le compteur de rejets inutilisable pour le
     * pilotage qualité — impossible d'y distinguer « le fichier source n'a pas
     * de surface » (un problème de données, à investiguer) de « cette vente
     * n'est pas du terrain à bâtir » (une décision de périmètre, attendue et
     * massive en zone rurale).
     */
    const source = new FakeDvfSource()
    source.register(
      URL,
      toCsv([
        terrainRow({
          id_mutation: 'AGRI',
          code_nature_culture: 'T',
          nature_culture: 'terres',
          valeur_fonciere: '20000',
          surface_terrain: '20000',
          id_parcelle: 'CHAMP',
        }),
      ])
    )

    const result = await importer.importDepartment(DEP, optionsFor(source))

    assert.equal(result.status, 'success', result.error)
    assert.equal(result.terrainKept, 0, 'toujours écartée du terrain à bâtir')
    assert.equal(result.terrainRejected, 1)
    assert.deepEqual(result.terrainRejectedCounts, { nature_culture_non_retenue: 1 })
    assert.notProperty(
      result.terrainRejectedCounts,
      'surface_absente',
      'la surface est là, et parfaitement lisible : 20 000 m²'
    )
  })

  test('un terrain à parcelles mixtes est marqué « terrain_mixte », pas amputé', async ({
    assert,
  }) => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * BIAIS HAUSSIER SYSTÉMATIQUE — le défaut corrigé.
     * ═══════════════════════════════════════════════════════════════════════
     * L'ancienne règle ne sommait que les parcelles `'' | 'S'` mais gardait
     * `valeur_fonciere`, qui couvre TOUTE la vente :
     *
     *   800 m² 'S' + 20 000 m² 'T', vendus 120 000 €
     *     → surface_terrain = 800, exclusion_reason = NULL, prix_m2 = 150 €/m²
     *
     * Non marquée, dans les bornes, donc incluse dans la médiane des
     * terrains — celle qui sert à `propertyType: 'terrain'` ET à la
     * valorisation du jardin du §3.6. Sur un marché rural, le lot « terrain à
     * bâtir + terres » est courant.
     */
    const source = new FakeDvfSource()
    source.register(
      URL,
      toCsv([
        terrainRow({
          id_mutation: 'MIXTE',
          valeur_fonciere: '120000',
          code_nature_culture: 'S',
          nature_culture: 'sols',
          surface_terrain: '800',
          id_parcelle: 'PARC-SOL',
        }),
        terrainRow({
          id_mutation: 'MIXTE',
          valeur_fonciere: '120000',
          code_nature_culture: 'T',
          nature_culture: 'terres',
          surface_terrain: '20000',
          id_parcelle: 'PARC-TERRES',
        }),
      ])
    )

    const result = await importer.importDepartment(DEP, optionsFor(source))

    assert.equal(result.status, 'success', result.error)
    // A.2 : conservée et marquée, jamais supprimée.
    assert.equal(result.terrainKept, 1)
    assert.equal(result.terrainOutliers, 1)

    const rows = await client.query(
      'SELECT surface_terrain, prix_m2, is_outlier, exclusion_reason, nb_locaux ' +
        'FROM mutations_terrain WHERE id_mutation = $1',
      ['MIXTE']
    )

    assert.lengthOf(rows.rows, 1)
    const [mixte] = rows.rows

    assert.isTrue(mixte.is_outlier)
    assert.equal(mixte.exclusion_reason, 'terrain_mixte')
    // Le dénominateur n'est plus amputé : numérateur et dénominateur portent
    // enfin sur le même périmètre.
    assert.equal(mixte.surface_terrain, 20_800, '800 m² de sols + 20 000 m² de terres')
    assert.closeTo(Number(mixte.prix_m2), 120_000 / 20_800, 0.01)
    assert.notEqual(Number(mixte.prix_m2), 150, 'le 150 €/m² fantôme de l’ancienne règle')
    assert.equal(mixte.nb_locaux, 2, 'les deux parcelles sont tracées')
  })

  test('un terrain mixte n’entre pas dans la médiane communale des terrains', async ({
    assert,
  }) => {
    // C'est la seule chose qui compte vraiment : la médiane servie au §3.6
    // et à `propertyType: 'terrain'` ne doit pas voir cette vente.
    const source = new FakeDvfSource()
    source.register(
      URL,
      toCsv([
        // Un vrai terrain à bâtir : 45 000 € / 900 m² = 50 €/m².
        terrainRow({
          id_mutation: 'PUR',
          valeur_fonciere: '45000',
          surface_terrain: '900',
          id_parcelle: 'PARC-PUR',
        }),
        // Le lot mixte, qui valait 150 €/m² sous l'ancienne règle.
        terrainRow({
          id_mutation: 'MIX',
          valeur_fonciere: '120000',
          surface_terrain: '800',
          id_parcelle: 'MIX-SOL',
        }),
        terrainRow({
          id_mutation: 'MIX',
          valeur_fonciere: '120000',
          code_nature_culture: 'T',
          nature_culture: 'terres',
          surface_terrain: '20000',
          id_parcelle: 'MIX-TERRES',
        }),
      ])
    )

    await importer.importDepartment(DEP, optionsFor(source))

    const median = await client.query<{ median: string | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY prix_m2)::double precision AS median
         FROM mutations_terrain
        WHERE is_outlier = false AND prix_m2 IS NOT NULL`
    )

    assert.equal(
      Number(median.rows[0].median),
      50,
      'la médiane ne retient que le terrain à bâtir homogène'
    )
  })

  test('un lot 100 % en nature « sols » reste parfaitement exploitable', async ({ assert }) => {
    // Contrôle négatif : la nouvelle règle ne doit pas écarter les ventes
    // multi-parcelles homogènes, qui sont le cas courant d'un terrain à bâtir
    // issu d'une division.
    const source = new FakeDvfSource()
    source.register(
      URL,
      toCsv([
        terrainRow({
          id_mutation: 'DIVISION',
          valeur_fonciere: '60000',
          surface_terrain: '600',
          id_parcelle: 'LOT-A',
        }),
        terrainRow({
          id_mutation: 'DIVISION',
          valeur_fonciere: '60000',
          code_nature_culture: '',
          nature_culture: '',
          surface_terrain: '600',
          id_parcelle: 'LOT-B',
        }),
      ])
    )

    const result = await importer.importDepartment(DEP, optionsFor(source))

    assert.equal(result.status, 'success', result.error)
    assert.equal(result.terrainKept, 1)
    assert.equal(result.terrainOutliers, 0)

    const rows = await client.query(
      'SELECT surface_terrain, exclusion_reason FROM mutations_terrain WHERE id_mutation = $1',
      ['DIVISION']
    )
    assert.equal(rows.rows[0].surface_terrain, 1200)
    assert.isNull(rows.rows[0].exclusion_reason)
  })

  test('le rejeu est idempotent sur les terrains aussi (US-7)', async ({ assert }) => {
    const source = new FakeDvfSource()
    source.register(
      URL,
      toCsv([
        terrainRow({
          id_mutation: 'T2',
          valeur_fonciere: '45000',
          surface_terrain: '900',
          id_parcelle: 'PARC-T2',
        }),
      ])
    )

    await importer.importDepartment(DEP, optionsFor(source))
    const second = await importer.importDepartment(DEP, optionsFor(source, { force: true }))

    assert.equal(second.terrainInserted, 0, 'aucune insertion au rejeu')
    assert.equal(second.terrainUpdated, 1, 'la ligne est mise à jour en place')

    const total = await client.query('SELECT count(*)::int AS total FROM mutations_terrain')
    assert.equal(total.rows[0].total, 1)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * Lignes obsolètes au ré-import — Annexe A.2 et A.7
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Insère une mutation « héritée » : écrite par un import ANTÉRIEUR, donc avec
 * un `imported_at` dans le passé. C'est exactement la forme que prend en base
 * une ligne produite par une règle d'ingestion depuis corrigée.
 */
async function insertLegacyMutation(
  client: pg.Client,
  options: {
    table?: 'mutations' | 'mutations_terrain'
    idMutation: string
    dateMutation: string
    sourceAnnee: number
    codeDepartement?: string
    codeInsee?: string
    typeLocal?: string
    valeurFonciere?: number
    surfaceBati?: number | null
    surfaceTerrain?: number
  }
) {
  const table = options.table ?? 'mutations'
  const year = Number(options.dateMutation.slice(0, 4))
  await client.query('SELECT ensure_annual_partition($1, $2)', [table, year])

  await client.query(
    `INSERT INTO ${table} (
       dedup_key, id_mutation, date_mutation, nature_mutation, valeur_fonciere,
       type_local, surface_bati, surface_terrain,
       code_insee, code_departement, longitude, latitude, geom,
       source_annee, imported_at
     ) VALUES (
       -- \`$1::text::bytea\` et non \`$1::bytea\` : PostgreSQL résout le type
       -- d'un paramètre sur sa PREMIÈRE occurrence. Sans le \`::text\`
       -- intermédiaire, $1 était inféré \`bytea\`, et \`id_mutation\` recevait
       -- la représentation hexadécimale ('\\x414e…') au lieu du libellé.
       encode(sha256($1::text::bytea), 'hex')::char(64), $1, $2::date, 'Vente', $3,
       $4, $5, $6,
       $7, $8, 1.588795, 46.349388,
       ST_SetSRID(ST_MakePoint(1.588795, 46.349388), 4326)::geography,
       $9, now() - interval '30 days'
     )`,
    [
      options.idMutation,
      options.dateMutation,
      options.valeurFonciere ?? 100_000,
      options.typeLocal ?? (table === 'mutations' ? 'maison' : 'terrain'),
      options.surfaceBati === undefined ? 100 : options.surfaceBati,
      options.surfaceTerrain ?? 0,
      options.codeInsee ?? '23103',
      options.codeDepartement ?? DEP,
      options.sourceAnnee,
    ]
  )
}

async function exclusionOf(client: pg.Client, idMutation: string, table = 'mutations') {
  const row = await client.query(
    `SELECT is_outlier, exclusion_reason FROM ${table} WHERE id_mutation = $1`,
    [idMutation]
  )
  return row.rows[0] as { is_outlier: boolean; exclusion_reason: string | null } | undefined
}

test.group('DVF | marquage des lignes obsolètes (Annexe A.2)', (group) => {
  let client: pg.Client
  let importer: DvfImporter

  group.each.setup(async () => {
    client = newClient()
    await client.connect()
    importer = new DvfImporter(client)
    await importer.ensureHelpers()

    await client.query('DELETE FROM mutations')
    await client.query('DELETE FROM mutations_terrain')
    await client.query('DELETE FROM dvf_imports')

    return async () => {
      await client.query('DELETE FROM mutations').catch(() => undefined)
      await client.query('DELETE FROM mutations_terrain').catch(() => undefined)
      await client.query('DELETE FROM dvf_imports').catch(() => undefined)
      await client.end().catch(() => undefined)
    }
  })

  test('une ligne héritée qu’un ré-import ne réécrit pas est marquée stale_reimport', async ({
    assert,
  }) => {
    /*
     * Le scénario réel : une règle d'ingestion est corrigée, la mutation
     * qu'elle produisait n'est plus retenue. Sans marquage, cette ligne reste
     * `is_outlier = false` et continue d'entrer dans les médianes — mesuré à
     * +149 % sur une médiane communale de la Creuse.
     */
    await insertLegacyMutation(client, {
      idMutation: 'ANCIENNE-REGLE',
      dateMutation: '2025-03-04',
      sourceAnnee: YEAR,
    })

    const source = new FakeDvfSource()
    source.register(URL, sampleCsv())

    const result = await importer.importDepartment(DEP, optionsFor(source))

    assert.equal(result.status, 'success', result.error)
    assert.equal(result.rowsStaleMarked, 1)

    const stale = await exclusionOf(client, 'ANCIENNE-REGLE')
    assert.isTrue(stale?.is_outlier)
    assert.equal(stale?.exclusion_reason, 'stale_reimport')

    // Les mutations effectivement réécrites par cet import ne sont PAS
    // touchées : elles portent `imported_at = now()` de la transaction.
    const fresh = await exclusionOf(client, 'M1')
    assert.isFalse(fresh?.is_outlier)
    assert.isNull(fresh?.exclusion_reason)
  })

  test('le périmètre inclut source_annee : les autres millésimes sont protégés', async ({
    assert,
  }) => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * LE TEST LE PLUS IMPORTANT DE CE FICHIER.
     * ═══════════════════════════════════════════════════════════════════════
     * `mutations` accumule plusieurs millésimes de fichiers DVF pour un même
     * département. Un marquage limité au seul `code_departement` — sans
     * `source_annee` — mettrait `is_outlier = true` sur TOUTES les mutations
     * 2019 à 2024 du département à chaque import de 2025. Le correctif ferait
     * alors bien plus de dégâts que le bug qu'il corrige : il viderait
     * l'historique de la base au premier ré-import de routine.
     */
    // Millésimes antérieurs, même département : intouchables.
    await insertLegacyMutation(client, {
      idMutation: 'MILLESIME-2023',
      dateMutation: '2023-05-10',
      sourceAnnee: 2023,
    })
    await insertLegacyMutation(client, {
      idMutation: 'MILLESIME-2024',
      dateMutation: '2024-05-10',
      sourceAnnee: 2024,
    })
    // Même millésime que l'import : celle-ci DOIT être marquée.
    await insertLegacyMutation(client, {
      idMutation: 'MILLESIME-2025',
      dateMutation: '2025-05-10',
      sourceAnnee: YEAR,
    })
    // Millésime importé, mais AUTRE département : hors périmètre.
    await insertLegacyMutation(client, {
      idMutation: 'AUTRE-DEP',
      dateMutation: '2025-05-10',
      sourceAnnee: YEAR,
      codeDepartement: '19',
      codeInsee: '19031',
    })

    const source = new FakeDvfSource()
    source.register(URL, sampleCsv())

    const result = await importer.importDepartment(DEP, optionsFor(source))

    assert.equal(result.status, 'success', result.error)
    assert.equal(result.rowsStaleMarked, 1, 'seule la ligne 2025 du département 23 est marquée')

    for (const id of ['MILLESIME-2023', 'MILLESIME-2024', 'AUTRE-DEP']) {
      const row = await exclusionOf(client, id)
      assert.isFalse(row?.is_outlier, `${id} ne doit pas être marquée obsolète`)
      assert.isNull(row?.exclusion_reason, `${id} ne doit pas être marquée obsolète`)
    }

    const marked = await exclusionOf(client, 'MILLESIME-2025')
    assert.equal(marked?.exclusion_reason, 'stale_reimport')
  })

  test('le marquage est auto-réparateur : une ligne redevenue légitime le perd', async ({
    assert,
  }) => {
    /*
     * `INSERT_MUTATIONS_SQL` fait `exclusion_reason = EXCLUDED.exclusion_reason`
     * au `ON CONFLICT`. Un marquage n'est donc jamais définitif : si la règle
     * est de nouveau corrigée et que la mutation redevient valide, le
     * ré-import suivant efface la marque. A.2 reste respectée — on n'a rien
     * supprimé, on a seulement (dé)marqué.
     */
    const source = new FakeDvfSource()
    source.register(URL, sampleCsv())
    await importer.importDepartment(DEP, optionsFor(source))

    // Un import qui ne contient plus M1 : elle est marquée obsolète.
    const shrunk = new FakeDvfSource()
    shrunk.register(
      URL,
      toCsv([dvfRow({ id_mutation: 'M2', type_local: 'Appartement', code_type_local: '2' })])
    )
    const second = await importer.importDepartment(DEP, optionsFor(shrunk, { force: true }))
    assert.isAtLeast(second.rowsStaleMarked, 1)
    const marked = await exclusionOf(client, 'M1')
    assert.equal(marked?.exclusion_reason, 'stale_reimport')

    // M1 revient dans le fichier : la marque doit disparaître.
    const third = await importer.importDepartment(DEP, optionsFor(source, { force: true }))
    assert.equal(third.status, 'success', third.error)

    const repaired = await exclusionOf(client, 'M1')
    assert.isFalse(repaired?.is_outlier, 'la ligne redevenue légitime perd son marquage')
    assert.isNull(repaired?.exclusion_reason)
  })

  test('mutations_terrain reçoit le même traitement (§5.1)', async ({ assert }) => {
    await insertLegacyMutation(client, {
      table: 'mutations_terrain',
      idMutation: 'TERRAIN-ANCIEN',
      dateMutation: '2025-03-04',
      sourceAnnee: YEAR,
      typeLocal: 'terrain',
      surfaceBati: null,
      surfaceTerrain: 1200,
    })
    await insertLegacyMutation(client, {
      table: 'mutations_terrain',
      idMutation: 'TERRAIN-2024',
      dateMutation: '2024-03-04',
      sourceAnnee: 2024,
      typeLocal: 'terrain',
      surfaceBati: null,
      surfaceTerrain: 1200,
    })

    const source = new FakeDvfSource()
    source.register(URL, sampleCsv())
    const result = await importer.importDepartment(DEP, optionsFor(source))

    assert.equal(result.status, 'success', result.error)
    assert.equal(result.terrainStaleMarked, 1)

    const ancien = await exclusionOf(client, 'TERRAIN-ANCIEN', 'mutations_terrain')
    assert.equal(ancien?.exclusion_reason, 'stale_reimport')

    const protege = await exclusionOf(client, 'TERRAIN-2024', 'mutations_terrain')
    assert.isNull(protege?.exclusion_reason, 'le millésime 2024 des terrains est protégé lui aussi')
  })

  test('un ré-import à l’identique ne marque rien', async ({ assert }) => {
    // Le compteur doit rester un SIGNAL : s'il montait à chaque rejeu de
    // routine, plus personne ne le regarderait.
    const source = new FakeDvfSource()
    source.register(URL, sampleCsv())

    await importer.importDepartment(DEP, optionsFor(source))
    const second = await importer.importDepartment(DEP, optionsFor(source, { force: true }))

    assert.equal(second.status, 'success', second.error)
    assert.equal(second.rowsStaleMarked, 0)
    assert.equal(second.terrainStaleMarked, 0)
  })

  test('un changement de version des règles invalide le court-circuit d’idempotence', async ({
    assert,
  }) => {
    /*
     * Sans cette clause, le correctif ci-dessus serait inopérant : le fichier
     * ayant le même sha256, l'import serait *skippé* et le marquage n'aurait
     * jamais lieu. C'est ce qui rendait `--force` indispensable — et donc
     * facile à oublier.
     */
    const source = new FakeDvfSource()
    source.register(URL, sampleCsv())
    const metadata = await source.head(URL)

    await client.query(
      `INSERT INTO dvf_imports (source_url, annee, code_departement, etag, sha256,
                                status, rules_version, finished_at)
       VALUES ($1, $2, $3, $4, NULL, 'success', $5, now())`,
      [URL, YEAR, DEP, metadata.etag, DVF_RULES_VERSION - 1]
    )

    const result = await importer.importDepartment(DEP, optionsFor(source))
    assert.notEqual(result.status, 'skipped', 'des règles plus récentes doivent forcer le rejeu')
    assert.equal(result.status, 'success', result.error)
  })
})

test.group('DVF | verrou d’import concurrent (US-7)', () => {
  test('un second import sur la même base est refusé immédiatement', async ({ assert }) => {
    const first = newClient()
    const second = newClient()
    await first.connect()
    await second.connect()

    try {
      const holder = new DvfImporter(first)
      const challenger = new DvfImporter(second)

      assert.isTrue(await holder.acquireLock(), 'le premier import prend le verrou')
      assert.isFalse(
        await challenger.acquireLock(),
        'le second doit être refusé sans attendre, pas se bloquer'
      )

      await holder.releaseLock()

      // Une fois le verrou rendu, un nouvel import peut démarrer.
      assert.isTrue(await challenger.acquireLock())
      await challenger.releaseLock()
    } finally {
      await first.end().catch(() => undefined)
      await second.end().catch(() => undefined)
    }
  })
})
