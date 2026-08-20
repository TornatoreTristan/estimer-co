import { test } from '@japa/runner'
import { dvfRow } from '#tests/helpers/dvf_fixtures'
import {
  builtTypeKey,
  dedupeBuiltRows,
  groupByMutation,
  isBuiltRow,
  isValuableRow,
  normalizeAdresseVoie,
  normalizeMutationGroup,
  normalizeRows,
  normalizeTypeLocal,
  parseDecimal,
  parseMutationDate,
  priceCeilingFor,
} from '#dvf/normalize'

/**
 * Règles d'ingestion DVF — spec §3.1, Annexe A.1 à A.3.
 *
 * Ce fichier couvre le point le plus dangereux du lot : une erreur de
 * dédoublonnage ne provoque aucune panne, elle produit simplement des prix
 * faux que rien ne signale.
 */

test.group('DVF | analyseurs élémentaires', () => {
  test('parseDecimal distingue « absent » de « zéro »', ({ assert }) => {
    // Confondre les deux fabriquerait des divisions par zéro et des prix absurdes.
    assert.isNull(parseDecimal(''))
    assert.isNull(parseDecimal('   '))
    assert.isNull(parseDecimal(undefined))
    assert.isNull(parseDecimal('abc'))
    assert.equal(parseDecimal('0'), 0)
    assert.equal(parseDecimal('119500'), 119500)
    assert.equal(parseDecimal('66.5'), 66.5)
    assert.equal(parseDecimal('66,5'), 66.5)
  })

  test('normalizeTypeLocal ne retient que maison et appartement, en minuscules', ({ assert }) => {
    assert.equal(normalizeTypeLocal('Maison'), 'maison')
    assert.equal(normalizeTypeLocal('Appartement'), 'appartement')
    assert.equal(normalizeTypeLocal('APPARTEMENT'), 'appartement')
    // Une dépendance n'est pas un bien estimable.
    assert.isNull(normalizeTypeLocal('Dépendance'))
    assert.isNull(normalizeTypeLocal('Local industriel. commercial ou assimilé'))
    assert.isNull(normalizeTypeLocal(''))
  })

  test('parseMutationDate rejette les dates impossibles', ({ assert }) => {
    assert.deepEqual(parseMutationDate('2025-01-08'), { date: '2025-01-08', year: 2025 })
    assert.isNull(parseMutationDate('2025-13-01'))
    assert.isNull(parseMutationDate('08/01/2025'))
    assert.isNull(parseMutationDate('1999-01-01'))
    assert.isNull(parseMutationDate(''))
  })

  test('parseMutationDate rejette une date inexistante au calendrier', ({ assert }) => {
    /*
     * Un simple `day <= 31` acceptait le 31 février. La transformation SQL,
     * elle, rejette (`'2024-02-31'::date` lève, `dvf_date` rend NULL) : les
     * deux implémentations divergeaient sans que le test de parité l'attrape,
     * faute d'un tel cas dans son jeu de lignes.
     */
    assert.isNull(parseMutationDate('2024-02-31'))
    assert.isNull(parseMutationDate('2025-04-31'))
    assert.isNull(parseMutationDate('2025-02-29'), '2025 n’est pas bissextile')
    // Une vraie année bissextile reste acceptée.
    assert.deepEqual(parseMutationDate('2024-02-29'), { date: '2024-02-29', year: 2024 })
  })

  test('un local commercial est une ligne BÂTIE, mais pas VALORISABLE (A.1)', ({ assert }) => {
    /*
     * La distinction structurante de l'Annexe A.1. Ne reconnaître que 1 et 2
     * comme « bâti » laissait passer « logement + commerce » avec la seule
     * surface du logement, à un €/m² gonflé — sous le seuil d'aberration,
     * donc conservé.
     */
    const commercial = dvfRow({
      code_type_local: '4',
      type_local: 'Local industriel. commercial ou assimilé',
    })

    assert.equal(builtTypeKey(commercial), 'commercial')
    assert.isTrue(isBuiltRow(commercial), 'compte dans nb_types, donc déclenche multi_type')
    assert.isFalse(isValuableRow(commercial), 'jamais ingéré comme un logement')
  })

  test('une dépendance n’est ni bâtie ni valorisable', ({ assert }) => {
    const dependance = dvfRow({ code_type_local: '3', type_local: 'Dépendance' })

    assert.isNull(builtTypeKey(dependance))
    assert.isFalse(isBuiltRow(dependance), 'un parking ne doit JAMAIS provoquer un multi_type')
    assert.isFalse(isValuableRow(dependance))
  })

  test('le code_type_local fait foi ; le libellé n’est qu’un repli', ({ assert }) => {
    assert.equal(builtTypeKey(dvfRow({ code_type_local: '1', type_local: 'Maison' })), 'maison')
    assert.equal(
      builtTypeKey(dvfRow({ code_type_local: '2', type_local: 'Appartement' })),
      'appartement'
    )
    // Code absent : on retombe sur le libellé.
    assert.equal(builtTypeKey(dvfRow({ code_type_local: '', type_local: 'Maison' })), 'maison')
    assert.equal(
      builtTypeKey(
        dvfRow({ code_type_local: '', type_local: 'Local industriel. commercial ou assimilé' })
      ),
      'commercial'
    )
    assert.isNull(builtTypeKey(dvfRow({ code_type_local: '', type_local: '' })))
  })

  test('la borne haute de prix est relevée dans les départements les plus chers', ({ assert }) => {
    // Annexe A.2 : sans cela, l'essentiel du marché parisien serait
    // marqué aberrant à tort.
    assert.equal(priceCeilingFor('75'), 45_000)
    assert.equal(priceCeilingFor('06'), 45_000)
    assert.equal(priceCeilingFor('2A'), 45_000)
    assert.equal(priceCeilingFor('92'), 45_000)
    assert.equal(priceCeilingFor('23'), 25_000)
  })
})

