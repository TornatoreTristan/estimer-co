import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'

import {
  MUTATIONS_APPROXIMATE_COUNT_SQL,
  MUTATIONS_PRESENCE_SQL,
} from '#services/data_version_service'

/**
 * `GET /health` — spec §6.1.
 *
 * Sonde de readiness/liveness pour Coolify. **Hors rate limiting, hors CORS**
 * : une sonde ne doit jamais être bloquée par un quota, et un orchestrateur
 * n'envoie pas d'en-tête `Origin`.
 *
 * Renvoie 200 tant que le processus répond, avec `status: 'degraded'` si la
 * base est injoignable — un 503 ferait redémarrer le conteneur en boucle
 * pendant une maintenance de base, ce qui n'aiderait personne.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI AUCUNE REQUÊTE ICI N'EST EN O(n)
 * ══════════════════════════════════════════════════════════════════════════
 * Cette route cumule trois propriétés qui, ensemble, interdisent la moindre
 * requête coûteuse :
 *
 *   - elle est **hors quota et hors garde d'`Origin`** (`start/routes.ts`),
 *     donc appelable par n'importe quel tiers non authentifié, en boucle ;
 *   - elle est sondée **toutes les 30 s** par le `HEALTHCHECK` du `Dockerfile`,
 *     avec un timeout de 5 s ;
 *   - `mutations` atteint 6-7 M de lignes en production (Annexe A.9).
 *
 * Elle exécutait un `COUNT(*)` sans filtre sur `mutations` : un parcours
 * complet de table à chaque sonde. Deux conséquences, l'une aussi grave que
 * l'autre — le dépassement du timeout de 5 s met le conteneur en `unhealthy`
 * et déclenche une **boucle de redémarrage** alors que le service va très
 * bien, et n'importe qui peut amplifier trivialement la charge de la base
 * depuis l'extérieur.
 *
 * On reprend donc la correction déjà appliquée à `DataVersionService` (M2) :
 * `EXISTS` pour la présence de données, `pg_class.reltuples` pour l'ordre de
 * grandeur. Les deux sont en temps constant. Le SQL est **importé** de ce
 * service, pas recopié : deux copies, c'est la garantie qu'une seule des deux
 * sera corrigée la prochaine fois.
 */
export default class HealthController {
  async show({ response }: HttpContext) {
    let dbUp = false
    let hasMutations = false
    let mutationsCount = 0
    let lastImportAt: string | null = null

    try {
      await db.rawQuery('SELECT 1')
      dbUp = true

      const presence = await db.rawQuery(MUTATIONS_PRESENCE_SQL)
      hasMutations = presence?.rows?.[0]?.present === true

      /*
       * Ordre de grandeur, jamais un décompte exact : `reltuples` est
       * l'estimation du planificateur, rafraîchie par l'`ANALYZE` de fin
       * d'import. Elle vaut 0 tant qu'aucun `ANALYZE` n'a eu lieu — c'est
       * `hasMutations` qui dit la vérité sur la présence de données.
       */
      const approximate = await db.rawQuery(MUTATIONS_APPROXIMATE_COUNT_SQL)
      mutationsCount = Number(approximate?.rows?.[0]?.total ?? 0)

      /*
       * `dvf_imports` compte au plus quelques centaines de lignes (une par
       * département × millésime) et porte l'index `dvf_imports_dep_idx` :
       * cette lecture reste négligeable, contrairement à la précédente.
       */
      const lastImport = await db
        .from('dvf_imports')
        .select('finished_at')
        .where('status', 'success')
        .orderBy('finished_at', 'desc')
        .first()

      lastImportAt = lastImport?.finished_at ? new Date(lastImport.finished_at).toISOString() : null
    } catch {
      dbUp = false
    }

    return response.ok({
      status: dbUp ? 'ok' : 'degraded',
      db: dbUp,
      /** `true` dès qu'au moins une mutation existe — information exacte. */
      hasMutations,
      /** Ordre de grandeur (`reltuples`), pas un décompte exact. */
      mutationsCount,
      lastImportAt,
    })
  }
}
