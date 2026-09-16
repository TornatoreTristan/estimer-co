-- marts.fct_site_traffic_daily — le trafic du site, par canal d'acquisition.
--
-- Grain : (jour, plateforme, source UTM, support UTM, host du référent).
-- Répond à « d'où vient le trafic » sans passer par `fct_marketing_performance_daily`,
-- dont le grain campagne exclut de fait tout ce qui n'a pas de `campaign_id` —
-- direct, organique, référent externe.
--
-- ÉCLATÉ EN QUATRE MARTS, PAS UN SEUL — ce mart, `fct_landing_page_daily`,
-- `fct_visit_technology_daily` et `fct_visit_geography_daily` partagent le
-- même jeu de métriques mais jamais leurs dimensions entre eux. Croiser
-- géographie + appareil + navigateur + source à faible volume transforme un
-- agrégat en quasi-identifiant individuel : sur une journée à trois sessions
-- « France, Safari, mobile, google_ads/campagne-x », il ne reste plus grand
-- monde derrière la ligne. Ne jamais recombiner ces dimensions dans une
-- requête qui joindrait ces quatre marts entre eux.
--
-- `referrer_host` est extrait de `landing_page_referrer` (ajouté à
-- `stg_ga4__sessions` pour ce mart) : on ne garde que le domaine, jamais
-- l'URL complète, qui peut porter des paramètres de recherche ou une session
-- id du site tiers.
--
-- AUTO-RÉFÉRENTS EXCLUS. `estimer.co` et ses sous-domaines apparaissent
-- massivement dans `page_referrer` : c'est de la navigation interne, pas une
-- provenance. Les laisser afficherait le site comme sa propre première source
-- de trafic. Ils retombent donc à NULL, au même titre qu'une visite directe.
-- C'est une règle métier, d'où sa place ici plutôt que dans `staging`, que
-- l'en-tête de `stg_ga4__events.sql` impose de garder bête.
--
-- ⚠️ Consentement analytics modélisé : une session dont le consentement GA4
-- est refusé est statistiquement modélisée par Google (Consent Mode), pas
-- mesurée directement. `sessions_consent_analytics_granted` isole les
-- sessions réellement observées ; le reste peut varier avec les mises à jour
-- du modèle de Google, indépendamment de tout changement de trafic réel.
--
-- ⚠️ L'entrepôt commence au 22/08/2026 (voir docs/specs/warehouse-module.md
-- §12) : aucune période antérieure n'existe, et n'existera jamais par
-- construction — ce n'est pas une donnée manquante.

CREATE OR REPLACE VIEW `${PROJECT}.marts.fct_site_traffic_daily`
OPTIONS (
  description = "Trafic du site par jour, plateforme, source et support UTM, et host du référent."
)
AS
SELECT
  session_date                                                    AS date,
  platform,
  utm_source,
  utm_medium,
  NULLIF(
    REGEXP_REPLACE(
      REGEXP_EXTRACT(landing_page_referrer, r'^https?://([^/:]+)'),
      r'(?i)^(?:.*\.)?estimer\.co$', ''
    ),
    ''
  )                                                               AS referrer_host,
  COUNT(*)                                                        AS sessions,
  COUNT(DISTINCT user_pseudo_id)                                  AS users,
  COUNTIF(session_number = 1)                                     AS new_sessions,
  COUNTIF(session_number > 1)                                     AS returning_sessions,
  COUNTIF(is_engaged)                                             AS engaged_sessions,
  SUM(engagement_time_msec) / 1000.0                              AS engagement_time_sec,
  COUNTIF(estimation_start_count > 0)                             AS sessions_estimation_start,
  COUNTIF(consent_analytics_granted)                              AS sessions_consent_analytics_granted
FROM `${PROJECT}.staging.stg_ga4__sessions`
GROUP BY date, platform, utm_source, utm_medium, referrer_host;
