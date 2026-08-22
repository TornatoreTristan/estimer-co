/*
|--------------------------------------------------------------------------
| POST /v1/leads — alerte Discord
|--------------------------------------------------------------------------
|
| Le rendu et les pannes du service sont couverts sans réseau par
| `tests/unit/discord_notification.spec.ts`. Ce fichier-ci couvre la seule
| chose que l'unitaire ne peut pas voir : le CÂBLAGE. Le contrôleur
| appelle-t-il vraiment le notifieur, avec la bonne référence, et un salon
| injoignable laisse-t-il le dépôt de lead intact ?
|
| Le webhook de `.env.test` pointe sur 127.0.0.1:9797 : ce test y démarre un
| bouchon HTTP, capture le corps posté, et le referme. Les autres tests
| fonctionnels qui déposent un lead tombent sur un refus de connexion
| immédiat — ce qui exerce gratuitement le chemin d'échec.
|
*/
import { createServer, type Server } from 'node:http'
import { test } from '@japa/runner'
import limiter from '@adonisjs/limiter/services/main'

const STUB_PORT = 9797

const LEAD_ESTIMATION = {
  kind: 'estimation',
  name: 'Tristan Test',
  email: 'tristan@example.test',
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
  },
}

/** Bouchon de webhook : répond 204 comme Discord et retient ce qu'on lui poste. */
function startWebhookStub(received: string[], status = 204): Promise<Server> {
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      received.push(body)
      response.writeHead(status).end()
    })
  })

  return new Promise((resolve) => server.listen(STUB_PORT, '127.0.0.1', () => resolve(server)))
}

function stopWebhookStub(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

test.group('POST /v1/leads — alerte Discord', (group) => {
  /*
   * `/v1/leads` est plafonné à 5 requêtes/minute par IP, et le store `memory`
   * est partagé par toute la campagne : sans remise à zéro, ce fichier ferait
   * échouer le suivant sur un 429 sans rapport avec ce qu'il teste.
   */
  group.each.setup(async () => {
    await limiter.clear(['memory'])
  })

  test('poste le lead dans le salon', async ({ client, assert }) => {
    const received: string[] = []
    const stub = await startWebhookStub(received)

    try {
      const response = await client.post('/v1/leads').json(LEAD_ESTIMATION)
      response.assertStatus(200)

      assert.lengthOf(received, 1)
      const body = JSON.parse(received[0])

      const embed = body.embeds[0]
      assert.include(embed.title, "Nouvelle demande d'estimation")

      // La référence relie l'alerte, l'e-mail et les journaux : sans elle,
      // impossible de retrouver un lead sans chercher par nom ou par e-mail.
      assert.include(embed.footer.text, response.body().reference)

      const flat = JSON.stringify(body)
      assert.include(flat, 'Paris')
      assert.include(flat, 'Tristan Test')

      // `.env.test` est en dry-run : l'alerte doit le dire, sans quoi on
      // croirait qu'un e-mail est parti.
      assert.include(flat, 'dry-run')
    } finally {
      await stopWebhookStub(stub)
    }
  })

  test('un salon injoignable ne fait pas perdre le lead', async ({ client, assert }) => {
    // Aucun bouchon démarré : la connexion est refusée immédiatement.
    const response = await client.post('/v1/leads').json(LEAD_ESTIMATION)

    // C'est l'invariant central de ce canal : il est accessoire.
    response.assertStatus(200)
    assert.equal(response.body().status, 'dry-run')
  })

  test('un webhook supprimé (404) ne fait pas perdre le lead', async ({ client, assert }) => {
    const received: string[] = []
    const stub = await startWebhookStub(received, 404)

    try {
      const response = await client.post('/v1/leads').json(LEAD_ESTIMATION)

      response.assertStatus(200)
      assert.lengthOf(received, 1)
    } finally {
      await stopWebhookStub(stub)
    }
  })

  test('une soumission de robot ne réveille personne', async ({ client, assert }) => {
    const received: string[] = []
    const stub = await startWebhookStub(received)

    try {
      const response = await client
        .post('/v1/leads')
        .json({ ...LEAD_ESTIMATION, website: 'http://spam.example' })

      // Piège à robots : 200 sans e-mail… et sans alerte. Un salon qui bipe
      // sur chaque passage d'automate cesse d'être regardé en une semaine.
      response.assertStatus(200)
      assert.isNull(response.body().reference)
      assert.lengthOf(received, 0)
    } finally {
      await stopWebhookStub(stub)
    }
  })
})
