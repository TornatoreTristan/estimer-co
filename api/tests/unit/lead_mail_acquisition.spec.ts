/*
|--------------------------------------------------------------------------
| E-mail interne — section PROVENANCE
|--------------------------------------------------------------------------
|
| Le gabarit de l'e-mail interne reproduit le gabarit historique d'EmailJS :
| c'est ce qui fait qu'un commercial n'a rien à réapprendre. La provenance est
| la seule chose qui s'y soit ajoutée, et ces cas vérifient qu'elle ne déplace
| rien de ce qui existait.
|
*/
import { test } from '@japa/runner'

import { buildAcquisitionSection, renderInternalEmail } from '#services/lead_mail_renderer'
import type { LeadPayload } from '#validators/lead'

const LEAD_ESTIMATION = {
  kind: 'estimation',
  name: 'Camille Martin',
  email: 'camille@example.test',
  phone: '0612345678',
  property: {
    address: '12 rue de la Paix',
    postalCode: '75002',
    city: 'Paris',
    propertyType: 'appartement',
    surface: 65,
    rooms: 3,
    dpe: 'D',
    isOwner: 'yes',
    wantToSell: 'yes',
  },
  estimation: { status: 'ok', estimationMoyenne: 682_500 },
} as unknown as LeadPayload

test.group('E-mail interne | provenance', () => {
  test('sans provenance, le gabarit historique est inchangé', ({ assert }) => {
    const email = renderInternalEmail(LEAD_ESTIMATION)

    // Les leads déposés depuis une page mise en cache avant la capture n'ont
    // pas de provenance : une section « Non renseignée » sur chacun d'eux
    // serait du bruit permanent dans la boîte.
    assert.notInclude(email.text, 'PROVENANCE')
    assert.equal(buildAcquisitionSection(undefined), '')

    // Le corps se termine toujours par les coordonnées puis la barre.
    assert.match(email.text, /- Telephone : 0612345678\n\n━+$/)
  })

  test('la provenance est ajoutée APRÈS les coordonnées', ({ assert }) => {
    const email = renderInternalEmail({
      ...LEAD_ESTIMATION,
      acquisition: {
        gclid: 'EAIaIQobCh',
        campaign: 'gads_lead_proprietaire_idf_202608',
        referrer: 'www.google.com',
        landingPage: '/',
      },
    } as LeadPayload)

    assert.isAbove(email.text.indexOf('PROVENANCE'), email.text.indexOf('COORDONNEES DU CLIENT'))
    assert.include(email.text, '- Canal : Google Ads')
    assert.include(email.text, '- Campagne : gads_lead_proprietaire_idf_202608')
    assert.include(email.text, "- Page d'arrivee : /")
    // Clé d'import des conversions hors ligne chez Google Ads (plan §11, T5).
    assert.include(email.text, '- gclid : EAIaIQobCh')
  })

  test('seuls les champs renseignés sont listés', ({ assert }) => {
    const section = buildAcquisitionSection({ source: 'meta', medium: 'paid_social' })

    assert.include(section, '- Canal : Meta Ads')
    assert.notInclude(section, 'Campagne')
    assert.notInclude(section, 'gclid')
  })

  test('le message de contact porte aussi sa provenance', ({ assert }) => {
    const email = renderInternalEmail({
      kind: 'contact',
      name: 'Marie Martin',
      email: 'marie@example.test',
      subject: 'partenariat',
      message: 'Bonjour',
      acquisition: { source: 'newsletter', medium: 'email' },
    } as unknown as LeadPayload)

    assert.include(email.text, '- Canal : E-mailing (newsletter)')
  })

  test('la provenance est échappée dans la version HTML', ({ assert }) => {
    const email = renderInternalEmail({
      ...LEAD_ESTIMATION,
      // Ces valeurs viennent de l'URL d'arrivée : elles sont fournies par
      // celui qui a construit le lien, donc par n'importe qui.
      acquisition: { campaign: '<script>alert(1)</script>' },
    } as LeadPayload)

    assert.notInclude(email.html, '<script>')
    assert.include(email.html, '&lt;script&gt;')
  })
})
