import { randomUUID } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'

import { validateEstimationPayload } from '#validators/estimation'
import { EstimationService, type EstimationContext } from '#services/estimation_service'
import { DataVersionService } from '#services/data_version_service'
import type { EstimationRequest } from '#services/estimation_types'

/**
 * `POST /v1/estimations` — spec §6.1.
 *
 * | Code | Cas |
 * |------|-----|
 * | 200  | succès, **y compris** repli `no-dvf` et `not-supported` |
 * | 403  | Origin absente ou hors liste (garde d'`Origin`, production) |
 * | 422  | payload invalide, champ interdit ou non déclaré |
 * | 429  | quota dépassé (`Retry-After`) |
 * | 503  | base vide ou dépendance critique indisponible |
 * | 500  | erreur inattendue — **jamais de trace ni de message SQL** |
 *
 * 403, 422, 429 et 500 sont rendus par `app/exceptions/handler.ts`, qui est
 * la source unique de vérité du format d'erreur : dupliquer ces réponses ici
 * mènerait tôt ou tard à deux formats divergents pour le même code HTTP.
 *
 * **C'est ici, et nulle part en aval, que le calcul touche à l'horloge** :
 * `referenceDate` est déterminée puis injectée. Le moteur de valorisation et
 * la cascade n'appellent jamais `new Date()`.
 */
export default class EstimationsController {
  async store(ctx: HttpContext) {
    const { request, response } = ctx

    const payload = await validateEstimationPayload(request.body())

    /*
     * 503 — « base vide, import en cours bloquant, ou dépendance critique
     * indisponible » (§6.1). Une base sans aucune mutation ne peut produire
     * qu'un `not-supported` sur toute la France : autant le dire franchement
     * plutôt que de laisser croire à un problème de couverture locale.
     */
    /*
     * `current()` est mémorisée 60 s côté service, et le résultat est
     * **transmis** à `estimate()` : une requête d'estimation ne provoque donc
     * plus qu'une seule lecture d'inventaire, au lieu de deux jeux complets
     * (contrôleur + service) exécutés même sur un succès de cache.
     */
    const version = await new DataVersionService().current()
    if (!version.hasMutations) {
      return response.status(503).send({
        code: 'DATA_UNAVAILABLE',
        message:
          'Les données de transactions ne sont pas encore disponibles. Réessayez dans quelques instants.',
      })
    }

    const context: EstimationContext = {
      requestId: request.id() ?? randomUUID(),
      referenceDate: new Date().toISOString().slice(0, 10),
      clientIp: ctx.clientIp,
      userAgent: request.header('user-agent') ?? null,
    }

    const result = await new EstimationService().estimate(
      payload as EstimationRequest,
      context,
      version
    )

    if (version.datasetVersion) {
      response.header('X-Data-Version', version.datasetVersion)
    }

    return response.ok(result)
  }
}
