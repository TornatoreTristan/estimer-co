/*
|--------------------------------------------------------------------------
| Routes — spec §6.1
|--------------------------------------------------------------------------
|
| Versionnement par préfixe `/v1`. Tout changement cassant crée `/v2` et
| l'ancienne version reste servie 6 mois.
|
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'
import {
  throttleEstimation,
  throttleEstimationDaily,
  throttleGeocode,
  throttleGlobal,
  throttleLead,
  throttleLeadDaily,
} from '#start/limiter'

const HealthController = () => import('#controllers/health_controller')
const MetaController = () => import('#controllers/meta_controller')
const GeocodeController = () => import('#controllers/geocode_controller')
const EstimationsController = () => import('#controllers/estimations_controller')
const LeadsController = () => import('#controllers/leads_controller')

/*
 * Sonde Coolify — HORS rate limiting et hors garde d'Origin (§6.1).
 * Un orchestrateur n'envoie pas d'en-tête `Origin` et ne doit jamais se voir
 * opposer un 429 : ce serait interpréter une protection anti-abus comme une
 * panne applicative, et provoquer des redémarrages en boucle.
 */
router.get('/health', [HealthController, 'show'])

router
  .group(() => {
    /*
     * Millésime des données. Consommé au build Astro : il doit répondre même
     * base vide, et rester accessible sans quota serré pour ne pas faire
     * échouer une CI front.
     */
    router.get('/meta/data-version', [MetaController, 'dataVersion'])

    // Proxy BAN caché — 30 req/min par IP.
    router.get('/geocode', [GeocodeController, 'show']).use(throttleGeocode)

    /*
     * Cœur du produit (§6.1). Deux quotas cumulés (§2.6) : 10 req/min pour
     * absorber une rafale, 60 req/jour pour borner un abus lent qui resterait
     * sous le seuil par minute. Les deux sont indispensables — l'un sans
     * l'autre laisse passer exactement le scénario que l'autre couvre.
     */
    router
      .post('/estimations', [EstimationsController, 'store'])
      .use([throttleEstimation, throttleEstimationDaily])

    /*
     * Flux transactionnel : coordonnées du prospect + contexte, transmis par
     * e-mail (Scaleway TEM). C'est le SEUL endpoint qui reçoit des données
     * personnelles, et il n'en persiste aucune.
     *
     * Quotas volontairement plus serrés que l'estimation (5/min, 20/jour) :
     * un abus ici fait partir des e-mails depuis notre domaine, et se paie en
     * réputation d'expéditeur, pas en CPU.
     */
    router.post('/leads', [LeadsController, 'store']).use([throttleLead, throttleLeadDaily])

    /*
     * Lot 3 — statistiques de marché (§6.1) :
     *   router.get('/marche/:codeInsee', [MarcheController, 'show']).use(throttleMarche)
     * Le limiteur `throttleMarche` est déjà défini dans `start/limiter.ts`.
     */
  })
  .prefix('/v1')
  // Garde d'Origin : actif en production uniquement (§2.6, point 3).
  .use([middleware.originGuard(), throttleGlobal])
