import type { HttpContext } from '@adonisjs/core/http'
import { geocodeValidator } from '#validators/geocode'
import { GeocodingService } from '#services/geocoding_service'

/**
 * `GET /v1/geocode?q={texte}&postcode={cp}` — spec §6.1.
 *
 * Proxy caché de la BAN. Deux raisons de ne pas laisser le front appeler
 * directement `api-adresse.data.gouv.fr` (§1.2) :
 *  - mutualiser le cache et rester très en deçà des limites d'usage d'un
 *    service public gratuit ;
 *  - ne pas dépendre de la politique CORS d'un tiers.
 */
export default class GeocodeController {
  async show({ request, response }: HttpContext) {
    const { q, postcode, city } = await geocodeValidator.validate(request.qs())

    const result = await new GeocodingService().geocode({
      address: q,
      postalCode: postcode ?? '',
      city: city ?? '',
    })

    /*
     * 404 quand aucune position n'a pu être déterminée, même par repli
     * communal : sans coordonnées, la réponse n'est exploitable par personne.
     * Le service, lui, n'a pas rejeté — c'est le contrôleur qui traduit
     * l'absence de résultat en code HTTP.
     */
    if (result.lon === null || result.lat === null) {
      return response.notFound({
        code: 'NOT_FOUND',
        message: "Cette adresse n'a pas pu être localisée.",
      })
    }

    return response.ok({
      label: result.label,
      cityCode: result.cityCode,
      city: result.city,
      postcode: result.postcode,
      lon: result.lon,
      lat: result.lat,
      score: result.score,
      precision: result.precision,
      hasDvf: result.hasDvf,
    })
  }
}