test.group('DVF | adresse sans numéro de voie (§8.3)', () => {
  test("le numéro de voie n'est jamais conservé", ({ assert }) => {
    // À l'échelle d'une petite commune, numéro + date + prix rendraient un
    // vendeur identifiable.
    assert.equal(normalizeAdresseVoie('RUE DE LA PAIX'), 'Rue De La Paix')
    assert.equal(normalizeAdresseVoie('12 RUE DE LA PAIX'), 'Rue De La Paix')
    assert.equal(normalizeAdresseVoie('12 BIS RUE DE LA PAIX'), 'Rue De La Paix')
    assert.equal(normalizeAdresseVoie('SIBILOT'), 'Sibilot')
  })

  test('la casse suit initcap : les traits d’union délimitent les mots', ({ assert }) => {
    // Équivalence exigée avec la transformation SQL (test de parité).
    assert.equal(normalizeAdresseVoie('RUE SAINT-JEAN'), 'Rue Saint-Jean')
  })

  test('une voie vide reste nulle', ({ assert }) => {
    assert.isNull(normalizeAdresseVoie(''))
    assert.isNull(normalizeAdresseVoie(null))
  })
})

test.group('DVF | regroupement et dédoublonnage (Annexe A.1)', () => {
  test('les lignes sont regroupées par id_mutation', ({ assert }) => {
    const groups = groupByMutation([
      dvfRow({ id_mutation: 'A' }),
      dvfRow({ id_mutation: 'B' }),
      dvfRow({ id_mutation: 'A' }),
    ])

    assert.equal(groups.size, 2)
    assert.lengthOf(groups.get('A')!, 2)
  })

  test('les lignes bâties strictement identiques sont dédoublonnées', ({ assert }) => {
    // Cas réel observé en Creuse (mutation 2025-249971) : la même maison
    // répétée. Sans dédoublonnage, la surface doublerait et le prix au m²
    // serait divisé par deux.
    const row = dvfRow({ surface_reelle_bati: '99', nombre_pieces_principales: '4' })
    assert.lengthOf(dedupeBuiltRows([row, { ...row }]), 1)
  })

  test('deux appartements distincts du même immeuble sont conservés', ({ assert }) => {
    const a = dvfRow({ type_local: 'Appartement', code_type_local: '2', surface_reelle_bati: '40' })
    const b = dvfRow({ type_local: 'Appartement', code_type_local: '2', surface_reelle_bati: '65' })
    assert.lengthOf(dedupeBuiltRows([a, b]), 2)
  })
})

