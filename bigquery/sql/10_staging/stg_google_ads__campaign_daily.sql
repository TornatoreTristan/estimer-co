-- staging.stg_google_ads__campaign_daily — dépense et performance Google Ads,
-- au grain (jour, campagne).
--
-- Source : le BigQuery Data Transfer Service, qui écrit des tables
-- `p_ads_<Objet>_<CID>`. Deux natures de tables s'y mélangent, et les confondre
-- est l'erreur classique :
--   · les tables de **statistiques** (`…BasicStats…`) portent `segments_date`,
--     le jour de diffusion — c'est un historique ;
--   · les tables d'**attributs** (`…Campaign…`, `…Customer…`) n'ont AUCUNE
--     colonne de date : ce sont des photos quotidiennes du paramétrage, datées
--     par la pseudo-colonne de partition `_PARTITIONDATE`. On n'en garde que la
--     plus récente, sans quoi une campagne renommée apparaîtrait deux fois.
--
-- ⚠️ Les noms de colonnes de ce transfert ne sont pas ceux de la documentation
-- Google. Vérifiés sur le compte 383-871-6042 le 22/08/2026, les écarts sont :
--   · pas de `_DATA_DATE` — les tables sont partitionnées par temps
--     d'ingestion, donc `_PARTITIONDATE` ;
--   · `campaign_start_date_time` / `campaign_end_date_time`, et non `…_date` ;
--   · **`metrics_all_conversions` n'existe pas** sur ces tables. C'est pour
--     cela que la vue n'expose que `metrics_conversions` — soit les seules
--     actions marquées « principales » dans le compte. Le détail par action de
--     conversion vit dans `stg_google_ads__conversion_action_daily`.
--
-- Le transfert rejoue les 30 derniers jours à chaque exécution : les chiffres
-- des jours récents bougent encore, c'est normal, Google ré-attribue.

CREATE OR REPLACE VIEW `${PROJECT}.staging.stg_google_ads__campaign_daily`
OPTIONS (
  description = "Google Ads : impressions, clics, coût et conversions principales par jour et par campagne."
)
AS
WITH campagnes AS (
  -- Pas de `customer_id` ici : il vient de la table de statistiques. Le porter
  -- des deux côtés rendrait `account_id` ambigu à la jointure suivante.
  SELECT
    CAST(campaign_id AS STRING)           AS campaign_id,
    campaign_name,
    campaign_status,
    campaign_advertising_channel_type     AS channel_type,
    campaign_advertising_channel_sub_type AS channel_sub_type,
    -- Les bornes arrivent en DATETIME (et non en texte, contrairement à ce que
    -- laisse croire le suffixe `_date_time`). On ne garde que la date : une
    -- heure de démarrage n'a aucun usage ici, et la conserver obligerait tous
    -- les rapports à gérer un fuseau.
    DATE(campaign_start_date_time) AS campaign_start_date,
    DATE(campaign_end_date_time)   AS campaign_end_date
  FROM `${PROJECT}.raw_google_ads.p_ads_Campaign_${ADS_CUSTOMER_ID}`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY campaign_id ORDER BY _PARTITIONDATE DESC) = 1
),

comptes AS (
  SELECT
    CAST(customer_id AS STRING) AS account_id,
    customer_descriptive_name   AS account_name,
    customer_currency_code      AS currency
  FROM `${PROJECT}.raw_google_ads.p_ads_Customer_${ADS_CUSTOMER_ID}`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY _PARTITIONDATE DESC) = 1
),

stats AS (
  -- Une ligne par (campagne, jour, réseau, appareil, emplacement) : on agrège.
  SELECT
    segments_date                   AS date,
    CAST(customer_id AS STRING)     AS account_id,
    CAST(campaign_id AS STRING)     AS campaign_id,
    SUM(metrics_impressions)        AS impressions,
    SUM(metrics_clicks)             AS clicks,
    SUM(metrics_interactions)       AS interactions,
    -- Les micros sont l'unité native d'Ads. On divise ici, une fois, pour que
    -- personne n'ait à s'en souvenir en aval.
    SUM(metrics_cost_micros) / 1e6  AS cost,
    SUM(metrics_conversions)        AS platform_conversions,
    SUM(metrics_conversions_value)  AS platform_conversions_value,
    SUM(metrics_view_through_conversions) AS view_through_conversions
  FROM `${PROJECT}.raw_google_ads.p_ads_CampaignBasicStats_${ADS_CUSTOMER_ID}`
  GROUP BY date, account_id, campaign_id
)

SELECT
  'google_ads'                    AS platform,
  s.date,
  s.account_id,
  co.account_name,
  s.campaign_id,
  ca.campaign_name,
  ca.campaign_status,
  ca.channel_type,
  ca.channel_sub_type,
  COALESCE(co.currency, 'EUR')    AS currency,
  s.impressions,
  s.clicks,
  s.interactions,
  -- Le comparable des sessions GA4 côté Meta s'appelle `inline_link_clicks` ;
  -- côté Google c'est `clicks`. La colonne porte le même nom des deux côtés
  -- pour que l'union du mart n'ait aucun arbitrage à faire.
  s.clicks                        AS link_clicks,
  s.cost,
  s.platform_conversions,
  s.platform_conversions_value,
  s.view_through_conversions
FROM stats AS s
LEFT JOIN campagnes AS ca USING (campaign_id)
LEFT JOIN comptes   AS co USING (account_id);
