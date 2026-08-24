-- marts.fct_visit_technology_daily — le trafic, par technologie de visite.
--
-- Grain : (jour, plateforme, catégorie d'appareil, navigateur). Répond à
-- « avec quoi visite-t-on le site » — utile pour repérer une régression
-- propre à un navigateur (le tunnel d'estimation qui casse sur Safari mobile,
-- par exemple), invisible dans une vue agrégée tous appareils confondus.
--
-- ÉCLATÉ EN QUATRE MARTS, PAS UN SEUL — voir `fct_site_traffic_daily.sql`
-- pour le raisonnement complet. Ne jamais recombiner appareil/navigateur avec
-- la géographie ou la source d'acquisition.
--
-- Pas de `sessions_estimation_start` ici : ce mart répond à une question
-- technique (quel appareil, quel navigateur), pas à une question de
-- performance d'acquisition — les deux marts qui portent cette colonne
-- (`fct_site_traffic_daily`, `fct_landing_page_daily`) sont ceux qui
-- répondent à « d'où vient le trafic et convertit-il ».
--
-- ⚠️ Consentement analytics modélisé et ⚠️ historique borné au 22/08/2026 :
-- voir `fct_site_traffic_daily.sql`, mêmes réserves.

CREATE OR REPLACE VIEW `${PROJECT}.marts.fct_visit_technology_daily`
OPTIONS (
  description = "Sessions par jour, plateforme, catégorie d'appareil et navigateur."
)
AS
SELECT
  session_date                                    AS date,
  platform,
  device_category,
  browser,
  COUNT(*)                                         AS sessions,
  COUNT(DISTINCT user_pseudo_id)                   AS users,
  COUNTIF(session_number = 1)                      AS new_sessions,
  COUNTIF(session_number > 1)                      AS returning_sessions,
  COUNTIF(is_engaged)                              AS engaged_sessions,
  SUM(engagement_time_msec) / 1000.0               AS engagement_time_sec,
  COUNTIF(consent_analytics_granted)               AS sessions_consent_analytics_granted
FROM `${PROJECT}.staging.stg_ga4__sessions`
GROUP BY date, platform, device_category, browser;
