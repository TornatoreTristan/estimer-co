-- staging.stg_ga4__events — un événement GA4 par ligne, paramètres à plat.
--
-- C'est la seule vue du projet autorisée à toucher `${GA4_DATASET}`. Tout le
-- reste part d'ici. La contrepartie est qu'elle doit rester bête : aucune règle
-- métier, aucun filtre d'événement — seulement du renommage, de l'aplatissement
-- et la résolution du canal d'acquisition (§ ci-dessous).
--
-- Les tables `events_intraday_*` sont exclues. Elles doublonnent la table
-- quotidienne dès que celle-ci est livrée, et les mélanger fait compter deux
-- fois la journée en cours — un défaut qui ne se voit que le lendemain, quand
-- les chiffres de la veille ont changé tout seuls.
--
-- RÉSOLUTION DU CANAL (`platform`) — c'est ici que se joue la jointure avec les
-- régies. Trois cas seulement produisent une clé de campagne exploitable :
--   · Google Ads : `session_traffic_source_last_click.google_ads_campaign`,
--     alimenté par le balisage automatique (`gclid`). Le plan de taggage §7.2
--     interdit tout UTM manuel sur les annonces Google précisément pour que ce
--     bloc reste renseigné.
--   · Meta : `utm_id`, que la convention §10.1 impose à `{{campaign.id}}`.
--     Sans `utm_id`, on ne saurait rapprocher une session que du *nom* de la
--     campagne, qui change au gré des renommages — donc pas du tout.
--   · Le reste (organique, direct, référent) n'a pas de campagne, et c'est
--     normal : aucune dépense n'y est rattachée.

CREATE OR REPLACE VIEW `${PROJECT}.staging.stg_ga4__events`
OPTIONS (
  description = "Événements GA4 à plat, canal d'acquisition résolu. Source unique de tout le modèle GA4."
)
AS
WITH evenements AS (
  SELECT
    PARSE_DATE('%Y%m%d', event_date)                    AS event_date,
    TIMESTAMP_MICROS(event_timestamp)                   AS event_timestamp,
    event_name,
    stream_id,
    platform                                            AS ga4_platform,
    user_pseudo_id,
    user_id,
    event_params,
    privacy_info,
    device,
    geo,
    traffic_source,
    collected_traffic_source,
    session_traffic_source_last_click
  FROM `${PROJECT}.${GA4_DATASET}.events_*`
  WHERE _TABLE_SUFFIX NOT LIKE 'intraday%'
),

