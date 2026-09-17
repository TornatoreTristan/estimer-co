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
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'

import {
  archivedConsentText,
  CURRENT_PARTNER_CONSENT_VERSION,
  resolvePartnerConsent,
} from '#lib/partner_consent'

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

test.group('POST /v1/leads — envoi transactionnel', (group) => {
  /*
   * `/v1/leads` est plafonné à 5 requêtes par minute et par IP. Ce groupe en
   * émet davantage : sans remise à zéro, les derniers cas testeraient le
   * limiteur au lieu de ce qu'ils décrivent. Le plafond, lui, a son propre
   * fichier (`rate_limit.spec.ts`) — c'est là qu'il doit être vérifié.
   */
  group.each.setup(() => limiter.clear(['memory']))

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

  test('accepte la provenance du prospect', async ({ client }) => {
    const response = await client.post('/v1/leads').json({
      ...LEAD_ESTIMATION,
      acquisition: {
        gclid: 'EAIaIQobCh',
        campaign: 'gads_lead_proprietaire_idf_202608',
        referrer: 'www.google.com',
        landingPage: '/',
      },
    })

    response.assertStatus(200)
  })

  test('un accord partenaire laisse une preuve complète en base', async ({ client, assert }) => {
    /*
     * Le seul cas où `/v1/leads` écrit des coordonnées. Ce test vérifie les
     * trois propriétés qui rendent la ligne opposable : elle porte la même
     * référence que la réponse HTTP, elle archive le TEXTE et non un renvoi
     * vers lui, et elle ne contient rien sur le bien.
     */
    const response = await client.post('/v1/leads').json({
      ...LEAD_ESTIMATION,
      partnerConsent: { granted: true, version: CURRENT_PARTNER_CONSENT_VERSION },
    })

    response.assertStatus(200)
    const { reference } = response.body()

    const { rows } = await db.rawQuery(
      'SELECT * FROM partner_consents WHERE reference = ? LIMIT 1',
      [reference]
    )
    const preuve = rows[0]

    assert.exists(preuve, "Aucune preuve écrite alors que l'accord était donné.")
    assert.equal(preuve.email, LEAD_ESTIMATION.email)
    assert.equal(preuve.phone, LEAD_ESTIMATION.phone)
    assert.equal(preuve.consent_version, CURRENT_PARTNER_CONSENT_VERSION)

    // Le texte archivé est celui du registre serveur, pas une chaîne reçue —
    // bouton d'envoi compris, puisque c'est son clic qui vaut accord.
    const registre = resolvePartnerConsent(CURRENT_PARTNER_CONSENT_VERSION)!
    assert.equal(preuve.consent_text, archivedConsentText(registre))
    assert.include(preuve.consent_text, registre.texte)
    assert.deepEqual(preuve.partners, registre.partenaires)

    // Aucune donnée sur le bien : la preuve dit qui a consenti, pas à quoi il
    // ressemble. La colonne n'existe même pas — d'où le contrôle sur le schéma.
    assert.notProperty(preuve, 'address')
    assert.notProperty(preuve, 'city')

    // L'adresse IP n'est jamais stockée en clair, ici comme ailleurs.
    assert.isNull(preuve.withdrawn_at)
  })

  test('un refus n’écrit rien du tout', async ({ client, assert }) => {
    /*
     * Tenir la liste des personnes ayant refusé serait une collecte sans
     * finalité : le RGPD demande de démontrer un consentement, jamais son
     * absence.
     */
    const response = await client.post('/v1/leads').json({
      ...LEAD_ESTIMATION,
      partnerConsent: { granted: false, version: CURRENT_PARTNER_CONSENT_VERSION },
    })

    response.assertStatus(200)

    const { rows } = await db.rawQuery(
      'SELECT count(*)::int AS total FROM partner_consents WHERE reference = ?',
      [response.body().reference]
    )
    assert.equal(rows[0].total, 0)
  })

  test('une version inconnue n’écrit rien mais ne perd pas le lead', async ({ client, assert }) => {
    /*
     * Le cas d'un front déployé avant l'API, ou l'inverse. Refuser la demande
     * en 422 échangerait une case facultative contre un prospect perdu ; on
     * préfère livrer le lead sans preuve — l'e-mail interne le marque alors
     * comme non transmissible.
     */
    const response = await client.post('/v1/leads').json({
      ...LEAD_ESTIMATION,
      partnerConsent: { granted: true, version: '1999-01-01' },
    })

    response.assertStatus(200)

    const { rows } = await db.rawQuery(
      'SELECT count(*)::int AS total FROM partner_consents WHERE reference = ?',
      [response.body().reference]
    )
    assert.equal(rows[0].total, 0)
  })

  test('refuse un champ de consentement non déclaré', async ({ client, assert }) => {
    // Le texte de la case n'est PAS un champ d'entrée : l'accepter, même en le
    // jetant, ouvrirait la porte à une preuve dictée par le navigateur.
    const response = await client.post('/v1/leads').json({
      ...LEAD_ESTIMATION,
      partnerConsent: {
        granted: true,
        version: CURRENT_PARTNER_CONSENT_VERSION,
        texte: "J'accepte tout",
      },
    })

    response.assertStatus(422)
    const erreur = response
      .body()
      .errors.find((e: { field: string }) => e.field === 'partnerConsent.texte')
    assert.exists(erreur)
  })

  test('refuse un champ de provenance non déclaré', async ({ client, assert }) => {
    const response = await client.post('/v1/leads').json({
      ...LEAD_ESTIMATION,
      // Un identifiant de mesure n'a rien à faire dans un lead : la liste
      // blanche du validateur rend l'erreur bruyante au lieu de le laisser
      // passer en silence.
      acquisition: { source: 'meta', ga_client_id: 'GA1.1.123' },
    })

    response.assertStatus(422)
    const erreur = response
      .body()
      .errors.find((e: { field: string }) => e.field === 'acquisition.ga_client_id')
    assert.exists(erreur)
  })
})
