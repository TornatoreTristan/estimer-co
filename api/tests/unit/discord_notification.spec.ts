/*
|--------------------------------------------------------------------------
| Notification Discord des leads — configuration, rendu, envoi
|--------------------------------------------------------------------------
|
| Trois groupes, trois responsabilités :
|
|  - la CONFIGURATION doit refuser silencieusement tout ce qui n'est pas
|    exploitable (le canal se désactive, il ne casse rien) et ne jamais
|    laisser fuir l'URL du webhook, qui est un secret ;
|  - le RENDU doit tenir dans les limites de l'API Discord et ne laisser
|    aucun texte libre déclencher une mention ;
|  - le SERVICE ne doit JAMAIS lever, quelle que soit la panne en face.
|
| Tout est exercé sans réseau : `resolveDiscordSettings` prend un
| dictionnaire, `renderLeadNotification` est pure, et le service reçoit un
| `fetch` bouchonné.
|
*/
import { test } from '@japa/runner'

import {
  describeDiscordSettings,
  inspectDiscordSettings,
  isOfficialDiscordWebhook,
  isUsableWebhookUrl,
  parseDiscordMention,
  parseDiscordTimeout,
  resolveDiscordSettings,
  DISCORD_DEFAULTS,
  type DiscordSettings,
} from '#lib/discord_config'
import {
  buildAllowedMentions,
  renderLeadNotification,
  truncate,
} from '#services/discord_lead_renderer'
import { describeAcquisitionChannel } from '#services/lead_mail_renderer'
import { DiscordNotifierService } from '#services/discord_notifier_service'
import type { LeadPayload } from '#validators/lead'

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/jeton-secret-tres-long'

const LEAD_ESTIMATION = {
  kind: 'estimation',
  name: 'Camille Martin',
  email: 'camille@example.test',
  phone: '0612345678',
  consent: true,
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
  estimation: {
    status: 'ok',
    prixM2: 10_500,
    estimationMin: 640_000,
    estimationMoyenne: 682_500,
    estimationMax: 725_000,
    confidenceScore: 78,
    comparablesCount: 42,
  },
} as unknown as LeadPayload

function settingsFor(overrides: Partial<DiscordSettings> = {}): DiscordSettings {
  return {
    enabled: true,
    webhookUrl: WEBHOOK,
    timeoutMs: 1_000,
    includeContact: true,
    mention: '',
    username: 'Estimer mon bien',
    ...overrides,
  }
}

/** Le message complet, aplati en texte : pratique pour chercher une fuite. */
function flatten(body: unknown): string {
  return JSON.stringify(body)
}