test.group('DVF | valeur foncière comptée une seule fois', () => {
  test('une mutation étalée sur plusieurs lignes ne compte sa valeur qu’une fois', ({ assert }) => {
    /*
     * Cas réel : mutation 2025-249966 (Creuse), 2 lignes à 119 500 € —
     * une maison et une parcelle de landes. C'est UNE vente à 119 500 €.
     * Sommer donnerait 239 000 € et doublerait le prix au m².
     */
    const rows = [
      dvfRow({ id_mutation: 'M1', valeur_fonciere: '119500', surface_reelle_bati: '66' }),
      dvfRow({
        id_mutation: 'M1',
        valeur_fonciere: '119500',
        type_local: '',
        code_type_local: '',
        surface_reelle_bati: '',
        nombre_pieces_principales: '',
        id_parcelle: '231030000A1167',
        nature_culture: 'landes',
        surface_terrain: '666',
      }),
    ]

    const outcome = normalizeMutationGroup('M1', rows, { sourceAnnee: 2025 })

    assert.equal(outcome.status, 'kept')
    if (outcome.status !== 'kept') return

    assert.equal(outcome.mutation.valeurFonciere, 119_500)
    assert.equal(outcome.mutation.surfaceBati, 66)
    assert.closeTo(outcome.mutation.prixM2, 119_500 / 66, 0.01)
    // Les surfaces de terrain des parcelles distinctes s'additionnent.
    assert.equal(outcome.mutation.surfaceTerrain, 60 + 666)
  })
})

