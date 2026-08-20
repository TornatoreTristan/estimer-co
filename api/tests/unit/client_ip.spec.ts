import { test } from '@japa/runner'
import {
  isTrustedProxy,
  normalizeIp,
  parseTrustedProxies,
  rateLimitKey,
  resolveClientIp,
  trustedProxyStartupWarning,
} from '#lib/client_ip'

/**
 * Résolution de l'IP cliente derrière un proxy — spec §2.6.
 *
 * Enjeu réel : le rate limiting est indexé sur l'IP. Une erreur ici rend tous
 * les quotas contournables avec un simple en-tête forgé.
 */

const TRUSTED = parseTrustedProxies('10.0.0.0/8,127.0.0.1/32')

test.group('IP | alerte de configuration au démarrage (§2.6)', () => {
  test('un TRUSTED_PROXY vide en production est signalé', ({ assert }) => {
    /*
     * Le défaut est fermé — `X-Forwarded-For` est ignoré, aucune IP ne peut
     * être forgée — mais derrière un reverse proxy toutes les connexions
     * portent l'adresse du proxy : les quotas du §2.6 deviennent alors UN
     * SEUL compteur pour l'ensemble du trafic. Dix visiteurs légitimes dans
     * la même minute, et le onzième reçoit un 429. Rien ne le détectait.
     */
    const warning = trustedProxyStartupWarning('', 'production')

    assert.isString(warning)
    assert.include(warning!, 'TRUSTED_PROXY')
    assert.match(warning!, /un seul quota/i)
  })

  test('une configuration valide, ou hors production, ne dit rien', ({ assert }) => {
    assert.isNull(trustedProxyStartupWarning('10.0.0.0/8', 'production'))
    assert.isNull(trustedProxyStartupWarning('', 'development'))
    assert.isNull(trustedProxyStartupWarning(undefined, 'test'))
  })

  test('une valeur entièrement illisible en production est signalée', ({ assert }) => {
    // Elle ne produit aucune plage exploitable : le symptôme est le même
    // qu'une variable vide.
    assert.isString(trustedProxyStartupWarning('pas-une-ip, 999.999.999.999/8', 'production'))
  })
})

test.group('IP | analyse de TRUSTED_PROXY', () => {
  test('accepte les CIDR et les adresses nues', ({ assert }) => {
    assert.lengthOf(parseTrustedProxies('10.0.0.0/8,172.18.0.1'), 2)
  })

  test('ignore les entrées vides ou illisibles sans faire tomber le service', ({ assert }) => {
    // Une plage mal orthographiée doit réduire la confiance accordée,
    // jamais l'augmenter.
    const ranges = parseTrustedProxies('10.0.0.0/8, , pas-une-ip, 999.999.999.999/8')
    assert.lengthOf(ranges, 1)
  })

  test('une variable absente ne donne aucune plage de confiance', ({ assert }) => {
    assert.lengthOf(parseTrustedProxies(undefined), 0)
    assert.lengthOf(parseTrustedProxies(''), 0)
  })
})

test.group('IP | normalisation', () => {
  test('ramène une IPv4 mappée en IPv6 à sa forme IPv4', ({ assert }) => {
    // Sans cela, un proxy déclaré en 10.0.0.0/8 ne serait pas reconnu quand
    // Node présente la connexion en IPv6 mappé.
    assert.equal(normalizeIp('::ffff:10.0.0.1'), '10.0.0.1')
  })

  test('retire le port et les crochets', ({ assert }) => {
    assert.equal(normalizeIp('1.2.3.4:5678'), '1.2.3.4')
    assert.equal(normalizeIp('[::1]:5678'), '::1')
  })

  test('rejette ce qui n’est pas une adresse', ({ assert }) => {
    assert.isNull(normalizeIp('pas-une-ip'))
    assert.isNull(normalizeIp(''))
    assert.isNull(normalizeIp(undefined))
  })

  test('reconnaît l’appartenance à une plage', ({ assert }) => {
    assert.isTrue(isTrustedProxy('10.1.2.3', TRUSTED))
    assert.isTrue(isTrustedProxy('::ffff:10.1.2.3', TRUSTED))
    assert.isFalse(isTrustedProxy('192.0.2.10', TRUSTED))
    // Familles différentes : aucune correspondance, et surtout aucune erreur.
    assert.isFalse(isTrustedProxy('2001:db8::1', TRUSTED))
  })
})

