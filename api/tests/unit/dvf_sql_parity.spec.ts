import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { dvfRow } from '#tests/helpers/dvf_fixtures'
import { DVF_CSV_COLUMNS, type DvfRawRow } from '#dvf/csv_columns'
import { BUILD_CANDIDATES_SQL, DVF_HELPERS_SQL } from '#database/sql/dvf_transform'
import { normalizeRows } from '#dvf/normalize'

/**
 * ══════════════════════════════════════════════════════════════════════════
 * TEST DE PARITÉ SQL / JAVASCRIPT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Les règles d'ingestion existent en deux exemplaires, et c'est assumé :
 *   - `database/sql/dvf_transform.ts` — set-based, imposé par le volume
 *     (Annexe A.7 : « jamais d'INSERT ligne à ligne ») ;
 *   - `app/dvf/normalize.ts` — module pur, imposé par la testabilité.
 *
 * Une duplication non surveillée dériverait, et la dérive serait invisible :
 * l'import continuerait de réussir en produisant des prix faux. Ce test fait
 * donc tourner les DEUX implémentations sur le MÊME jeu de lignes et exige un
 * résultat identique. Toute divergence casse la CI.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LIMITE STRUCTURELLE DE LA PARITÉ — ET COMMENT ON LA COMPENSE
 * ══════════════════════════════════════════════════════════════════════════
 * Un test de parité verrouille les deux implémentations **l'une sur l'autre**,
 * pas sur la spec. Il est parfaitement muet quand les deux se trompent de la
 * même façon — ce qui est arrivé : ni l'une ni l'autre ne reconnaissait le
 * `code_type_local = 4` (local industriel/commercial) comme une ligne bâtie,
 * si bien qu'une vente « logement + commerce » était ingérée avec la seule
 * surface du logement, à un €/m² gonflé, et conservée.
 *
 * D'où le second groupe de ce fichier : des cas **dérivés de l'Annexe A.1**,
 * qui vérifient le RÉSULTAT ATTENDU PAR LA SPEC et pas seulement l'accord des
 * deux moteurs. Les deux groupes sont complémentaires : le premier détecte la
 * dérive, le second l'erreur partagée.
 */

/** Insère des lignes dans le staging, puis exécute la transformation SQL. */
async function runSqlTransform(rows: DvfRawRow[]) {
  return db.transaction(async (trx) => {
    await trx.rawQuery(DVF_HELPERS_SQL)
    await trx.rawQuery('TRUNCATE mutations_staging')

    // Insertion en respectant l'ordre du fichier (line_no est un bigserial).
    for (const row of rows) {
      const columns = DVF_CSV_COLUMNS.join(', ')
      // Knex utilise « ? » comme marqueur de liaison, pas « $n ».
      const placeholders = DVF_CSV_COLUMNS.map(() => '?').join(', ')
      await trx.rawQuery(
        `INSERT INTO mutations_staging (${columns}) VALUES (${placeholders})`,
        DVF_CSV_COLUMNS.map((column) => row[column] ?? '')
      )
    }

    await trx.rawQuery(BUILD_CANDIDATES_SQL)

    const kept = await trx.rawQuery(
      `SELECT id_mutation, dedup_key, date_mutation, valeur_fonciere, type_local,
              surface_bati, nb_pieces, surface_terrain, nb_locaux, nb_dependances,
              code_insee, code_departement, adresse_voie, code_postal,
              longitude, latitude, exclusion_reason
         FROM dvf_candidates
        WHERE reject_reason IS NULL
        ORDER BY id_mutation`
    )

    const rejected = await trx.rawQuery(
      `SELECT reject_reason, count(*)::int AS total
         FROM dvf_candidates
        WHERE reject_reason IS NOT NULL
        GROUP BY reject_reason`
    )

    // On annule : ce test ne doit rien laisser derrière lui.
    await trx.rollback()

    return { kept: kept.rows, rejected: rejected.rows }
  })
}

function jsCounts(rows: DvfRawRow[]) {
  return normalizeRows(rows, { sourceAnnee: 2025 })
}

function sqlRejectedCounts(rejected: Array<{ reject_reason: string; total: number }>) {
  const counts: Record<string, number> = {}
  for (const row of rejected) {
    counts[row.reject_reason] = Number(row.total)
  }
  return counts
}