test.group('Discord | configuration', () => {
  test('un webhook vide désactive le canal sans rien casser', ({ assert }) => {
    const settings = resolveDiscordSettings({}, { inProduction: true })

    assert.isFalse(settings.enabled)
    assert.equal(settings.webhookUrl, '')
    // Le défaut reste exploitable : le jour où l'URL est posée, rien d'autre
    // n'est à configurer.
    assert.equal(settings.timeoutMs, DISCORD_DEFAULTS.timeoutMs)
    assert.isTrue(settings.includeContact)
  })

  test('exige https en production, tolère http ailleurs', ({ assert }) => {
    // Le webhook est un secret : en clair sur le réseau, il est rejouable.
    assert.isFalse(
      isUsableWebhookUrl('http://discord.com/api/webhooks/1/x', { inProduction: true })
    )
    assert.isTrue(isUsableWebhookUrl('http://127.0.0.1:9797/x', { inProduction: false }))
    assert.isTrue(isUsableWebhookUrl(WEBHOOK, { inProduction: true }))
  })

  test('une URL inexploitable désactive le canal et le dit', ({ assert }) => {
    const settings = resolveDiscordSettings(
      { DISCORD_WEBHOOK_URL: 'coller-ici-l-url' },
      { inProduction: true }
    )

    assert.isFalse(settings.enabled)

    const { warnings } = inspectDiscordSettings(settings, { inProduction: true })
    assert.isTrue(warnings.some((message) => message.includes('DISCORD_WEBHOOK_URL')))
  })

  test('un hôte inattendu avertit sans désactiver', ({ assert }) => {
    // Certaines équipes routent par une passerelle : on prévient, on ne refuse pas.
    const settings = resolveDiscordSettings(
      { DISCORD_WEBHOOK_URL: 'https://passerelle.interne/leads' },
      { inProduction: true }
    )

    assert.isTrue(settings.enabled)
    assert.isFalse(isOfficialDiscordWebhook(settings.webhookUrl))
    const { warnings } = inspectDiscordSettings(settings, { inProduction: true })
    assert.isTrue(warnings.some((message) => message.includes('ne ressemble pas')))
  })

  test('le délai reste borné', ({ assert }) => {
    for (const invalid of [undefined, '', 'abc', '0', '-1', '999999']) {
      assert.equal(parseDiscordTimeout(invalid), DISCORD_DEFAULTS.timeoutMs)
    }
    assert.equal(parseDiscordTimeout('2500'), 2_500)
  })

  test('seules trois formes de mention sont acceptées', ({ assert }) => {
    assert.equal(parseDiscordMention('@here'), '@here')
    assert.equal(parseDiscordMention('@everyone'), '@everyone')
    assert.equal(parseDiscordMention('123456789'), '<@&123456789>')
    assert.equal(parseDiscordMention('<@&123456789>'), '<@&123456789>')

    // Une chaîne libre ne doit pas pouvoir décider qui se fait notifier.
    for (const invalid of [undefined, '', '@toute-lequipe', '<@123456789>', 'chef']) {
      assert.equal(parseDiscordMention(invalid), '')
    }
  })

  test('une mention non reconnue est signalée plutôt qu’ignorée en silence', ({ assert }) => {
    const settings = resolveDiscordSettings(
      { DISCORD_WEBHOOK_URL: WEBHOOK, DISCORD_MENTION: '@equipe' },
      { inProduction: true }
    )

    const { warnings } = inspectDiscordSettings(settings, {
      inProduction: true,
      rawMention: '@equipe',
    })
    assert.isTrue(warnings.some((message) => message.includes('DISCORD_MENTION')))
  })

  test('la vue journalisable ne contient JAMAIS l’URL du webhook', ({ assert }) => {
    const described = JSON.stringify(describeDiscordSettings(settingsFor()))

    assert.notInclude(described, 'jeton-secret-tres-long')
    assert.notInclude(described, WEBHOOK)
    assert.include(described, '"hasWebhook":true')
  })

  test('en production, transmettre des coordonnées est signalé', ({ assert }) => {
    const { warnings } = inspectDiscordSettings(settingsFor({ includeContact: true }), {
      inProduction: true,
    })

    // Rappel volontairement bruyant : Discord devient destinataire de données
    // personnelles, et cela doit figurer dans la politique de confidentialité.
    assert.isTrue(warnings.some((message) => message.includes('politique de confidentialité')))

    const anonyme = inspectDiscordSettings(settingsFor({ includeContact: false }), {
      inProduction: true,
    })
    assert.isEmpty(anonyme.warnings)
  })
})

