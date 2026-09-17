import { randomUUID } from 'node:crypto'

/**
 * En-tête `Idempotency-Key`, obligatoire sur tout `POST /v1/blog/**` (§4,
 * B3). L'outil MCP en génère une par défaut, mais accepte une clé fournie
 * par l'IA pour permettre un rejeu explicite (même clé → même réponse,
 * spec B2/B3).
 */
export function resolveIdempotencyKey(provided?: string): string {
  const trimmed = provided?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : randomUUID()
}
