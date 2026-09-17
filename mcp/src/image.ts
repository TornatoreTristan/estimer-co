import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ImageInput } from './types.js'

/**
 * Même borne que `MAX_DECODED_IMAGE_BYTES` côté API
 * (`api/app/services/blog/image_service.ts`) : au-delà, l'API refusera de
 * toute façon l'image en 422 une fois décodée — autant l'annoncer ici,
 * AVANT de charger le fichier entier en mémoire pour l'encoder en base64
 * (revue QA, mineur 4).
 */
export const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024

/**
 * Détection du type d'image (specs §7 : « accepte `imagePath` — lu et
 * encodé en base64 »). Même logique de SIGNATURE BINAIRE que
 * `api/app/services/blog/image_service.ts` (jamais l'extension seule) : le
 * `mimeType` envoyé à l'API n'est de toute façon que déclaratif, l'API le
 * revérifie par signature — mais un type correct évite un aller-retour 422
 * inutile.
 */
function detectMimeTypeFromBuffer(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

const EXTENSION_FALLBACK: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/**
 * Lit un fichier image local et l'encode en base64 pour `image`/`photo`
 * (§7). Le type est déduit de la signature binaire, avec un repli sur
 * l'extension du fichier si la signature n'est pas reconnue (ex. sur un
 * format encore accepté demain) — l'API tranchera de toute façon en dernier
 * ressort.
 */
export async function encodeImageFromPath(filePath: string): Promise<ImageInput> {
  let size: number
  try {
    size = (await stat(filePath)).size
  } catch (error) {
    throw new Error(
      `Impossible de lire le fichier image "${filePath}" : ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  if (size > MAX_IMAGE_FILE_BYTES) {
    throw new Error(
      `Image "${filePath}" trop volumineuse (${size} octets, ${MAX_IMAGE_FILE_BYTES} maximum) — ` +
        'redimensionnez ou recompressez le fichier avant de le fournir.'
    )
  }

  let buffer: Buffer
  try {
    buffer = await readFile(filePath)
  } catch (error) {
    throw new Error(
      `Impossible de lire le fichier image "${filePath}" : ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  const mimeType = detectMimeTypeFromBuffer(buffer) ?? EXTENSION_FALLBACK[path.extname(filePath).toLowerCase()]
  if (!mimeType) {
    throw new Error(
      `Impossible de déterminer le type de l'image "${filePath}" (signature binaire et extension ` +
        'toutes deux non reconnues). Utilisez un fichier JPEG, PNG ou WebP, ou fournissez ' +
        'imageBase64 + imageMimeType directement.'
    )
  }

  return { data: buffer.toString('base64'), mimeType }
}