test.group('DVF | parité SQL ↔ module pur', () => {
  test('un lot représentatif donne le même résultat des deux côtés', async ({ assert }) => {
    /*
     * Jeu couvrant tous les cas décisifs de l'Annexe A.1 et A.2 :
     * mutation multi-lignes, appartement + dépendances, multi-type,
     * lots de même type, échange, absence de bâti, absence de géoloc,
     * cession symbolique, prix hors bornes.
     */
    const rows: DvfRawRow[] = [
      // 1. Maison simple + parcelle de landes (2 lignes, 1 vente).
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

      // 2. Appartement + cave + parking → conservé, surface de l'appartement.
      dvfRow({
        id_mutation: 'M2',
        type_local: 'Appartement',
        code_type_local: '2',
        surface_reelle_bati: '65',
        nombre_pieces_principales: '3',
        valeur_fonciere: '300000',
        adresse_nom_voie: 'RUE SAINT-JEAN',
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
      dvfRow({
        id_mutation: 'M2',
        type_local: 'Dépendance',
        code_type_local: '3',
        surface_reelle_bati: '',
        nombre_pieces_principales: '',
        id_parcelle: 'BOX',
        valeur_fonciere: '300000',
      }),

      // 3. Deux appartements du même type → sommés.
      dvfRow({
        id_mutation: 'M3',
        type_local: 'Appartement',
        code_type_local: '2',
        surface_reelle_bati: '40',
        nombre_pieces_principales: '2',
        id_parcelle: 'P1',
        valeur_fonciere: '400000',
      }),
      dvfRow({
        id_mutation: 'M3',
        type_local: 'Appartement',
        code_type_local: '2',
        surface_reelle_bati: '60',
        nombre_pieces_principales: '3',
        id_parcelle: 'P2',
        valeur_fonciere: '400000',
      }),

      // 4. Multi-type → rejeté.
      dvfRow({
        id_mutation: 'M4',
        type_local: 'Maison',
        code_type_local: '1',
        surface_reelle_bati: '90',
      }),
      dvfRow({
        id_mutation: 'M4',
        type_local: 'Appartement',
        code_type_local: '2',
        surface_reelle_bati: '50',
        id_parcelle: 'AUTRE',
      }),

      // 5. Doublon technique strict → dédoublonné.
      dvfRow({
        id_mutation: 'M5',
        surface_reelle_bati: '99',
        nombre_pieces_principales: '4',
        valeur_fonciere: '125000',
      }),
      dvfRow({
        id_mutation: 'M5',
        surface_reelle_bati: '99',
        nombre_pieces_principales: '4',
        valeur_fonciere: '125000',
      }),

      // 6. Échange → rejeté.
      dvfRow({ id_mutation: 'M6', nature_mutation: 'Echange' }),

      // 7. Terrain nu → rejeté (relève de mutations_terrain).
      dvfRow({ id_mutation: 'M7', type_local: '', code_type_local: '', surface_reelle_bati: '' }),

      // 8. Sans géolocalisation → rejeté.
      dvfRow({ id_mutation: 'M8', longitude: '', latitude: '' }),

      // 9. Cession symbolique → conservée, marquée aberrante.
      dvfRow({ id_mutation: 'M9', valeur_fonciere: '1' }),

      // 10. Prix hors bornes en Creuse → conservé, marqué.
      dvfRow({
        id_mutation: 'M10',
        type_local: 'Appartement',
        code_type_local: '2',
        surface_reelle_bati: '50',
        valeur_fonciere: '1500000',
      }),

      // 11. Date illisible → rejeté.
      dvfRow({ id_mutation: 'M11', date_mutation: '08/01/2025' }),
    ]

    const sql = await runSqlTransform(rows)
    const js = jsCounts(rows)

    /* ── Rejets : mêmes motifs, mêmes décomptes ─────────────────────── */
    assert.deepEqual(
      sqlRejectedCounts(sql.rejected),
      js.rejectedCounts,
      'les décomptes de rejets doivent être identiques'
    )

    /* ── Mutations conservées : même nombre ─────────────────────────── */
    assert.equal(sql.kept.length, js.kept.length, 'même nombre de mutations conservées')

    /* ── Champ à champ ──────────────────────────────────────────────── */
    const jsByKey = new Map(js.kept.map((mutation) => [mutation.idMutation, mutation]))

    for (const row of sql.kept) {
      const expected = jsByKey.get(row.id_mutation)
      assert.exists(expected, `mutation ${row.id_mutation} absente du module pur`)
      if (!expected) continue

      assert.equal(
        Number(row.valeur_fonciere),
        expected.valeurFonciere,
        `valeur ${row.id_mutation}`
      )
      assert.equal(row.type_local, expected.typeLocal, `type ${row.id_mutation}`)
      assert.equal(Number(row.surface_bati), expected.surfaceBati, `surface ${row.id_mutation}`)
      assert.equal(
        row.nb_pieces === null ? null : Number(row.nb_pieces),
        expected.nbPieces,
        `pièces ${row.id_mutation}`
      )
      assert.equal(
        Number(row.surface_terrain),
        expected.surfaceTerrain,
        `terrain ${row.id_mutation}`
      )
      assert.equal(Number(row.nb_locaux), expected.nbLocaux, `nb_locaux ${row.id_mutation}`)
      assert.equal(
        Number(row.nb_dependances),
        expected.nbDependances,
        `nb_dependances ${row.id_mutation}`
      )
      assert.equal(row.adresse_voie, expected.adresseVoie, `voie ${row.id_mutation}`)
      assert.equal(row.code_insee, expected.codeInsee, `insee ${row.id_mutation}`)
      assert.equal(
        row.exclusion_reason,
        expected.exclusionReason,
        `marquage aberrant ${row.id_mutation}`
      )
    }
  })

  test('le hachage de dédoublonnage est bien sha256(id_mutation)', async ({ assert }) => {
    const rows = [dvfRow({ id_mutation: 'M1' })]
    const sql = await runSqlTransform(rows)

    const { createHash } = await import('node:crypto')
    const expected = createHash('sha256').update('M1').digest('hex')

    assert.equal(sql.kept[0].dedup_key.trim(), expected)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * Cas « spec-first » — Annexe A.1 lue mot à mot
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Chaque test énonce d'abord ce que l'annexe EXIGE, puis vérifie que les deux
 * implémentations le produisent. Un accord des deux moteurs sur un résultat
 * faux échoue ici, alors qu'il passait dans le groupe de parité.
 */

/** Exécute les deux moteurs et rend leurs résultats côte à côte. */
async function runBoth(rows: DvfRawRow[]) {
  const sql = await runSqlTransform(rows)
  const js = jsCounts(rows)
  return { sql, js, sqlRejects: sqlRejectedCounts(sql.rejected) }
}

test.group('DVF | Annexe A.1 — cas dérivés de la spec', () => {
  test('« bâti + local commercial » ⇒ mutation écartée en multi_type', async ({ assert }) => {
    /*
     * A.1, ligne 1 du tableau : « Plusieurs locaux bâtis de types différents
     * (maison + appartement, **bâti + local commercial**) → Mutation écartée,
     * exclusion_reason = 'multi_type'. La valeur foncière n'est pas
     * répartissable, le €/m² serait faux. »
     *
     * Scénario réel de centre-bourg : maison 90 m² au-dessus d'un commerce de
     * 120 m², vendus ensemble 300 000 €. Ingérée comme « maison 90 m² », elle
     * donnait 3 333 €/m² au lieu d'environ 1 400 — sous le seuil d'aberration
     * de 25 000 €/m², donc conservée, non marquée, et incluse dans la médiane.
     */
    const rows: DvfRawRow[] = [
      dvfRow({
        id_mutation: 'C1',
        type_local: 'Maison',
        code_type_local: '1',
        surface_reelle_bati: '90',
        nombre_pieces_principales: '4',
        valeur_fonciere: '300000',
      }),
      dvfRow({
        id_mutation: 'C1',
        type_local: 'Local industriel. commercial ou assimilé',
        code_type_local: '4',
        surface_reelle_bati: '120',
        nombre_pieces_principales: '',
        id_parcelle: 'COMMERCE',
        valeur_fonciere: '300000',
      }),
    ]

    const { sql, js, sqlRejects } = await runBoth(rows)

    assert.lengthOf(sql.kept, 0, 'la mutation ne doit PAS être ingérée')
    assert.lengthOf(js.kept, 0)
    assert.deepEqual(sqlRejects, { multi_type: 1 })
    assert.deepEqual(js.rejectedCounts, { multi_type: 1 })
  })

  test('un local commercial vendu SEUL n’est pas valorisable', async ({ assert }) => {
    // §3.2 : DVF renseigne trop mal ce segment. Il ne doit ni entrer dans
    // `mutations`, ni être compté comme « aucun local bâti » — il y a bien un
    // bâti, il n'est simplement pas estimable ici.
    const rows: DvfRawRow[] = [
      dvfRow({
        id_mutation: 'C2',
        type_local: 'Local industriel. commercial ou assimilé',
        code_type_local: '4',
        surface_reelle_bati: '120',
        nombre_pieces_principales: '',
        valeur_fonciere: '250000',
      }),
    ]

    const { sql, js, sqlRejects } = await runBoth(rows)

    assert.lengthOf(sql.kept, 0)
    assert.lengthOf(js.kept, 0)
    assert.deepEqual(sqlRejects, { type_local_non_retenu: 1 })
    assert.deepEqual(js.rejectedCounts, { type_local_non_retenu: 1 })
  })

  test('une dépendance SEULE ne fait pas une mutation bâtie', async ({ assert }) => {
    /*
     * A.1, ligne 3 : les dépendances (`type_local = 3`) « sont exclues de la
     * somme des surfaces, mais ne provoquent pas le rejet ». Seules, il ne
     * reste aucun local bâti : la mutation relève de `aucun_local_bati`, et
     * surtout PAS de `multi_type` — sans quoi tout garage vendu avec un
     * appartement écarterait la vente.
     */
    const rows: DvfRawRow[] = [
      dvfRow({
        id_mutation: 'D1',
        type_local: 'Dépendance',
        code_type_local: '3',
        surface_reelle_bati: '',
        nombre_pieces_principales: '',
        valeur_fonciere: '12000',
      }),
    ]

    const { sql, js, sqlRejects } = await runBoth(rows)

    assert.lengthOf(sql.kept, 0)
    assert.lengthOf(js.kept, 0)
    assert.deepEqual(sqlRejects, { aucun_local_bati: 1 })
    assert.deepEqual(js.rejectedCounts, { aucun_local_bati: 1 })
  })

  test('un appartement AVEC cave et parking reste conservé, à sa seule surface', async ({
    assert,
  }) => {
    // Le corollaire indispensable du test précédent : c'est le cas majoritaire
    // du marché urbain (3 lignes, type_local 2/3/3).
    const rows: DvfRawRow[] = [
      dvfRow({
        id_mutation: 'D2',
        type_local: 'Appartement',
        code_type_local: '2',
        surface_reelle_bati: '65',
        nombre_pieces_principales: '3',
        valeur_fonciere: '300000',
      }),
      dvfRow({
        id_mutation: 'D2',
        type_local: 'Dépendance',
        code_type_local: '3',
        surface_reelle_bati: '',
        nombre_pieces_principales: '',
        id_parcelle: 'CAVE',
        valeur_fonciere: '300000',
      }),
      dvfRow({
        id_mutation: 'D2',
        type_local: 'Dépendance',
        code_type_local: '3',
        surface_reelle_bati: '',
        nombre_pieces_principales: '',
        id_parcelle: 'BOX',
        valeur_fonciere: '300000',
      }),
    ]

    const { sql, js } = await runBoth(rows)

    assert.lengthOf(sql.kept, 1)
    assert.equal(Number(sql.kept[0].surface_bati), 65, 'un garage ne fait pas de surface habitable')
    assert.equal(Number(sql.kept[0].nb_locaux), 1)
    assert.equal(Number(sql.kept[0].nb_dependances), 2)
    assert.equal(js.kept[0].surfaceBati, 65)
    assert.equal(js.kept[0].nbDependances, 2)
  })

  test('4 lots du MÊME type sont sommés, en une seule ligne', async ({ assert }) => {
    /*
     * A.1, ligne 2 : « Plusieurs lots du même type → Conservée :
     * surface_reelle_bati et nombre_pieces_principales sommés, une seule
     * ligne, nombre_lots = N. »
     */
    const rows: DvfRawRow[] = [30, 40, 50, 60].map((surface, index) =>
      dvfRow({
        id_mutation: 'L4',
        type_local: 'Appartement',
        code_type_local: '2',
        surface_reelle_bati: String(surface),
        nombre_pieces_principales: '2',
        id_parcelle: `PARC-${index}`,
        lot1_numero: String(index + 1),
        valeur_fonciere: '360000',
      })
    )

    const { sql, js } = await runBoth(rows)

    assert.lengthOf(sql.kept, 1, 'quatre lignes, UNE mutation')
    assert.equal(Number(sql.kept[0].surface_bati), 180, '30 + 40 + 50 + 60')
    assert.equal(Number(sql.kept[0].nb_pieces), 8, '4 × 2 pièces')
    assert.equal(Number(sql.kept[0].nb_locaux), 4)
    assert.equal(js.kept[0].surfaceBati, 180)
    assert.equal(js.kept[0].nbPieces, 8)
    assert.equal(js.kept[0].nbLocaux, 4)
  })

  test('la valeur foncière répétée n’est comptée QU’UNE fois', async ({ assert }) => {
    /*
     * A.1, dernière ligne : « valeur_fonciere — Répétée à l'identique sur
     * toutes les lignes du groupe → comptée une seule fois. C'est l'erreur
     * classique qui gonfle les prix d'un facteur 2 à 4. »
     *
     * 360 000 € répétés sur 4 lignes : sommer donnerait 1 440 000 € et un
     * €/m² multiplié par 4.
     */
    const rows: DvfRawRow[] = [30, 40, 50, 60].map((surface, index) =>
      dvfRow({
        id_mutation: 'V1',
        type_local: 'Appartement',
        code_type_local: '2',
        surface_reelle_bati: String(surface),
        nombre_pieces_principales: '2',
        id_parcelle: `PARC-${index}`,
        lot1_numero: String(index + 1),
        valeur_fonciere: '360000',
      })
    )

    const { sql, js } = await runBoth(rows)

    assert.equal(Number(sql.kept[0].valeur_fonciere), 360_000)
    assert.equal(js.kept[0].valeurFonciere, 360_000)
    // 360 000 / 180 m² = 2 000 €/m², et non 8 000.
    assert.closeTo(js.kept[0].prixM2, 2_000, 0.01)
  })
})