enrichis AS (
  SELECT
    e.* EXCEPT (event_params),

    -- Identité de session. GA4 ne fournit pas de clé de session prête à
    -- l'emploi : c'est toujours (pseudo utilisateur, ga_session_id).
    CAST(`${PROJECT}.staging.ga4_param_number`(e.event_params, 'ga_session_id') AS INT64)     AS ga_session_id,
    CAST(`${PROJECT}.staging.ga4_param_number`(e.event_params, 'ga_session_number') AS INT64) AS ga_session_number,

    -- Contexte de page
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'page_location')  AS page_location,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'page_title')     AS page_title,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'page_referrer')  AS page_referrer,
    CAST(`${PROJECT}.staging.ga4_param_number`(e.event_params, 'engagement_time_msec') AS INT64) AS engagement_time_msec,
    CAST(`${PROJECT}.staging.ga4_param_number`(e.event_params, 'session_engaged') AS INT64)      AS session_engaged,

    -- Conversions (plan de taggage §4.3)
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'lead_id')        AS lead_id,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'lead_type')      AS lead_type,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'lead_quality')   AS lead_quality,
    `${PROJECT}.staging.ga4_param_number`(e.event_params, 'value')          AS event_value,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'currency')       AS currency,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'contact_subject') AS contact_subject,

    -- Caractéristiques du bien
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'property_type')     AS property_type,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'surface_bucket')    AS surface_bucket,
    CAST(`${PROJECT}.staging.ga4_param_number`(e.event_params, 'rooms') AS INT64) AS rooms,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'dpe')               AS dpe,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'postal_code')       AS postal_code,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'departement_code')  AS departement_code,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'region')            AS region,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'city')              AS city,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'is_owner')          AS is_owner,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'want_to_sell')      AS want_to_sell,

    -- Résultat de l'estimation
    `${PROJECT}.staging.ga4_param_number`(e.event_params, 'estimation_value')   AS estimation_value,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'estimation_status')  AS estimation_status,
    `${PROJECT}.staging.ga4_param_number`(e.event_params, 'confidence_score')   AS confidence_score,
    CAST(`${PROJECT}.staging.ga4_param_number`(e.event_params, 'comparables_count') AS INT64) AS comparables_count,
    CAST(`${PROJECT}.staging.ga4_param_number`(e.event_params, 'latency_ms') AS INT64)        AS latency_ms,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'failure_type')       AS failure_type,
    CAST(`${PROJECT}.staging.ga4_param_number`(e.event_params, 'http_status') AS INT64)       AS http_status,

    -- Tunnel
    CAST(`${PROJECT}.staging.ga4_param_number`(e.event_params, 'step_number') AS INT64) AS step_number,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'step_key')        AS step_key,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'step_direction')  AS step_direction,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'error_fields')    AS error_fields,
    CAST(`${PROJECT}.staging.ga4_param_number`(e.event_params, 'error_count') AS INT64) AS error_count,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'address_source')  AS address_source,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'entry_point')     AS entry_point,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'has_address_prefill') AS has_address_prefill,

    -- Engagement
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'cta_id')           AS cta_id,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'cta_label')        AS cta_label,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'cta_destination')  AS cta_destination,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'partner_slug')     AS partner_slug,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'partner_name')     AS partner_name,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'partner_category') AS partner_category,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'page_type')        AS page_type,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'link_url')         AS link_url,
    CAST(`${PROJECT}.staging.ga4_param_number`(e.event_params, 'position') AS INT64) AS position,

    -- Consentement
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'consent_analytics') AS consent_analytics,
    `${PROJECT}.staging.ga4_param_string`(e.event_params, 'consent_ads')       AS consent_ads,

    e.event_params AS event_params_raw
  FROM evenements AS e
)

