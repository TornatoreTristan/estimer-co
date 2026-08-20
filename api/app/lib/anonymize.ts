import { createHash, createHmac } from 'node:crypto'

/**
 * Anonymisation du journal d'estimations — spec §2.6 (point 5) et §8.3.
 *
 * « `ip_hmac` = HMAC-SHA256(IP, `IP_HASH_SALT`) — **jamais l'IP en clair** ».
 *
 * Pourquoi un HMAC salé et non un simple SHA-256 : l'espace des adresses IPv4
 * fait 2^32 entrées. Un SHA-256 non salé se casse par force brute exhaustive
 * en quelques minutes sur un ordinateur portable — le condensat serait donc
 * une donnée personnelle déguisée. Le sel, conservé côté serveur et jamais
 * commité, rend l'attaque impossible sans compromission du serveur.
 *
 * Fonctions pures : le sel est passé en paramètre, pas lu dans
 * l'environnement, pour rester testable sans configuration.
 */

/** `null` en entrée ⇒ `null` en sortie : on ne journalise pas de valeur factice. */
export function hmacIp(ip: string | null | undefined, salt: string): string | null {
  if (!ip || ip.trim().length === 0) {
    return null
  }
  return createHmac('sha256', salt).update(ip.trim()).digest('hex')
}

/**
 * Le User-Agent n'est pas une donnée d'identification directe, mais il est
 * fortement discriminant combiné à d'autres signaux : on n'en conserve qu'un
 * condensat, suffisant pour reconnaître « le même client » sans conserver la
 * chaîne.
 */
export function hashUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent || userAgent.trim().length === 0) {
    return null
  }
  return createHash('sha256').update(userAgent.trim()).digest('hex')
}