test.group('Discord | rendu du message', () => {
  test('porte l’essentiel d’un lead d’estimation', ({ assert }) => {
    const body = renderLeadNotification(
      LEAD_ESTIMATION,
      { reference: 'ABC123', mailStatus: 'sent' },
      settingsFor()
    )

    const text = flatten(body)
    assert.include(text, 'Nouvelle demande d')
    assert.include(text, 'Appartement')
    assert.include(text, 'Paris')
    assert.include(text, 'ABC123')
    // Le montant est le premier chiffre que l'équipe cherche.
    assert.include(text, formatted(682_500))
    assert.include(text, 'Camille Martin')
    assert.include(text, 'camille@example.test')
    assert.include(text, '0612345678')
  })

  test('sans includeContact, AUCUNE donnée personnelle ne part', ({ assert }) => {
    const body = renderLeadNotification(
      { ...LEAD_ESTIMATION, message: 'Rappelez-moi au plus vite' } as LeadPayload,
      { reference: 'ABC123', mailStatus: 'sent' },
      settingsFor({ includeContact: false })
    )

    const text = flatten(body)
    assert.notInclude(text, 'Camille')
    assert.notInclude(text, 'camille@example.test')
    assert.notInclude(text, '0612345678')
    // L'adresse exacte désigne le domicile : elle tombe avec le reste.
    assert.notInclude(text, 'rue de la Paix')
    assert.notInclude(text, 'Rappelez-moi')

    // …mais l'alerte reste exploitable pour juger si le lead est dans le secteur.
    assert.include(text, 'Paris')
    assert.include(text, 'ABC123')
    assert.include(text, formatted(682_500))
  })

  test('signale un montant qui ne vient pas du DVF', ({ assert }) => {
    const body = renderLeadNotification(
      {
        ...LEAD_ESTIMATION,
        estimation: { ...LEAD_ESTIMATION.estimation!, status: 'static-fallback' },
      } as LeadPayload,
      { reference: 'ABC123', mailStatus: 'sent' },
      settingsFor()
    )

    assert.include(flatten(body), 'repli interne')
  })

  test('un e-mail interne en échec devient l’alerte principale', ({ assert }) => {
    const body = renderLeadNotification(
      LEAD_ESTIMATION,
      { reference: 'ABC123', mailStatus: 'failed' },
      settingsFor()
    )

    // Ce message est alors la SEULE trace du lead : il doit le dire.
    assert.include(flatten(body), 'NON transmis')
  })

  test('nomme le canal d’acquisition en clair', ({ assert }) => {
    // La règle du plan de taggage §10.1 : Google Ads n'envoie AUCUN UTM et se
    // reconnaît à son seul `gclid`.
    assert.equal(describeAcquisitionChannel({ gclid: 'EAIaIQobCh' }), 'Google Ads')
    assert.equal(describeAcquisitionChannel({ source: 'meta', medium: 'paid_social' }), 'Meta Ads')
    assert.equal(
      describeAcquisitionChannel({ source: 'newsletter', medium: 'email' }),
      'E-mailing (newsletter)'
    )
    assert.equal(
      describeAcquisitionChannel({ referrer: 'www.google.com' }),
      'Recherche naturelle (www.google.com)'
    )
    assert.equal(
      describeAcquisitionChannel({ referrer: 'www.leboncoin.fr' }),
      'Site référent (www.leboncoin.fr)'
    )
    // Ni campagne ni référent : on le dit, plutôt que d'inventer une origine.
    assert.equal(describeAcquisitionChannel({ landingPage: '/' }), 'Accès direct')
  })

  test('affiche la provenance et le détail de campagne', ({ assert }) => {
    const body = renderLeadNotification(
      {
        ...LEAD_ESTIMATION,
        acquisition: {
          gclid: 'EAIaIQobCh',
          campaign: 'gads_lead_proprietaire_idf_202608',
          landingPage: '/',
        },
      } as LeadPayload,
      { reference: 'ABC123', mailStatus: 'sent' },
      settingsFor()
    )

    const provenance = body.embeds[0].fields.find((field) => field.name === 'Provenance')
    assert.exists(provenance)
    assert.include(provenance!.value, 'Google Ads')
    assert.include(provenance!.value, 'gads_lead_proprietaire_idf_202608')
    assert.include(provenance!.value, '/')
  })

  test('la provenance reste affichée sur une alerte anonyme', ({ assert }) => {
    const body = renderLeadNotification(
      { ...LEAD_ESTIMATION, acquisition: { source: 'meta' } } as LeadPayload,
      { reference: 'ABC123', mailStatus: 'sent' },
      settingsFor({ includeContact: false })
    )

    // Le canal d'acquisition ne contient aucune donnée personnelle : le couper
    // avec les coordonnées ferait perdre l'information la plus regardée sans
    // rien protéger de plus.
    assert.include(flatten(body), 'Meta Ads')
  })

  test('une provenance absente est signalée comme telle', ({ assert }) => {
    const body = renderLeadNotification(
      LEAD_ESTIMATION,
      { reference: 'ABC123', mailStatus: 'sent' },
      settingsFor()
    )

    // À distinguer d'un « accès direct », qui est une information là où ceci
    // est une absence (front plus ancien, stockage refusé par le navigateur).
    const provenance = body.embeds[0].fields.find((field) => field.name === 'Provenance')
    assert.equal(provenance!.value, 'Non renseignée')
  })

  test('le message de contact porte aussi sa provenance', ({ assert }) => {
    const body = renderLeadNotification(
      {
        kind: 'contact',
        name: 'Marie Martin',
        email: 'marie@example.test',
        subject: 'partenariat',
        message: 'Bonjour',
        acquisition: { source: 'newsletter', medium: 'email' },
      } as unknown as LeadPayload,
      { reference: 'ABC123', mailStatus: 'sent' },
      settingsFor()
    )

    assert.include(flatten(body), 'E-mailing (newsletter)')
  })

  test('aucun texte libre ne peut déclencher une mention', ({ assert }) => {
    const body = renderLeadNotification(
      {
        kind: 'contact',
        name: '@everyone',
        email: 'robot@example.test',
        subject: 'autre',
        message: '@everyone @here <@&999999999>',
      } as unknown as LeadPayload,
      { reference: 'ABC123', mailStatus: 'sent' },
      settingsFor()
    )

    // `parse: []` : Discord ne notifie rien de ce qui RESSEMBLE à une mention.
    assert.deepEqual(body.allowed_mentions, { parse: [] })
    assert.equal(body.content, '')
  })

  test('la mention configurée, elle, notifie bien', ({ assert }) => {
    assert.deepEqual(buildAllowedMentions('@here'), { parse: ['everyone'] })
    assert.deepEqual(buildAllowedMentions('<@&42424242>'), { parse: [], roles: ['42424242'] })

    const body = renderLeadNotification(
      LEAD_ESTIMATION,
      { reference: 'ABC123', mailStatus: 'sent' },
      settingsFor({ mention: '@here' })
    )
    assert.equal(body.content, '@here')
  })

  test('respecte les limites de l’API Discord', ({ assert }) => {
    const body = renderLeadNotification(
      {
        kind: 'contact',
        name: 'Robot Bavard',
        email: 'robot@example.test',
        subject: 'autre',
        message: 'x'.repeat(5_000),
      } as unknown as LeadPayload,
      { reference: 'ABC123', mailStatus: 'sent' },
      settingsFor()
    )

    // Au-delà de 1024 caractères par champ, Discord rejette le message EN BLOC :
    // un message de contact un peu long ferait disparaître l'alerte.
    for (const field of body.embeds[0].fields) {
      assert.isAtMost(field.value.length, 1_024)
    }
    assert.isAtMost(body.embeds[0].title.length, 256)
    assert.equal(truncate('abcdef', 3), 'ab…')
  })
})

