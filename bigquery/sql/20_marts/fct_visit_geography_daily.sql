-- marts.fct_visit_geography_daily — le trafic, par pays.
--
-- Grain : (jour, plateforme, pays). **Pays uniquement — jamais région ni
-- ville.** `stg_ga4__sessions` porte `geo_region` et `geo_city`, mais les
-- exposer ici romprait le principe même de ce mart : croiser une ville à
-- faible volume avec une plateforme et une journée identifie souvent un
-- visiteur précis plutôt qu'un agrégat. Le pays reste le grain le plus fin
-- défendable pour un mart ouvert en lecture à toute l'agence.
--
-- ÉCLATÉ EN QUATRE MARTS, PAS UN SEUL — voir `fct_site_traffic_daily.sql`
-- pour le raisonnement complet. Ne jamais recombiner la géographie avec
-- l'appareil, le navigateur ou la source d'acquisition.
--
-- ⚠️ Consentement analytics modélisé et ⚠️ historique borné au 22/08/2026 :
-- voir `fct_site_traffic_daily.sql`, mêmes réserves.

CREATE OR REPLACE VIEW `${PROJECT}.marts.fct_visit_geography_daily`
OPTIONS (
  description = "Sessions par jour, plateforme et pays. Grain volontairement limité au pays, jamais région ou ville."
)
AS
SELECT
  session_date                                    AS date,
  platform,
  geo_country,
  COUNT(*)                                         AS sessions,
  COUNT(DISTINCT user_pseudo_id)                   AS users,
  COUNTIF(session_number = 1)                      AS new_sessions,
  COUNTIF(session_number > 1)                      AS returning_sessions,
  COUNTIF(is_engaged)                              AS engaged_sessions,
  SUM(engagement_time_msec) / 1000.0               AS engagement_time_sec,
  COUNTIF(consent_analytics_granted)               AS sessions_consent_analytics_granted
FROM `${PROJECT}.staging.stg_ga4__sessions`
GROUP BY date, platform, geo_country;
