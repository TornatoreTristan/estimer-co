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
  throttleBlog,
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
const BlogArticlesController = () => import('#controllers/blog/articles_controller')
const BlogAuteursController = () => import('#controllers/blog/auteurs_controller')
const BlogCategoriesController = () => import('#controllers/blog/categories_controller')
const BlogJobsController = () => import('#controllers/blog/jobs_controller')

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
      // 4 Ko : limite PROPRE à cette route, en complément du garde générique
      // `BodySizeGuardMiddleware` (`start/kernel.ts`, avant le bodyparser).
      // Voir `app/middleware/max_body_size_middleware.ts` pour le détail.
      .use([middleware.maxBodySize({ bytes: 4096 }), throttleEstimation, throttleEstimationDaily])

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

/*
 * ══════════════════════════════════════════════════════════════════════════
 * Automatisation IA du blog — specs/blog-automatisation-ia.md
 * ══════════════════════════════════════════════════════════════════════════
 * Groupe SÉPARÉ du groupe `/v1` ci-dessus, et c'est délibéré (spec §4) :
 * appel serveur à serveur (l'agent IA), jamais depuis un navigateur — donc
 * PAS d'`originGuard` (qui n'a de sens que pour une requête avec `Origin`).
 * La sécurité vient d'ailleurs : jeton Bearer par client (`blogAuth`) et
 * quota dédié PAR CLIENT (`throttleBlog`), jamais par IP.
 *
 * `blogAuth` s'exécute AVANT `throttleBlog` sur CHAQUE route, jamais
 * l'inverse — et l'ordre compte : `throttleBlog` lit `ctx.blogClient.id`,
 * posé par `blogAuth`, pour que le quota soit par client et non par IP. Un
 * `.use([...])` au niveau du GROUPE s'exécuterait avant le `.use()` propre à
 * chaque route ; `throttleBlog` est donc répété route par route, juste après
 * `blogAuth`, plutôt que placé au niveau du groupe.
 *
 * `Idempotency-Key` (obligatoire sur tout `POST`, §4) est vérifié dans
 * chaque contrôleur juste avant la validation du payload — pas ici : un
 * en-tête manquant est une erreur de FORME (422), pas une question de
 * routage.
 */
router
  .group(() => {
    // B1/B2/B3 — création/mise à jour d'un brouillon.
    router
      .post('/articles', [BlogArticlesController, 'store'])
      .use([middleware.blogAuth({ scopes: ['articles:write'] }), throttleBlog])
    // §4 : consultation de l'état d'un article (main + PR ouverte éventuelle).
    router
      .get('/articles/:slug', [BlogArticlesController, 'show'])
      .use([middleware.blogAuth({ scopes: ['articles:write'] }), throttleBlog])
    // F — passage en publié, gate appliquée par le vrai script CI.
    router
      .post('/articles/:slug/publish', [BlogArticlesController, 'publish'])
      .use([middleware.blogAuth({ scopes: ['publish:request'] }), throttleBlog])

    // D1 — lecture ouverte à tout client authentifié, aucun scope requis.
    router
      .get('/auteurs', [BlogAuteursController, 'index'])
      .use([middleware.blogAuth(), throttleBlog])
    // D2 — création d'un auteur, PR distincte de celle d'un article.
    router
      .post('/auteurs', [BlogAuteursController, 'store'])
      .use([middleware.blogAuth({ scopes: ['auteurs:write'] }), throttleBlog])

    // E1 — source unique : `src/lib/blog.ts` de la copie de travail.
    router
      .get('/categories', [BlogCategoriesController, 'index'])
      .use([middleware.blogAuth(), throttleBlog])

    // G1/G2 — suivi d'une opération, visible uniquement par son client créateur.
    router.get('/jobs/:id', [BlogJobsController, 'show']).use([middleware.blogAuth(), throttleBlog])
  })
  .prefix('/v1/blog')
