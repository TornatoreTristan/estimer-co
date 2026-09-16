-- marts.fct_landing_page_daily — performance des pages d'entrée.
--
-- Grain : (jour, plateforme, page d'entrée). Répond à « quelle page amène le
-- trafic, et le retient-elle » — une question que le grain campagne de
-- `fct_marketing_performance_daily` ne peut pas poser, puisqu'il ignore la
-- page atterrie.
--
-- ÉCLATÉ EN QUATRE MARTS, PAS UN SEUL — voir `fct_site_traffic_daily.sql`
-- pour le raisonnement complet. Ne jamais recombiner `landing_page_path` avec
-- la géographie, l'appareil ou le navigateur dans une même requête : le
-- volume par page d'entrée est déjà faible certains jours, y ajouter une
-- dimension supplémentaire dé-anonymise vite le visiteur.
--
-- `single_page_sessions` compte les sessions n'ayant vu qu'une seule page
-- (`page_view_count = 1`) — l'équivalent maison d'un taux de rebond, sans
-- prétendre recalculer la métrique GA4 du même nom, qui a sa propre
-- définition (session non engagée) et vit déjà côté GA4 lui-même.
--
-- ⚠️ Consentement analytics modélisé et ⚠️ historique borné au 22/08/2026 :
-- voir `fct_site_traffic_daily.sql`, mêmes réserves.

CREATE OR REPLACE VIEW `${PROJECT}.marts.fct_landing_page_daily`
OPTIONS (
  description = "Sessions par jour, plateforme et page d'entrée, avec sessions mono-page et démarrages d'estimation."
)
AS
SELECT
  session_date                                    AS date,
  platform,
  landing_page_path,
  COUNT(*)                                         AS sessions,
  COUNT(DISTINCT user_pseudo_id)                   AS users,
  COUNTIF(session_number = 1)                      AS new_sessions,
  COUNTIF(session_number > 1)                      AS returning_sessions,
  COUNTIF(is_engaged)                              AS engaged_sessions,
  SUM(engagement_time_msec) / 1000.0               AS engagement_time_sec,
  COUNTIF(page_view_count = 1)                     AS single_page_sessions,
  COUNTIF(estimation_start_count > 0)              AS sessions_estimation_start,
  COUNTIF(consent_analytics_granted)               AS sessions_consent_analytics_granted
FROM `${PROJECT}.staging.stg_ga4__sessions`
GROUP BY date, platform, landing_page_path;
