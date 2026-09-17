import sharp from 'sharp'

/**
 * Traitement des images fournies en base64 (C1-C3). Ce module ne connaît
 * QUE la conversion et les bornes de sécurité (taille, format) — jamais la
 * question de l'obligation d'`imageAlt`, qui reste dans le validateur Vine
 * (§ contraintes : « la gate de publication vient uniquement du script »).
 */

/** 10 Mo DÉCODÉS (spec C, dernier scénario) — le base64 lui-même peut donc être ~33 % plus volumineux. */
export const MAX_DECODED_IMAGE_BYTES = 10 * 1024 * 1024

export const IMAGE_MAX_WIDTH = 1600
export const IMAGE_WEBP_QUALITY = 80

export class InvalidImageError extends Error {}

/**
 * Détecte le format réel d'un buffer par sa SIGNATURE BINAIRE (spec :
 * « détection de format par signature binaire »), jamais par le `mimeType`
 * déclaré par l'appelant — un champ texte se falsifie sans effort, les
 * premiers octets d'un fichier beaucoup moins.
 */
export function detectImageFormat(buffer: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg'
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
    return 'png'
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  return null
}

export interface ProcessedImage {
  /** Contenu WebP prêt à écrire tel quel (`public/images/blog/<slug>.webp`). */
  buffer: Buffer
}

/**
 * Décode le base64, vérifie taille et signature, puis convertit en WebP
 * (largeur max 1600 px, qualité 80 — critères d'acceptation §C).
 *
 * Lève `InvalidImageError` (jamais autre chose) sur tout rejet : au
 * contrôleur de la traduire en 422 `{ field: "image" }`.
 */
export async function processImage(base64: string): Promise<ProcessedImage> {
  let buffer: Buffer
  try {
    buffer = Buffer.from(base64, 'base64')
  } catch {
    throw new InvalidImageError('Image illisible : encodage base64 invalide.')
  }

  if (buffer.length === 0) {
    throw new InvalidImageError('Image vide.')
  }

  if (buffer.length > MAX_DECODED_IMAGE_BYTES) {
    throw new InvalidImageError(
      `Image trop volumineuse une fois décodée (${buffer.length} octets, ${MAX_DECODED_IMAGE_BYTES} maximum).`
    )
  }

  const format = detectImageFormat(buffer)
  if (!format) {
    throw new InvalidImageError(
      'Format d’image non reconnu (JPEG, PNG ou WebP attendu, signature binaire invalide).'
    )
  }

  try {
    const webp = await sharp(buffer)
      .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: IMAGE_WEBP_QUALITY })
      .toBuffer()
    return { buffer: webp }
  } catch {
    throw new InvalidImageError('Image illisible : le décodeur a rejeté le contenu.')
  }
}
