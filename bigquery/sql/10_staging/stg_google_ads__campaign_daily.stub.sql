-- BOUCHON — déployé à la place de `stg_google_ads__campaign_daily.sql` tant que
-- le BigQuery Data Transfer Service Google Ads n'a pas produit ses tables.
--
-- Pourquoi un bouchon plutôt qu'un modèle absent : sans lui, tout l'étage
-- `marts` refuserait de se créer, et on ne pourrait rien voir de GA4 ni de Meta
-- avant que le transfert Ads soit branché. Le bouchon rend l'entrepôt
-- utilisable dès le premier jour, avec une colonne « dépense Google » à zéro
-- au lieu d'un écran vide.
--
-- Le risque, évidemment, c'est de le prendre pour la réalité. Trois garde-fous :
-- `scripts/deploy-bigquery.mjs` l'annonce en clair à chaque déploiement,
-- `marts.v_data_freshness` signale la source comme absente, et la colonne
-- `is_stub` ci-dessous suit jusque dans les rapports.

CREATE OR REPLACE VIEW `${PROJECT}.staging.stg_google_ads__campaign_daily`
OPTIONS (
  description = "BOUCHON — aucune donnée. Le transfert Google Ads n'est pas encore configuré. Voir bigquery/README.md §3."
)
AS
SELECT
  'google_ads'              AS platform,
  CAST(NULL AS DATE)        AS date,
  CAST(NULL AS STRING)      AS account_id,
  CAST(NULL AS STRING)      AS account_name,
  CAST(NULL AS STRING)      AS campaign_id,
  CAST(NULL AS STRING)      AS campaign_name,
  CAST(NULL AS STRING)      AS campaign_status,
  CAST(NULL AS STRING)      AS channel_type,
  CAST(NULL AS STRING)      AS channel_sub_type,
  CAST(NULL AS STRING)      AS currency,
  CAST(NULL AS INT64)       AS impressions,
  CAST(NULL AS INT64)       AS clicks,
  CAST(NULL AS INT64)       AS interactions,
  CAST(NULL AS INT64)       AS link_clicks,
  CAST(NULL AS FLOAT64)     AS cost,
  CAST(NULL AS FLOAT64)     AS platform_conversions,
  CAST(NULL AS FLOAT64)     AS platform_conversions_value,
  CAST(NULL AS FLOAT64)     AS view_through_conversions
-- Zéro ligne, mais un schéma complet. `WHERE FALSE` seul ne suffit pas :
-- BigQuery refuse une clause WHERE sans FROM. Un tableau vide fait l'affaire et
-- ne coûte rien à scanner.
FROM UNNEST(ARRAY<INT64>[]) AS jamais;
