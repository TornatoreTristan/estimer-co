import { createHash } from 'node:crypto'

/** Empreinte SHA-256 hexadécimale — jetons (BlogApiClient.tokenHash) et payloads d'idempotence. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Empreinte stable d'un payload JSON, pour détecter « même Idempotency-Key,
 * payload différent » (B3). `JSON.stringify` sur les clés déjà triées par
 * l'appelant : Node ne garantit l'ordre des clés QUE pour un objet construit
 * dans un ordre stable, d'où `canonicalJson`.
 */
export function hashPayload(payload: unknown): string {
  return sha256Hex(canonicalJson(payload))
}

/** Sérialise un JSON avec les clés d'objet triées, récursivement. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}