SELECT
  event_date,
  event_timestamp,
  event_name,
  stream_id,
  ga4_platform,
  user_pseudo_id,
  user_id,
  ga_session_id,
  ga_session_number,
  -- Clé de session stable, utilisée partout en aval.
  IF(ga_session_id IS NULL, NULL,
     CONCAT(user_pseudo_id, '.', CAST(ga_session_id AS STRING))) AS session_key,

  page_location,
  -- Chemin sans paramètres ni ancre : c'est la page, pas la visite.
  REGEXP_EXTRACT(page_location, r'^https?://[^/]+([^?#]*)')      AS page_path,
  page_title,
  page_referrer,
  engagement_time_msec,
  session_engaged,

  -- ------------------------------------------------------------------
  -- Canal d'acquisition (cf. l'en-tête)
  -- ------------------------------------------------------------------
  CASE
    WHEN session_traffic_source_last_click.google_ads_campaign.campaign_id IS NOT NULL
      THEN 'google_ads'
    WHEN collected_traffic_source.gclid IS NOT NULL
      THEN 'google_ads'
    WHEN LOWER(COALESCE(session_traffic_source_last_click.manual_campaign.source,
                        collected_traffic_source.manual_source, ''))
         IN ('meta', 'facebook', 'instagram', 'fb', 'ig', 'facebook.com', 'instagram.com')
      THEN 'meta'
    WHEN LOWER(COALESCE(session_traffic_source_last_click.manual_campaign.medium,
                        collected_traffic_source.manual_medium, '')) = 'organic'
      THEN 'organic_search'
    WHEN LOWER(COALESCE(session_traffic_source_last_click.manual_campaign.medium,
                        collected_traffic_source.manual_medium, '')) = 'referral'
      THEN 'referral'
    WHEN LOWER(COALESCE(session_traffic_source_last_click.manual_campaign.medium,
                        collected_traffic_source.manual_medium, '')) IN ('email', 'e-mail')
      THEN 'email'
    WHEN COALESCE(session_traffic_source_last_click.manual_campaign.source,
                  collected_traffic_source.manual_source) IS NULL
      THEN 'direct'
    ELSE 'other'
  END AS platform,

  -- Clé de campagne. NULL hors régie : une campagne inventée pour l'organique
  -- polluerait toutes les jointures de coût.
  CASE
    WHEN session_traffic_source_last_click.google_ads_campaign.campaign_id IS NOT NULL
      THEN session_traffic_source_last_click.google_ads_campaign.campaign_id
    WHEN LOWER(COALESCE(session_traffic_source_last_click.manual_campaign.source,
                        collected_traffic_source.manual_source, ''))
         IN ('meta', 'facebook', 'instagram', 'fb', 'ig', 'facebook.com', 'instagram.com')
      THEN COALESCE(session_traffic_source_last_click.manual_campaign.campaign_id,
                    collected_traffic_source.manual_campaign_id)
    ELSE NULL
  END AS campaign_id,

  COALESCE(session_traffic_source_last_click.google_ads_campaign.campaign_name,
           session_traffic_source_last_click.manual_campaign.campaign_name,
           collected_traffic_source.manual_campaign_name)          AS campaign_name,
  session_traffic_source_last_click.google_ads_campaign.customer_id AS ads_customer_id,
  session_traffic_source_last_click.google_ads_campaign.ad_group_id AS ads_ad_group_id,
  COALESCE(session_traffic_source_last_click.manual_campaign.source,
           collected_traffic_source.manual_source)                 AS utm_source,
  COALESCE(session_traffic_source_last_click.manual_campaign.medium,
           collected_traffic_source.manual_medium)                 AS utm_medium,
  COALESCE(session_traffic_source_last_click.manual_campaign.content,
           collected_traffic_source.manual_content)                AS utm_content,
  COALESCE(session_traffic_source_last_click.manual_campaign.term,
           collected_traffic_source.manual_term)                   AS utm_term,
  collected_traffic_source.gclid                                   AS gclid,
  -- Premier contact, conservé pour comparer première et dernière interaction.
  traffic_source.source                                            AS first_user_source,
  traffic_source.medium                                            AS first_user_medium,
  traffic_source.name                                              AS first_user_campaign,

  -- Le premier contact classé selon les MÊMES règles que le dernier clic
  -- ci-dessus. Sans cette symétrie, toute comparaison entre les deux serait
  -- faussée : Google Ads ne pose aucun `utm_source` (balisage automatique,
  -- plan §7.2), donc comparer `first_user_source` à `utm_source` déclarerait
  -- « multi-touch » l'intégralité des leads Google Ads.
  CASE
    WHEN LOWER(traffic_source.medium) = 'cpc'
     AND LOWER(traffic_source.source) = 'google'            THEN 'google_ads'
    WHEN LOWER(traffic_source.source)
         IN ('meta', 'facebook', 'instagram', 'fb', 'ig',
             'facebook.com', 'instagram.com')               THEN 'meta'
    WHEN LOWER(traffic_source.medium) = 'organic'           THEN 'organic_search'
    WHEN LOWER(traffic_source.medium) = 'referral'          THEN 'referral'
    WHEN LOWER(traffic_source.medium) IN ('email', 'e-mail') THEN 'email'
    WHEN traffic_source.source IS NULL
      OR LOWER(traffic_source.source) = '(direct)'          THEN 'direct'
    ELSE 'other'
  END                                                              AS first_touch_platform,

  -- ------------------------------------------------------------------
  -- Paramètres métier
  -- ------------------------------------------------------------------
  lead_id, lead_type, lead_quality, event_value, currency, contact_subject,
  property_type, surface_bucket, rooms, dpe, postal_code, departement_code,
  region, city, is_owner, want_to_sell,
  estimation_value, estimation_status, confidence_score, comparables_count,
  latency_ms, failure_type, http_status,
  step_number, step_key, step_direction, error_fields, error_count,
  address_source, entry_point, has_address_prefill,
  cta_id, cta_label, cta_destination,
  partner_slug, partner_name, partner_category, page_type, link_url, position,
  consent_analytics, consent_ads,

  privacy_info.analytics_storage AS privacy_analytics_storage,
  privacy_info.ads_storage       AS privacy_ads_storage,
  device.category                AS device_category,
  device.operating_system        AS device_os,
  device.web_info.browser        AS browser,
  geo.country                    AS geo_country,
  geo.region                     AS geo_region,
  geo.city                       AS geo_city,

  event_params_raw
FROM enrichis;