test.group('DVF | règle multi-lots corrigée (Annexe A.1)', () => {
  test('un appartement vendu avec cave et parking est CONSERVÉ', ({ assert }) => {
    /*
     * Le point central de la correction. Une vente d'appartement en ville
     * produit presque toujours 3 lignes (type_local 2, 3, 3). La règle
     * initiale « plus d'un local bâti ⇒ rejet » écartait l'essentiel du
     * marché urbain.
     */
    const rows = [
      dvfRow({
        id_mutation: 'M2',
        type_local: 'Appartement',
        code_type_local: '2',
        surface_reelle_bati: '65',
        nombre_pieces_principales: '3',
        valeur_fonciere: '300000',
      }),
      dvfRow({
        id_mutation: 'M2',
        type_local: 'Dépendance',
        code_type_local: '3',
        surface_reelle_bati: '',
        nombre_pieces_principales: '',
        id_parcelle: 'PARC-CAVE',
        valeur_fonciere: '300000',
      }),
      dvfRow({
        id_mutation: 'M2',
        type_local: 'Dépendance',
        code_type_local: '3',
        surface_reelle_bati: '',
        nombre_pieces_principales: '',
        id_parcelle: 'PARC-BOX',
        valeur_fonciere: '300000',
      }),
    ]

    const outcome = normalizeMutationGroup('M2', rows, { sourceAnnee: 2025 })

    assert.equal(outcome.status, 'kept')
    if (outcome.status !== 'kept') return

    // Seule la surface de l'appartement est retenue : un garage ne fait pas
    // de la surface habitable.
    assert.equal(outcome.mutation.surfaceBati, 65)
    assert.equal(outcome.mutation.typeLocal, 'appartement')
    assert.equal(outcome.mutation.nbLocaux, 1)
    // Les dépendances sont tracées (Annexe A.1).
    assert.equal(outcome.mutation.nbDependances, 2)
  })

  test('plusieurs lots du MÊME type sont conservés, surfaces et pièces sommées', ({ assert }) => {
    const rows = [
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
    ]

    const outcome = normalizeMutationGroup('M3', rows, { sourceAnnee: 2025 })

    assert.equal(outcome.status, 'kept')
    if (outcome.status !== 'kept') return

    assert.equal(outcome.mutation.surfaceBati, 100)
    assert.equal(outcome.mutation.nbPieces, 5)
    assert.equal(outcome.mutation.nbLocaux, 2)
    assert.equal(outcome.mutation.prixM2, 4_000)
  })

  test('bâti + local commercial est écarté en multi_type (A.1)', ({ assert }) => {
    /*
     * Maison 90 m² + commerce 120 m² à 300 000 € : ingérée comme « maison
     * 90 m² », elle donnait 3 333 €/m² au lieu d'environ 1 400. Sous le seuil
     * d'aberration de 25 000 €/m², donc conservée et incluse dans la médiane.
     * Fréquent en centre-bourg.
     */
    const rows = [
      dvfRow({
        id_mutation: 'MC1',
        type_local: 'Maison',
        code_type_local: '1',
        surface_reelle_bati: '90',
        valeur_fonciere: '300000',
      }),
      dvfRow({
        id_mutation: 'MC1',
        type_local: 'Local industriel. commercial ou assimilé',
        code_type_local: '4',
        surface_reelle_bati: '120',
        nombre_pieces_principales: '',
        id_parcelle: 'COMMERCE',
        valeur_fonciere: '300000',
      }),
    ]

    const outcome = normalizeMutationGroup('MC1', rows, { sourceAnnee: 2025 })

    assert.equal(outcome.status, 'rejected')
    if (outcome.status !== 'rejected') return
    assert.equal(outcome.reason, 'multi_type')
  })

  test('des types bâtis DIFFÉRENTS font écarter la mutation', ({ assert }) => {
    // La valeur foncière porte sur l'ensemble et n'est pas répartissable :
    // le prix au m² serait faux.
    const rows = [
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
        id_parcelle: 'P2',
      }),
    ]

    const outcome = normalizeMutationGroup('M4', rows, { sourceAnnee: 2025 })

    assert.equal(outcome.status, 'rejected')
    if (outcome.status !== 'rejected') return
    assert.equal(outcome.reason, 'multi_type')
  })
})

test.group('DVF | filtres §3.1', () => {
  test('seules les ventes sont retenues', ({ assert }) => {
    for (const nature of ['Echange', "Vente en l'état futur d'achèvement", 'Adjudication']) {
      const outcome = normalizeMutationGroup('X', [dvfRow({ nature_mutation: nature })], {
        sourceAnnee: 2025,
      })
      assert.equal(outcome.status, 'rejected', `${nature} devrait être rejetée`)
    }
  })

  test('une mutation sans local bâti est écartée (elle relève des terrains)', ({ assert }) => {
    const outcome = normalizeMutationGroup(
      'T1',
      [dvfRow({ type_local: '', code_type_local: '', surface_reelle_bati: '' })],
      { sourceAnnee: 2025 }
    )

    assert.equal(outcome.status, 'rejected')
    if (outcome.status !== 'rejected') return
    assert.equal(outcome.reason, 'aucun_local_bati')
  })

  test('une mutation sans géolocalisation est écartée', ({ assert }) => {
    const outcome = normalizeMutationGroup('G1', [dvfRow({ longitude: '', latitude: '' })], {
      sourceAnnee: 2025,
    })

    assert.equal(outcome.status, 'rejected')
    if (outcome.status !== 'rejected') return
    assert.equal(outcome.reason, 'geolocalisation_absente')
  })
})

