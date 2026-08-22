import { test } from '@japa/runner'

import {
  formatMonth,
  formatNumber,
  renderAcknowledgementEmail,
  type AcknowledgementEstimation,
} from '#services/lead_mail_renderer'
import { buildStaticMapUrl } from '#services/static_map_service'
import type { LeadPayload } from '#validators/lead'

/**
 * Accusé de réception envoyé AU PROSPECT — mise en page HTML.
 *
 * Ce que ces tests protègent, dans l'ordre d'importance :
 *
 *  1. LA PROVENANCE DU CHIFFRE. Un montant de repli interne ne doit jamais
 *     être rappelé au client, et le détail du calcul affiché doit venir du
 *     recalcul serveur — jamais du payload transmis par le navigateur.
 *  2. L'ÉCHAPPEMENT. La mise en forme a remplacé un `<pre>` par du HTML
 *     composé : la seule régression qui compte ici est une balise du client
 *     qui traverserait le rendu.
 *  3. LA DÉGRADATION. Sans détail serveur, sans carte, l'e-mail doit rester
 *     celui d'avant — pas une coquille avec des sections vides.
 */

const PAYLOAD: LeadPayload = {
  kind: 'estimation',
  name: 'Marie Dupont',
  email: 'marie@example.com',
  consent: true,
  property: {
    address: '12 rue des Lilas',
    postalCode: '69003',
    city: 'Lyon',
    propertyType: 'appartement',
    surface: 72,
    rooms: 3,
    dpe: 'C',
    dpeRequest: 'no',
    isOwner: 'yes',
    wantToSell: 'yes',
  },
  estimation: {
    status: 'ok',
    prixM2: 4200,
    estimationMin: 288_000,
    estimationMoyenne: 302_400,
    estimationMax: 320_000,
  },
} as LeadPayload

const DETAILS: AcknowledgementEstimation = {
  value: 302_400,
  range: { low: 288_000, high: 320_000 },
  confidence: { score: 82 },
  display: { showCentralValue: true, confidenceLabelFr: 'Estimation fiable' },
  method: {
    kind: 'comparables',
    level: 'strict',
    radiusM: 500,
    windowMonths: 24,
    comparablesCount: 47,
    medianPriceM2Raw: 4150,
  },
  comparables: [
    {
      street: 'rue Paul Bert',
      city: 'Lyon',
      date: '2024-11',
      surface: 68,
      rooms: 3,
      price: 289_000,
      pricePerSqm: 4250,
    },
  ],
  dataSource: {
    dvfPublicationDate: '2025-04',
    disclaimerFr: 'Cette estimation automatisée ne constitue ni une expertise immobilière.',
    attributionFr: 'Source : DVF, DGFiP — Licence ouverte Etalab 2.0.',
  },
}

