/*
|--------------------------------------------------------------------------
| POST /v1/leads — chemin d'envoi transactionnel
|--------------------------------------------------------------------------
|
| Ce test couvre le dernier centimètre du dépôt de lead : la requête traverse
| la validation, le rendu des deux e-mails (interne + accusé de réception) et
| le transport `dry-run`, qui est le transport JSON de Nodemailer. Rien n'est
| bouchonné en dehors de la connexion SMTP elle-même.
|
| POURQUOI CE TEST EXISTE : `@adonisjs/mail` embarque Nodemailer, dont la
| montée de version est imposée par des advisories de sécurité récurrentes
| (injections SMTP/CRLF). Sans ce test, une montée de Nodemailer casse le
| rendu ou la construction du message sans qu'aucune suite ne s'en aperçoive —
| la panne ne se voit alors qu'en production, sur un lead perdu.
|
*/
import { test } from '@japa/runner'

const LEAD_ESTIMATION = {
  kind: 'estimation',
  name: 'Tristan Test',
  email: 'tristan@example.test',
  phone: '0612345678',
  message: 'Demande déposée par la suite de tests.',
  consent: true,
  property: {
    address: '12 rue de la Paix',
    postalCode: '75002',
    city: 'Paris',
    propertyType: 'appartement',
    surface: 65,
    rooms: 3,
    dpe: 'D',
  },
}

test.group('POST /v1/leads — envoi transactionnel', () => {
  test('construit et remet les deux e-mails via le transport dry-run', async ({
    client,
    assert,
  }) => {
    const response = await client.post('/v1/leads').json(LEAD_ESTIMATION)

    response.assertStatus(200)

    const body = response.body()

    // `dry-run` en environnement de test (cf. api/.env.test) : le message est
    // intégralement construit et sérialisé, aucune connexion SMTP n'est ouverte.
    assert.equal(body.status, 'dry-run')

    // L'accusé de réception au prospect est le second envoi : s'il est à
    // `true`, les DEUX messages ont été rendus et acceptés par le transport.
    assert.isTrue(body.acknowledgement)

    // La référence est le seul identifiant exposé au prospect pour retrouver
    // sa demande ; elle ne doit jamais être vide.
    assert.isString(body.reference)
    assert.isNotEmpty(body.reference)
  })

  test('rejette une demande d’estimation sans caractéristiques du bien', async ({
    client,
    assert,
  }) => {
    const { property, ...sansBien } = LEAD_ESTIMATION
    const response = await client.post('/v1/leads').json(sansBien)

    response.assertStatus(422)

    const body = response.body()
    assert.equal(body.code, 'VALIDATION_ERROR')

    // Le message est affiché tel quel par le front, sous le champ concerné :
    // il doit rester en français et sans jargon de règle.
    const erreurBien = body.errors.find((e: { field: string }) => e.field === 'property')
    assert.exists(erreurBien)
    assert.match(erreurBien.message, /obligatoires/)
  })
})
