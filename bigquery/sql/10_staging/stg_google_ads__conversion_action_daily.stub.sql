-- BOUCHON — voir `stg_google_ads__campaign_daily.stub.sql` pour le raisonnement.
-- Déployé tant que le transfert Google Ads n'a pas produit ses tables.

CREATE OR REPLACE VIEW `${PROJECT}.staging.stg_google_ads__conversion_action_daily`
OPTIONS (
  description = "BOUCHON — aucune donnée. Le transfert Google Ads n'est pas encore configuré. Voir bigquery/README.md §3."
)
AS
SELECT
  'google_ads'          AS platform,
  CAST(NULL AS DATE)    AS date,
  CAST(NULL AS STRING)  AS account_id,
  CAST(NULL AS STRING)  AS campaign_id,
  CAST(NULL AS STRING)  AS conversion_action_name,
  CAST(NULL AS STRING)  AS conversion_action_category,
  CAST(NULL AS FLOAT64) AS conversions,
  CAST(NULL AS FLOAT64) AS conversions_value
FROM UNNEST(ARRAY<INT64>[]) AS jamais;
