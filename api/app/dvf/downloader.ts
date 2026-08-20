import { createHash } from 'node:crypto'
import { createGunzip } from 'node:zlib'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Téléchargement des fichiers DVF géolocalisés (Etalab) — spec §6.2, US-7.
 *
 * URL de référence, **vérifiée le 2026-08-19** :
 *   https://files.data.gouv.fr/geo-dvf/latest/csv/{annee}/departements/{dep}.csv.gz
 *
 * Elle répond `302` vers un bucket OVH S3 (`geo-dvf.s3.sbg.io.cloud.ovh.net`)
 * et expose un `ETag` ainsi qu'un `Last-Modified` exploitables pour la
 * vérification mensuelle de fraîcheur. Millésimes disponibles à cette date :
 * 2021 à 2025.
 *
 * Deux principes :
 *  1. **Jamais le fichier entier en mémoire.** Un département dense pèse
 *     plusieurs centaines de Mo décompressés ; tout est traité en flux.
 *  2. **Empreinte calculée sur l'octet compressé** reçu, en même temps que la
 *     décompression, ce qui permet de reconnaître un fichier déjà ingéré sans
 *     second passage (Annexe A.8).
 */

export interface DvfFileRef {
  annee: number
  codeDepartement: string
  url: string
}

export interface RemoteFileMetadata {
  etag: string | null
  lastModified: string | null
  contentLength: number | null
}

/** Construit l'URL du fichier DVF d'un département pour une année donnée. */
export function buildDvfUrl(baseUrl: string, annee: number, codeDepartement: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return `${base}/${annee}/departements/${codeDepartement.toUpperCase()}.csv.gz`
}

/**
 * Abstraction du téléchargement, pour que l'import soit testable **sans
 * réseau** : les tests injectent une implémentation qui rejoue un fichier
 * local. Aucun test de ce dépôt n'atteint files.data.gouv.fr.
 */
export interface DvfSource {
  /** Métadonnées sans télécharger le corps (requête HEAD). */
  head(url: string): Promise<RemoteFileMetadata>
  /** Flux d'octets compressés (gzip). */
  open(url: string): Promise<{ stream: Readable; metadata: RemoteFileMetadata }>
}

/** Implémentation HTTP réelle, fondée sur `fetch` (Node 18+). */
export class HttpDvfSource implements DvfSource {
  constructor(private readonly timeoutMs = 120_000) {}

  async head(url: string): Promise<RemoteFileMetadata> {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!response.ok) {
      throw new DvfDownloadError(
        `Le fichier DVF n'est pas accessible (HTTP ${response.status}) : ${url}`
      )
    }

    return readMetadata(response)
  }

  async open(url: string): Promise<{ stream: Readable; metadata: RemoteFileMetadata }> {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!response.ok || !response.body) {
      throw new DvfDownloadError(
        `Le téléchargement du fichier DVF a échoué (HTTP ${response.status}) : ${url}`
      )
    }

    return {
      stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      metadata: readMetadata(response),
    }
  }
}

function readMetadata(response: Response): RemoteFileMetadata {
  const length = response.headers.get('content-length')
  return {
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    contentLength: length ? Number.parseInt(length, 10) : null,
  }
}

export class DvfDownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DvfDownloadError'
  }
}

/**
 * Transform qui calcule une empreinte SHA-256 au fil de l'eau, sans rien
 * retenir : les octets sont réémis tels quels.
 */
export class Sha256Tap extends Transform {
  readonly #hash = createHash('sha256')
  #bytes = 0

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.#hash.update(chunk)
    this.#bytes += chunk.length
    this.push(chunk)
    callback()
  }

  get digest(): string {
    return this.#hash.copy().digest('hex')
  }

  get bytes(): number {
    return this.#bytes
  }
}

/**
 * Ouvre un fichier DVF et renvoie un flux **décompressé**, accompagné du
 * calculateur d'empreinte.
 *
 * L'empreinte n'est définitive qu'une fois le flux entièrement consommé :
 * l'appelant lit `tap.digest` après la fin du `pipeline`.
 */
export async function openDvfStream(
  source: DvfSource,
  url: string
): Promise<{ csv: Readable; tap: Sha256Tap; metadata: RemoteFileMetadata }> {
  const { stream, metadata } = await source.open(url)

  const tap = new Sha256Tap()
  const gunzip = createGunzip()

  // Chaînage manuel : on veut garder une référence sur `tap` et sur la sortie
  // décompressée, tout en propageant proprement les erreurs.
  stream.on('error', (error) => tap.destroy(error))
  tap.on('error', (error) => gunzip.destroy(error))

  stream.pipe(tap).pipe(gunzip)

  return { csv: gunzip, tap, metadata }
}

/**
 * Consomme un flux jusqu'à son terme sans rien conserver.
 * Utilisé pour calculer une empreinte lorsqu'aucune écriture n'est demandée.
 */
export async function drain(stream: Readable): Promise<void> {
  await pipeline(stream, async function* (iterable) {
    // On itère sans rien retenir : le contenu est délibérément jeté, seul
    // compte le fait d'avoir consommé le flux jusqu'au bout (l'empreinte
    // SHA-256 n'est définitive qu'à ce moment-là).
    for await (const chunk of iterable) {
      void chunk
    }
    yield undefined
  })
}
