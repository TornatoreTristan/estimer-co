import ipaddr from 'ipaddr.js'

/**
 * Résolution de l'adresse IP cliente derrière un proxy — spec §2.6.
 *
 * Enjeu de sécurité réel, pas un détail de configuration : le rate limiting
 * est indexé sur l'IP. Si l'on faisait confiance à `X-Forwarded-For` sans
 * vérifier de QUI vient la connexion, n'importe qui contournerait tous les
 * quotas en envoyant un en-tête différent à chaque requête :
 *
 *     curl -H 'X-Forwarded-For: 1.2.3.4' https://api.estimer.co/v1/geocode
 *
 * Règle appliquée (identique à l'algorithme de `proxy-addr`) :
 *   1. si la connexion TCP ne vient PAS d'un proxy déclaré dans TRUSTED_PROXY,
 *      `X-Forwarded-For` est purement et simplement ignoré ;
 *   2. sinon on parcourt la chaîne de DROITE à GAUCHE et l'on retient la
 *      première adresse qui n'est pas elle-même un proxy de confiance.
 *      La partie gauche de l'en-tête est fournie par le client : elle n'est
 *      jamais digne de confiance.
 *
 * Module pur : aucune dépendance à HttpContext, testable sans serveur.
 */

/** Plage de confiance compilée. */
export type TrustedRange = [ipaddr.IPv4 | ipaddr.IPv6, number]

/**
 * Compile la liste CSV de `TRUSTED_PROXY` en plages exploitables.
 *
 * Accepte les CIDR (`10.0.0.0/8`) et les adresses nues (`172.18.0.1`, traitée
 * comme un /32 ou /128). Les entrées invalides sont ignorées silencieusement
 * plutôt que de faire tomber le service : une plage mal orthographiée doit
 * réduire la confiance accordée, jamais l'augmenter.
 */
export function parseTrustedProxies(csv: string | undefined | null): TrustedRange[] {
  if (!csv) {
    return []
  }

  const ranges: TrustedRange[] = []

  for (const rawEntry of csv.split(',')) {
    const entry = rawEntry.trim()
    if (entry.length === 0) {
      continue
    }

    try {
      if (entry.includes('/')) {
        ranges.push(ipaddr.parseCIDR(entry) as TrustedRange)
      } else {
        const addr = ipaddr.parse(entry)
        ranges.push([addr, addr.kind() === 'ipv4' ? 32 : 128])
      }
    } catch {
      // Entrée illisible : ignorée volontairement.
    }
  }

  return ranges
}

/**
 * Message d'alerte au démarrage si `TRUSTED_PROXY` est vide en production.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE N'EST PAS UNE FAILLE, C'EST UNE PANNE SILENCIEUSE DE QUOTA
 * ══════════════════════════════════════════════════════════════════════════
 * Le défaut est **fermé** : sans plage de confiance, `X-Forwarded-For` est
 * ignoré, donc personne ne peut forger son IP. Mais derrière un reverse proxy
 * — la topologie de production, §2.2 — toutes les connexions TCP arrivent
 * alors avec l'adresse du proxy. `resolveClientIp` rend cette même adresse
 * pour **tout le trafic** : les quotas du §2.6 (10 req/min, 60 req/jour)
 * deviennent un compteur unique partagé par l'ensemble des visiteurs.
 *
 * Concrètement : dix visiteurs légitimes dans la même minute, et le onzième
 * reçoit un 429. Rien dans les journaux ne le dit — d'où cette alerte.
 *
 * **Fonction pure** : elle rend le message, elle ne journalise pas. C'est ce
 * qui permet de la tester sans démarrer le serveur.
 *
 * @returns le message à journaliser, ou `null` si la configuration est saine.
 */
export function trustedProxyStartupWarning(
  trustedProxy: string | undefined | null,
  nodeEnv: string | undefined
): string | null {
  if (nodeEnv !== 'production') {
    return null
  }
  if (parseTrustedProxies(trustedProxy).length > 0) {
    return null
  }

  return (
    'TRUSTED_PROXY est vide en production : X-Forwarded-For est ignoré (défaut fermé, ' +
    'aucune IP ne peut être forgée), mais derrière un reverse proxy toutes les requêtes ' +
    'partagent alors l’adresse du proxy — donc UN SEUL quota pour tout le trafic (§2.6). ' +
    'Déclarez la ou les plages CIDR du proxy, ex. TRUSTED_PROXY=10.0.0.0/8,172.16.0.0/12.'
  )
}