test.group('IP | résolution derrière proxy', () => {
  test("X-Forwarded-For est IGNORÉ si la connexion ne vient pas d'un proxy déclaré", ({
    assert,
  }) => {
    /*
     * LE test de sécurité du lot. Sans cette règle :
     *   curl -H 'X-Forwarded-For: 1.2.3.4' …
     * suffirait à obtenir un quota neuf à chaque requête.
     */
    const ip = resolveClientIp({
      remoteAddress: '203.0.113.7',
      forwardedFor: '1.2.3.4',
      trustedProxies: TRUSTED,
    })

    assert.equal(ip, '203.0.113.7')
  })

  test('X-Forwarded-For est lu quand la connexion vient du proxy', ({ assert }) => {
    const ip = resolveClientIp({
      remoteAddress: '10.0.0.5',
      forwardedFor: '203.0.113.7',
      trustedProxies: TRUSTED,
    })

    assert.equal(ip, '203.0.113.7')
  })

  test('la chaîne est parcourue de droite à gauche, en sautant les proxies', ({ assert }) => {
    // La partie gauche est fournie par le client : jamais digne de confiance.
    const ip = resolveClientIp({
      remoteAddress: '10.0.0.5',
      forwardedFor: '9.9.9.9, 203.0.113.7, 10.0.0.9',
      trustedProxies: TRUSTED,
    })

    assert.equal(ip, '203.0.113.7')
  })

  test("une IP forgée à gauche ne peut pas usurper l'identité du client", ({ assert }) => {
    /*
     * Le client envoie « X-Forwarded-For: 1.2.3.4 » ; le proxy Coolify y
     * ajoute la vraie IP. On doit retenir celle ajoutée par le proxy.
     */
    const ip = resolveClientIp({
      remoteAddress: '10.0.0.5',
      forwardedFor: '1.2.3.4, 198.51.100.42',
      trustedProxies: TRUSTED,
    })

    assert.equal(ip, '198.51.100.42')
  })

  test('une chaîne entièrement composée de proxies retient l’adresse la plus à gauche', ({
    assert,
  }) => {
    const ip = resolveClientIp({
      remoteAddress: '10.0.0.5',
      forwardedFor: '10.0.0.1, 10.0.0.2',
      trustedProxies: TRUSTED,
    })

    assert.equal(ip, '10.0.0.1')
  })

  test('sans TRUSTED_PROXY configuré, l’en-tête est toujours ignoré', ({ assert }) => {
    const ip = resolveClientIp({
      remoteAddress: '10.0.0.5',
      forwardedFor: '1.2.3.4',
      trustedProxies: [],
    })

    assert.equal(ip, '10.0.0.5')
  })

  test('un en-tête absent ou vide retombe sur l’adresse de connexion', ({ assert }) => {
    assert.equal(
      resolveClientIp({ remoteAddress: '10.0.0.5', trustedProxies: TRUSTED }),
      '10.0.0.5'
    )
    assert.equal(
      resolveClientIp({ remoteAddress: '10.0.0.5', forwardedFor: '', trustedProxies: TRUSTED }),
      '10.0.0.5'
    )
  })

  test('une adresse de connexion inconnue donne null', ({ assert }) => {
    assert.isNull(resolveClientIp({ remoteAddress: undefined, trustedProxies: TRUSTED }))
  })
})

test.group('IP | clé de rate limiting', () => {
  test('la clé est préfixée par la portée pour ne pas mélanger les compteurs', ({ assert }) => {
    assert.equal(rateLimitKey('geocode', '203.0.113.7'), 'geocode:203.0.113.7')
    assert.notEqual(rateLimitKey('geocode', '1.1.1.1'), rateLimitKey('global', '1.1.1.1'))
  })

  test('une IP indéterminable partage une clé commune, donc la limite la plus stricte', ({
    assert,
  }) => {
    // On préfère limiter trop que pas assez.
    assert.equal(rateLimitKey('geocode', null), 'geocode:unknown')
  })
})