test.group('DVF | aberrants marqués, jamais supprimés (Annexe A.2)', () => {
  test('une cession symbolique est conservée mais marquée', ({ assert }) => {
    const outcome = normalizeMutationGroup(
      'A1',
      [dvfRow({ valeur_fonciere: '1', surface_reelle_bati: '66' })],
      { sourceAnnee: 2025 }
    )

    assert.equal(outcome.status, 'kept')
    if (outcome.status !== 'kept') return

    assert.isTrue(outcome.mutation.isOutlier)
    assert.equal(outcome.mutation.exclusionReason, 'valeur_symbolique')
  })

  test('une surface hors bornes est marquée selon le type de bien', ({ assert }) => {
    // Maison : bornes [20 ; 1 500]. 15 m² est hors bornes pour une maison…
    const maison = normalizeMutationGroup(
      'A2',
      [dvfRow({ type_local: 'Maison', code_type_local: '1', surface_reelle_bati: '15' })],
      { sourceAnnee: 2025 }
    )
    assert.equal(maison.status, 'kept')
    if (maison.status !== 'kept') return
    assert.equal(maison.mutation.exclusionReason, 'surface_hors_bornes')

    // … mais pas pour un appartement, dont la borne basse est 9 m².
    const appart = normalizeMutationGroup(
      'A3',
      [
        dvfRow({
          type_local: 'Appartement',
          code_type_local: '2',
          surface_reelle_bati: '15',
          valeur_fonciere: '60000',
        }),
      ],
      { sourceAnnee: 2025 }
    )
    assert.equal(appart.status, 'kept')
    if (appart.status !== 'kept') return
    assert.isFalse(appart.mutation.isOutlier)
  })

  test('un prix au m² parisien élevé n’est pas marqué aberrant', ({ assert }) => {
    const rows = [
      dvfRow({
        code_departement: '75',
        code_commune: '75102',
        type_local: 'Appartement',
        code_type_local: '2',
        surface_reelle_bati: '50',
        valeur_fonciere: '1500000', // 30 000 €/m²
      }),
    ]

    const outcome = normalizeMutationGroup('P1', rows, { sourceAnnee: 2025 })
    assert.equal(outcome.status, 'kept')
    if (outcome.status !== 'kept') return
    assert.isFalse(outcome.mutation.isOutlier)
  })

  test('le même prix au m² serait aberrant en Creuse', ({ assert }) => {
    const rows = [
      dvfRow({
        code_departement: '23',
        type_local: 'Appartement',
        code_type_local: '2',
        surface_reelle_bati: '50',
        valeur_fonciere: '1500000',
      }),
    ]

    const outcome = normalizeMutationGroup('P2', rows, { sourceAnnee: 2025 })
    assert.equal(outcome.status, 'kept')
    if (outcome.status !== 'kept') return
    assert.equal(outcome.mutation.exclusionReason, 'prix_hors_bornes')
  })
})

test.group('DVF | comptage des rejets par motif', () => {
  test('normalizeRows agrège les rejets par motif', ({ assert }) => {
    const rows = [
      // Conservée.
      dvfRow({ id_mutation: 'K1' }),
      // Rejetée : échange.
      dvfRow({ id_mutation: 'R1', nature_mutation: 'Echange' }),
      dvfRow({ id_mutation: 'R2', nature_mutation: 'Echange' }),
      // Rejetée : multi-type.
      dvfRow({ id_mutation: 'R3', type_local: 'Maison', code_type_local: '1' }),
      dvfRow({
        id_mutation: 'R3',
        type_local: 'Appartement',
        code_type_local: '2',
        id_parcelle: 'AUTRE',
      }),
      // Rejetée : pas de bâti.
      dvfRow({ id_mutation: 'R4', type_local: '', code_type_local: '' }),
    ]

    const result = normalizeRows(rows, { sourceAnnee: 2025 })

    assert.equal(result.rowsRead, 6)
    assert.equal(result.mutationsSeen, 5)
    assert.lengthOf(result.kept, 1)
    assert.deepEqual(result.rejectedCounts, {
      nature_non_vente: 2,
      multi_type: 1,
      aucun_local_bati: 1,
    })
  })
})
