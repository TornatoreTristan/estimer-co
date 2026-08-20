import { gzipSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import type { DvfSource, RemoteFileMetadata } from '#dvf/downloader'

/**
 * Source DVF bouchonnée — **aucun test de ce dépôt n'atteint le réseau**.
 *
 * Sert le CSV fourni, compressé en gzip, exactement comme le ferait
 * `files.data.gouv.fr`. Permet de valider le chemin complet (décompression en
 * flux, garde d'en-tête, COPY, transformation, idempotence) sans dépendre de
 * la disponibilité d'un service public ni télécharger plusieurs centaines de
 * Mo à chaque exécution de la CI.
 */
export class FakeDvfSource implements DvfSource {
  /** Nombre d'ouvertures réelles du flux — vérifie qu'on ne retélécharge pas. */
  public opens = 0
  public heads = 0

  readonly #files = new Map<string, Buffer>()

  /** Enregistre un CSV pour une URL donnée. */
  register(url: string, csv: string): void {
    this.#files.set(url, gzipSync(Buffer.from(csv, 'utf8')))
  }

  async head(url: string): Promise<RemoteFileMetadata> {
    this.heads += 1
    const file = this.#require(url)
    return this.#metadata(file)
  }

  async open(url: string): Promise<{ stream: Readable; metadata: RemoteFileMetadata }> {
    this.opens += 1
    const file = this.#require(url)
    return { stream: Readable.from([file]), metadata: this.#metadata(file) }
  }

  #require(url: string): Buffer {
    const file = this.#files.get(url)
    if (!file) {
      throw new Error(`Fichier DVF non bouchonné pour l'URL ${url}`)
    }
    return file
  }

  #metadata(file: Buffer): RemoteFileMetadata {
    return {
      // ETag stable et dérivé du contenu, comme un vrai stockage objet.
      etag: `"${createHash('md5').update(file).digest('hex')}"`,
      lastModified: 'Mon, 18 May 2026 13:14:12 GMT',
      contentLength: file.length,
    }
  }
}