test.group('Accusé de réception — mise en page', () => {
  test('affiche le chiffre, la confiance, la méthode et les ventes similaires', ({ assert }) => {
    const { html } = renderAcknowledgementEmail(PAYLOAD, { estimation: DETAILS })

    /*
     * Montant dérivé de `formatNumber`, jamais figé : le séparateur de
     * milliers dépend des données ICU du runtime (espace fine ou normale).
     */
    assert.include(html, `${formatNumber(302_400)} €`)
    assert.include(html, 'Indice de confiance')
    assert.include(html, '82/100')
    assert.include(html, 'Estimation fiable')
    assert.include(html, 'Comment ce chiffre est calculé')
    assert.include(html, '47 transactions réelles')
    assert.include(html, '500 m autour du bien')
    assert.include(html, 'Ventes similaires dans le secteur')
    assert.include(html, 'rue Paul Bert, Lyon')
    assert.include(html, 'novembre 2024')
  })

  test('reprend le disclaimer légal servi par l’API', ({ assert }) => {
    const { html } = renderAcknowledgementEmail(PAYLOAD, { estimation: DETAILS })

    assert.include(html, 'ne constitue ni une expertise immobilière')
    assert.include(html, 'Licence ouverte Etalab 2.0')
  })

  test('sans détail serveur, aucune section vide n’est produite', ({ assert }) => {
    const { html } = renderAcknowledgementEmail(PAYLOAD)

    assert.notInclude(html, 'Indice de confiance')
    assert.notInclude(html, 'Comment ce chiffre est calculé')
    assert.notInclude(html, 'Ventes similaires')
    // Le chiffre du payload, lui, reste affiché : c'est le comportement d'avant.
    assert.include(html, 'Estimation de votre bien à Lyon')
  })

  test('la carte n’apparaît que lorsqu’une vignette est attachée', ({ assert }) => {
    const sans = renderAcknowledgementEmail(PAYLOAD, { estimation: DETAILS })
    assert.notInclude(sans.html, 'cid:')

    const avec = renderAcknowledgementEmail(PAYLOAD, {
      estimation: DETAILS,
      mapCid: 'carte-du-bien',
    })
    assert.include(avec.html, 'src="cid:carte-du-bien"')
  })

  test('un montant de repli interne n’est jamais rappelé au client', ({ assert }) => {
    const degraded = {
      ...PAYLOAD,
      estimation: { ...PAYLOAD.estimation!, status: 'static-fallback' as const },
    } as LeadPayload

    const { html, text } = renderAcknowledgementEmail(degraded)

    assert.notInclude(html, '302')
    assert.include(html, 'Estimation en cours')
    assert.include(text, 'Nous finalisons')
  })

  test('un chiffre que l’API juge non affichable ne l’est pas non plus ici', ({ assert }) => {
    const shy: AcknowledgementEstimation = {
      ...DETAILS,
      display: { showCentralValue: false, confidenceLabelFr: 'Estimation indicative' },
    }

    const degraded = {
      ...PAYLOAD,
      estimation: { ...PAYLOAD.estimation!, status: 'deferred' as const },
    } as LeadPayload

    const { html } = renderAcknowledgementEmail(degraded, { estimation: shy })

    assert.include(html, 'Estimation en cours')
    assert.notInclude(html, '302 400')
  })

  test('le nom du prospect est échappé', ({ assert }) => {
    const hostile = {
      ...PAYLOAD,
      name: '<script>alert(1)</script> Dupont',
    } as LeadPayload

    const { html } = renderAcknowledgementEmail(hostile, { estimation: DETAILS })

    assert.notInclude(html, '<script>')
    assert.include(html, '&lt;script&gt;')
  })

  test('la pile de polices ne casse pas les attributs style', ({ assert }) => {
    const { html } = renderAcknowledgementEmail(PAYLOAD, { estimation: DETAILS })

    /*
     * Régression vécue : `font-family: "Geist"` interpolé dans un
     * `style="…"` refermait l'attribut au milieu de la déclaration, et toute
     * la mise en forme de la balise sautait, silencieusement.
     */
    assert.notInclude(html, 'font-family: "')
    assert.include(html, "font-family: 'Geist'")
  })
})

test.group('Ventilation des dates', () => {
  test('« 2024-06 » devient « juin 2024 »', ({ assert }) => {
    assert.equal(formatMonth('2024-06'), 'juin 2024')
    assert.equal(formatMonth('2025-04-01'), 'avril 2025')
  })

  test('une valeur non reconnue est rendue telle quelle', ({ assert }) => {
    assert.equal(formatMonth('bientôt'), 'bientôt')
    assert.equal(formatMonth(''), '')
  })
})

test.group('URL de carte statique', () => {
  test('porte le marqueur de la charte et la clé', ({ assert }) => {
    const url = buildStaticMapUrl(45.752, 4.851, 'CLE-TEST')

    assert.include(url, 'center=45.752000%2C4.851000')
    assert.include(url, 'markers=color%3A0xff6e34')
    assert.include(url, 'scale=2')
    assert.include(url, 'key=CLE-TEST')
  })
})
