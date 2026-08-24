/*
|--------------------------------------------------------------------------
| Consentement à la transmission partenaire
|--------------------------------------------------------------------------
|
| Ce qui est vérifié ici n'est pas du rendu : c'est une AUTORISATION. L'e-mail
| interne et l'alerte Discord sont les deux documents depuis lesquels un lead
| part chez une agence, et la seule question qu'ils doivent trancher est « ai-je
| le droit de transmettre celui-ci ».
|
| La règle est asymétrique, et ces cas la figent : un seul état autorise — la
| preuve écrite. Refus, version inconnue, base indisponible, page antérieure au
| déploiement : tout le reste interdit, avec la même netteté. Un accord non
| prouvé vaut exactement une absence d'accord.
|
*/
import { test } from '@japa/runner'

import { CURRENT_PARTNER_CONSENT_VERSION, resolvePartnerConsent } from '#lib/partner_consent'
import { buildPartnerConsentSection, renderInternalEmail } from '#services/lead_mail_renderer'
import { isTransferable, type PartnerConsentOutcome } from '#services/partner_consent_service'
import { renderLeadNotification } from '#services/discord_lead_renderer'
import type { DiscordSettings } from '#lib/discord_config'
import type { LeadPayload } from '#validators/lead'

const LEAD = {
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

const DISCORD_SETTINGS = {
  enabled: true,
  webhookUrl: 'https://discord.test/webhook',
  username: 'estimer.co',
  includeContact: true,
  mention: '',
  timeoutMs: 5_000,
} as unknown as DiscordSettings

const RECORDED: PartnerConsentOutcome = {
  state: 'recorded',
  version: CURRENT_PARTNER_CONSENT_VERSION,
  partners: ['Les Bons Biens', 'Dr House Immo'],
}

/** Tous les états qui n'autorisent PAS la transmission. */
const REFUS: PartnerConsentOutcome[] = [
  { state: 'absent' },
  { state: 'declined' },
  { state: 'unverifiable', version: '1999-01-01' },
  { state: 'not-stored', version: CURRENT_PARTNER_CONSENT_VERSION },
]

test.group('Registre de consentement', () => {
  test('la version en vigueur est résoluble et porte son texte', ({ assert }) => {
    const entree = resolvePartnerConsent(CURRENT_PARTNER_CONSENT_VERSION)

    assert.isNotNull(entree)
    assert.isNotEmpty(entree!.texte)
    assert.isNotEmpty(entree!.partenaires)
  })

  test('le texte cite nommément chaque destinataire autorisé', ({ assert }) => {
    // « Éclairé » (art. 4.11) suppose que la personne ait LU les noms. Une
    // liste tenue à côté du texte ne vaut rien si le texte dit « nos
    // partenaires ».
    const entree = resolvePartnerConsent(CURRENT_PARTNER_CONSENT_VERSION)!

    for (const partenaire of entree.partenaires) {
      assert.include(entree.texte, partenaire)
    }
  })

  test('une version inconnue ne se résout pas, même proche', ({ assert }) => {
    assert.isNull(resolvePartnerConsent('2026-08-25'))
    assert.isNull(resolvePartnerConsent(''))
    assert.isNull(resolvePartnerConsent(null))
    assert.isNull(resolvePartnerConsent(undefined))
  })
})

test.group('Autorisation de transmission', () => {
  test('seule une preuve écrite autorise', ({ assert }) => {
    assert.isTrue(isTransferable(RECORDED))

    for (const refus of REFUS) {
      assert.isFalse(isTransferable(refus), `« ${refus.state} » ne doit pas autoriser`)
    }
  })
})

test.group('E-mail interne | transmission partenaire', () => {
  test('la section est TOUJOURS présente sur un lead d’estimation', ({ assert }) => {
    // Contrairement à PROVENANCE, dont l'absence est sans conséquence : une
    // section manquante se lirait « pas d'information » et se traiterait comme
    // un feu vert par la première personne pressée.
    const sansBloc = renderInternalEmail(LEAD)
    const avecBloc = renderInternalEmail(LEAD, RECORDED)

    assert.include(sansBloc.text, 'TRANSMISSION PARTENAIRE')
    assert.include(avecBloc.text, 'TRANSMISSION PARTENAIRE')
  })

  test('accord prouvé : oui, et les destinataires sont nommés', ({ assert }) => {
    const section = buildPartnerConsentSection(RECORDED)

    assert.include(section, 'Transmissible a un partenaire : OUI')
    assert.include(section, 'Les Bons Biens, Dr House Immo')
    assert.include(section, CURRENT_PARTNER_CONSENT_VERSION)
  })

  test('tout état sans preuve dit NON, sans nuance', ({ assert }) => {
    for (const refus of REFUS) {
      const section = buildPartnerConsentSection(refus)

      assert.include(section, 'Transmissible a un partenaire : NON')
      assert.notInclude(section, ': OUI')
    }
  })

  test('une preuve non écrite est signalée comme telle, pas comme un refus', ({ assert }) => {
    // La distinction ne change pas la décision (ne pas transmettre) mais change
    // l'action : un refus se respecte, une écriture ratée se diagnostique.
    const section = buildPartnerConsentSection({
      state: 'not-stored',
      version: CURRENT_PARTNER_CONSENT_VERSION,
    })

    assert.include(section, "l'ecriture de la preuve a echoue")
  })

  test('le gabarit historique reste au-dessus de la nouvelle section', ({ assert }) => {
    // Non-régression : un commercial doit retrouver les coordonnées là où
    // elles ont toujours été, avant toute mention ajoutée depuis.
    const { text } = renderInternalEmail(LEAD, RECORDED)

    assert.isBelow(text.indexOf('COORDONNEES DU CLIENT'), text.indexOf('TRANSMISSION PARTENAIRE'))
  })
})

test.group('Alerte Discord | transmission partenaire', () => {
  test('les deux canaux rendent le même verdict', ({ assert }) => {
    const body = renderLeadNotification(
      LEAD,
      { reference: 'ABC123', mailStatus: 'sent', partnerConsent: RECORDED },
      DISCORD_SETTINGS
    )
    const champ = body.embeds[0].fields.find((f) => f.name === 'Transmission partenaire')

    assert.isDefined(champ)
    assert.include(champ!.value, 'Transmissible')
    assert.include(champ!.value, 'Les Bons Biens')
  })

  test('sans preuve, l’alerte interdit explicitement', ({ assert }) => {
    for (const refus of REFUS) {
      const body = renderLeadNotification(
        LEAD,
        { reference: 'ABC123', mailStatus: 'sent', partnerConsent: refus },
        DISCORD_SETTINGS
      )
      const champ = body.embeds[0].fields.find((f) => f.name === 'Transmission partenaire')

      assert.include(champ!.value, 'Non transmissible')
    }
  })

  test('le verdict est affiché même quand le contact ne l’est pas', ({ assert }) => {
    // La réponse ne contient aucune donnée personnelle : la masquer avec le
    // contact priverait le salon anonyme de la seule information qui décide de
    // la suite à donner.
    const body = renderLeadNotification(
      LEAD,
      { reference: 'ABC123', mailStatus: 'sent', partnerConsent: RECORDED },
      { ...DISCORD_SETTINGS, includeContact: false }
    )

    assert.isDefined(body.embeds[0].fields.find((f) => f.name === 'Transmission partenaire'))
  })
})
