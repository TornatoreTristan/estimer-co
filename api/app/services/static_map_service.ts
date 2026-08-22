import logger from '@adonisjs/core/services/logger'
import env from '#start/env'

/**
 * Vignette de carte du bien, pour l'accusé de réception du prospect.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'IMAGE EST TÉLÉCHARGÉE ICI, PUIS ATTACHÉE AU MESSAGE
 * ══════════════════════════════════════════════════════════════════════════
 * L'alternative évidente — poser l'URL Static Maps dans un `<img src>` — a
 * l'air plus simple et coûte deux choses :
 *
 *  1. LA CLÉ. Cette URL est chargée par le proxy d'images de Gmail, qui
 *     n'envoie aucun référent : la clé devrait donc être ouverte à tous les
 *     référents. Elle serait alors lisible par tout destinataire, et
 *     consommable sur notre facture.
 *  2. LA DURÉE. Un e-mail est relu des mois plus tard. Une URL signée expire,
 *     un quota se coupe, une clé tourne — et la carte disparaît d'un message
 *     déjà envoyé. Une pièce jointe, elle, reste.
 *
 * Ce service NE LÈVE JAMAIS, pour la même raison que le notificateur Discord :
 * une carte manquante ne doit pas coûter un lead. Toute panne — clé absente,
 * quota Google, réseau — se traduit par `null`, et l'e-mail part sans carte.
 */

export interface StaticMapSettings {
  apiKey: string | null
  timeoutMs: number
}

export interface StaticMapImage {
  data: Buffer
  contentType: string
}

/** Signature minimale de `fetch`, pour injecter un bouchon en test. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export function staticMapSettingsFromEnv(): StaticMapSettings {
  return {
    apiKey: env.get('GOOGLE_MAPS_API_KEY') ?? null,
    timeoutMs: env.get('STATIC_MAP_TIMEOUT') ?? 4_000,
  }
}

/**
 * Dimensions de la vignette. La largeur suit le corps de l'e-mail moins ses
 * marges (600 − 2 × 32), et `scale=2` double la définition réelle : sur un
 * écran à haute densité — c'est-à-dire tous les téléphones, où la majorité des
 * e-mails sont lus — une image affichée à sa taille CSS native est floue.
 */
const MAP_WIDTH = 536
const MAP_HEIGHT = 220
const MAP_ZOOM = 15

/**
 * URL de la carte statique. **Fonction pure**, exportée pour les tests : c'est
 * la seule partie de ce service qu'on peut vérifier sans réseau.
 *
 * Le marqueur reprend l'orange de la charte, et le libellé est vide
 * (`label` absent) : une épingle nue se lit mieux qu'une épingle portant une
 * lettre qui ne veut rien dire.
 */
export function buildStaticMapUrl(lat: number, lon: number, apiKey: string): string {
  const center = `${lat.toFixed(6)},${lon.toFixed(6)}`
  const params = new URLSearchParams({
    center,
    zoom: String(MAP_ZOOM),
    size: `${MAP_WIDTH}x${MAP_HEIGHT}`,
    scale: '2',
    maptype: 'roadmap',
    markers: `color:0xff6e34|${center}`,
    language: 'fr',
    region: 'FR',
    key: apiKey,
  })

  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`
}

export class StaticMapService {
  constructor(
    private readonly settings: StaticMapSettings = staticMapSettingsFromEnv(),
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)
  ) {}

  get enabled(): boolean {
    return Boolean(this.settings.apiKey)
  }

  /**
   * Télécharge la vignette. Renvoie `null` — jamais d'exception — dès que
   * quelque chose manque : clé, coordonnées, réseau, réponse non-image.
   *
   * Le contrôle du type de contenu n'est pas de la paranoïa : quand une clé
   * est mal configurée ou son quota épuisé, Google répond **200** avec une
   * image d'erreur ou un corps texte. Sans ce garde-fou, on attacherait au
   * message du prospect une vignette barrée « for development purposes only ».
   */
  async fetchThumbnail(
    lat: number | null | undefined,
    lon: number | null | undefined
  ): Promise<StaticMapImage | null> {
    const apiKey = this.settings.apiKey
    if (!apiKey || lat === null || lat === undefined || lon === null || lon === undefined) {
      return null
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs)

    try {
      const response = await this.fetchImpl(buildStaticMapUrl(lat, lon, apiKey), {
        signal: controller.signal,
      })

      if (!response.ok) {
        logger.warn(
          { event: 'map.thumbnail_rejected', httpStatus: response.status },
          'Vignette de carte non obtenue — e-mail envoyé sans carte.'
        )
        return null
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.startsWith('image/')) {
        logger.warn(
          { event: 'map.thumbnail_not_an_image', contentType },
          'Google a répondu autre chose qu’une image — e-mail envoyé sans carte.'
        )
        return null
      }

      return {
        data: Buffer.from(await response.arrayBuffer()),
        contentType,
      }
    } catch (error) {
      logger.warn(
        {
          event: 'map.thumbnail_failed',
          error: error instanceof Error ? error.message : String(error),
        },
        'Vignette de carte indisponible — e-mail envoyé sans carte.'
      )
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