/**
 * Normalise une adresse : retire le port éventuel, les crochets IPv6 et
 * ramène les adresses IPv4 mappées en IPv6 (`::ffff:10.0.0.1`) à leur forme
 * IPv4. Sans cette dernière étape, un proxy déclaré en `10.0.0.0/8` ne serait
 * pas reconnu lorsque Node présente la connexion en IPv6 mappé.
 */
export function normalizeIp(value: string | undefined | null): string | null {
  if (!value) {
    return null
  }

  let candidate = value.trim()
  if (candidate.length === 0) {
    return null
  }

  // Forme « [::1]:1234 »
  const bracketed = candidate.match(/^\[(.+)\](?::\d+)?$/)
  if (bracketed) {
    candidate = bracketed[1]
  } else if (candidate.split(':').length === 2) {
    // Forme « 1.2.3.4:1234 » (un seul « : » ⇒ ce n'est pas une IPv6).
    candidate = candidate.split(':')[0]
  }

  if (!ipaddr.isValid(candidate)) {
    return null
  }

  const parsed = ipaddr.parse(candidate)
  if (parsed.kind() === 'ipv6') {
    const asV6 = parsed as ipaddr.IPv6
    if (asV6.isIPv4MappedAddress()) {
      return asV6.toIPv4Address().toString()
    }
  }

  return parsed.toString()
}

/** Indique si `ip` appartient à l'une des plages de confiance. */
export function isTrustedProxy(ip: string, ranges: TrustedRange[]): boolean {
  if (ranges.length === 0) {
    return false
  }

  const normalized = normalizeIp(ip)
  if (!normalized) {
    return false
  }

  const addr = ipaddr.parse(normalized)

  return ranges.some(([rangeAddr, prefix]) => {
    // `match` lève si les familles diffèrent (IPv4 comparé à IPv6).
    if (addr.kind() !== rangeAddr.kind()) {
      return false
    }
    return addr.match(rangeAddr, prefix)
  })
}

export interface ResolveClientIpInput {
  /** Adresse de la connexion TCP (`request.socket.remoteAddress`). */
  remoteAddress: string | undefined | null
  /** Valeur brute de l'en-tête `X-Forwarded-For`, si présente. */
  forwardedFor?: string | string[] | undefined | null
  /** Plages de proxies de confiance issues de `TRUSTED_PROXY`. */
  trustedProxies: TrustedRange[]
}

/**
 * Renvoie l'IP cliente réelle, ou `null` si elle est indéterminable.
 *
 * Le `null` est significatif : l'appelant doit alors refuser de servir un
 * quota « anonyme » partagé et retomber sur une clé constante (voir
 * `rateLimitKey`), ce qui revient à appliquer la limite la plus stricte.
 */
export function resolveClientIp(input: ResolveClientIpInput): string | null {
  const remote = normalizeIp(input.remoteAddress)

  // Connexion directe (ou proxy non déclaré) : l'en-tête est ignoré.
  if (!remote || !isTrustedProxy(remote, input.trustedProxies)) {
    return remote
  }

  const header = Array.isArray(input.forwardedFor)
    ? input.forwardedFor.join(',')
    : input.forwardedFor

  if (!header) {
    return remote
  }

  const chain = header
    .split(',')
    .map((part) => normalizeIp(part))
    .filter((part): part is string => part !== null)

  if (chain.length === 0) {
    return remote
  }

  // Parcours de droite à gauche : on saute les proxies de confiance.
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index]
    if (!isTrustedProxy(candidate, input.trustedProxies)) {
      return candidate
    }
  }

  // Toute la chaîne est composée de proxies de confiance : on retient
  // l'adresse la plus à gauche, qui est la plus proche du client.
  return chain[0]
}

/**
 * Clé de rate limiting. Quand l'IP est indéterminable, toutes les requêtes
 * concernées partagent la même clé : on préfère limiter trop que pas assez.
 */
export function rateLimitKey(scope: string, ip: string | null): string {
  return `${scope}:${ip ?? 'unknown'}`
}