test.group('Discord | envoi', () => {
  test('ne touche pas au réseau quand le canal est désactivé', async ({ assert }) => {
    let called = false
    const service = new DiscordNotifierService(settingsFor({ enabled: false }), async () => {
      called = true
      return new Response('', { status: 200 })
    })

    const result = await service.notifyLead(LEAD_ESTIMATION, {
      reference: 'ABC123',
      mailStatus: 'sent',
    })

    assert.equal(result.status, 'disabled')
    assert.isFalse(called)
  })

  test('poste un JSON valide sur l’URL du webhook', async ({ assert }) => {
    let seenUrl = ''
    let seenBody = ''
    const service = new DiscordNotifierService(settingsFor(), async (url, init) => {
      seenUrl = url
      seenBody = String(init.body)
      // 204 : la réponse d'un webhook Discord accepté. Un corps y est
      // interdit — d'où `null` et non `''`, qui ferait lever le constructeur.
      return new Response(null, { status: 204 })
    })

    const result = await service.notifyLead(LEAD_ESTIMATION, {
      reference: 'ABC123',
      mailStatus: 'sent',
    })

    assert.equal(result.status, 'sent')
    assert.equal(seenUrl, WEBHOOK)
    const parsed = JSON.parse(seenBody)
    assert.lengthOf(parsed.embeds, 1)
    assert.equal(parsed.username, 'Estimer mon bien')
  })

  test('un refus de Discord ne lève pas', async ({ assert }) => {
    const service = new DiscordNotifierService(
      settingsFor(),
      async () => new Response('unknown webhook', { status: 404 })
    )

    const result = await service.notifyLead(LEAD_ESTIMATION, {
      reference: 'ABC123',
      mailStatus: 'sent',
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.failureReason, 'rejected')
    assert.equal(result.httpStatus, 404)
  })

  test('une panne réseau ne lève pas', async ({ assert }) => {
    const service = new DiscordNotifierService(settingsFor(), async () => {
      throw new TypeError('fetch failed')
    })

    const result = await service.notifyLead(LEAD_ESTIMATION, {
      reference: 'ABC123',
      mailStatus: 'sent',
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.failureReason, 'network')
  })

  test('un salon qui ne répond pas est abandonné, pas attendu', async ({ assert }) => {
    const service = new DiscordNotifierService(settingsFor({ timeoutMs: 500 }), (_url, init) => {
      // Le service passe un AbortSignal : on ne fait que l'honorer, comme
      // `fetch` le ferait. Sans cette borne, le prospect attendrait le timeout
      // TCP du noyau devant son écran de chargement.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted due to timeout')
          error.name = 'TimeoutError'
          reject(error)
        })
      })
    })

    const startedAt = Date.now()
    const result = await service.notifyLead(LEAD_ESTIMATION, {
      reference: 'ABC123',
      mailStatus: 'sent',
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.failureReason, 'timeout')
    assert.isBelow(Date.now() - startedAt, 3_000)
  })
})

/** Même formatage que le rendu (ICU dépend de la version de Node). */
function formatted(value: number): string {
  return value.toLocaleString('fr-FR')
}
