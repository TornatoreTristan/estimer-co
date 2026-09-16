-- staging.stg_meta_ads__campaign_daily — dépense et performance Meta, au grain
-- (jour, campagne).
--
-- Le brut est au niveau annonce ; on agrège ici, mais la table brute reste
-- disponible pour descendre à l'ensemble ou à la créa sans rappeler l'API.
--
-- `actions` est un tableau de types d'action dont Meta modifie la liste sans
-- préavis. On n'en extrait que ce dont on a besoin, et on le fait par
-- correspondance explicite : un `LIKE '%lead%'` attraperait un jour un
-- `onsite_conversion.lead_grouped` qui doublerait le compte.
--
-- ⚠️ Les conversions Meta ne sont PAS comparables trait pour trait aux leads
-- GA4 : Meta attribue en 7 jours après clic / 1 jour après vue, et compte les
-- vues. `marts.v_platform_reconciliation` sert à mesurer l'écart, pas à le
-- corriger.

CREATE OR REPLACE VIEW `${PROJECT}.staging.stg_meta_ads__campaign_daily`
OPTIONS (
  description = "Meta Ads : impressions, clics sortants, dépense et conversions déclarées par jour et par campagne."
)
AS
SELECT
  'meta'                       AS platform,
  date,
  account_id,
  ANY_VALUE(account_name)      AS account_name,
  campaign_id,
  ANY_VALUE(campaign_name)     AS campaign_name,
  CAST(NULL AS STRING)         AS campaign_status,
  CAST(NULL AS STRING)         AS channel_type,
  CAST(NULL AS STRING)         AS channel_sub_type,
  ANY_VALUE(currency)          AS currency,
  SUM(impressions)             AS impressions,
  SUM(clicks)                  AS clicks,
  SUM(clicks)                  AS interactions,
  SUM(inline_link_clicks)      AS link_clicks,
  -- Cast explicite : `spend` est NUMERIC côté Meta et FLOAT64 côté Google Ads.
  -- Laisser BigQuery arbitrer le super-type dans l'UNION du mart marcherait
  -- aujourd'hui et casserait le jour où l'une des deux sources change de type.
  CAST(SUM(spend) AS FLOAT64)  AS cost,

  -- Conversions déclarées par Meta, restreintes aux actions que le plan de
  -- taggage §8 fait réellement remonter par le pixel.
  SUM((SELECT COALESCE(SUM(a.value), 0) FROM UNNEST(actions) AS a
       WHERE a.action_type IN ('lead', 'offsite_conversion.fb_pixel_lead')))
                               AS platform_conversions,
  SUM((SELECT COALESCE(SUM(av.value), 0) FROM UNNEST(action_values) AS av
       WHERE av.action_type IN ('lead', 'offsite_conversion.fb_pixel_lead')))
                               AS platform_conversions_value,
  -- Meta n'expose pas de conversions post-affichage séparément : la colonne
  -- existe pour que l'union avec Google Ads ait le même schéma, et vaut 0.
  CAST(0 AS FLOAT64)           AS view_through_conversions
FROM `${PROJECT}.raw_meta_ads.ad_insights_daily`
GROUP BY date, account_id, campaign_id;
