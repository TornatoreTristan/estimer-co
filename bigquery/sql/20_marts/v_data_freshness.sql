-- marts.v_data_freshness — l'entrepôt dit lui-même ce qu'il ne sait pas.
--
-- À ouvrir avant toute analyse, et à mettre en tête de tout tableau de bord.
-- Un mart qui affiche zéro parce qu'une source n'a pas été livrée est
-- indiscernable d'un mart qui affiche zéro parce qu'il ne s'est rien passé —
-- sauf si quelque chose, quelque part, tient le compte des retards.
--
-- Les seuils sont volontairement larges : l'export GA4 quotidien arrive au
-- cours de la journée suivante, le transfert Ads aussi, et Meta est rechargé
-- par notre propre planificateur. Deux jours de retard, c'est une panne ; un
-- jour, c'est le rythme normal.

CREATE OR REPLACE VIEW `${PROJECT}.marts.v_data_freshness`
OPTIONS (
  description = "Fraîcheur de chaque source. À lire en premier : distingue « rien ne s'est passé » de « rien n'est arrivé »."
)
AS
WITH sources AS (
  SELECT 'ga4_events'  AS source,
         'Export BigQuery GA4 (quotidien)' AS libelle,
         MAX(event_date) AS last_date,
         COUNT(*)        AS rows_last_7d
  FROM `${PROJECT}.staging.stg_ga4__events`
  WHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)

  UNION ALL
  SELECT 'google_ads', 'Transfert BigQuery Data Transfer Service',
         MAX(date), COUNT(*)
  FROM `${PROJECT}.staging.stg_google_ads__campaign_daily`
  WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)

  UNION ALL
  SELECT 'meta_ads', 'Ingestion scripts/ingest-meta-ads.mjs',
         MAX(date), COUNT(*)
  FROM `${PROJECT}.staging.stg_meta_ads__campaign_daily`
  WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
),

derniere_ingestion AS (
  SELECT
    source,
    MAX(finished_at)                                          AS last_run_at,
    ARRAY_AGG(status ORDER BY started_at DESC LIMIT 1)[OFFSET(0)] AS last_run_status,
    ARRAY_AGG(error_message ORDER BY started_at DESC LIMIT 1)[OFFSET(0)] AS last_run_error
  FROM `${PROJECT}.ops.ingestion_runs`
  GROUP BY source
)

SELECT
  s.source,
  s.libelle,
  s.last_date,
  DATE_DIFF(CURRENT_DATE(), s.last_date, DAY) AS days_late,
  s.rows_last_7d,
  i.last_run_at,
  i.last_run_status,
  i.last_run_error,
  CASE
    WHEN s.last_date IS NULL                                     THEN 'source_absente'
    WHEN DATE_DIFF(CURRENT_DATE(), s.last_date, DAY) <= 1        THEN 'a_jour'
    WHEN DATE_DIFF(CURRENT_DATE(), s.last_date, DAY) <= 2        THEN 'retard_tolere'
    ELSE 'en_panne'
  END AS statut
FROM sources AS s
LEFT JOIN derniere_ingestion AS i USING (source);
