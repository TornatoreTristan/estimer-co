-- staging.stg_ga4__sessions — une session par ligne.
--
-- Le grain de session est ce qui permet de comparer un coût publicitaire à
-- autre chose qu'un nombre d'événements. Une session porte un canal, un jour et
-- une campagne ; un événement isolé, non — deux `cta_click` d'un même visiteur
-- ne sont pas deux visites.
--
-- L'attribution retenue est le **dernier clic non direct de la session**, tel
-- que GA4 le calcule lui-même dans `session_traffic_source_last_click`. On ne
-- recalcule rien : diverger du modèle de la propriété rendrait toute
-- comparaison avec l'interface GA4 impossible à expliquer.

CREATE OR REPLACE VIEW `${PROJECT}.staging.stg_ga4__sessions`
OPTIONS (
  description = "Sessions GA4 avec canal, campagne, page d'entrée, engagement et conversions du parcours."
)
AS
WITH evenements AS (
  SELECT *
  FROM `${PROJECT}.staging.stg_ga4__events`
  WHERE session_key IS NOT NULL
),

premier_evenement AS (
  SELECT
    session_key,
    ARRAY_AGG(
      STRUCT(page_path, platform, campaign_id, campaign_name,
             utm_source, utm_medium, utm_content, gclid,
             device_category, browser, geo_country, geo_region, geo_city,
             ads_customer_id)
      ORDER BY event_timestamp
      LIMIT 1
    )[OFFSET(0)] AS e
  FROM evenements
  GROUP BY session_key
),

agrege AS (
  SELECT
    session_key,
    ANY_VALUE(user_pseudo_id)             AS user_pseudo_id,
    MIN(event_date)                       AS session_date,
    MIN(event_timestamp)                  AS session_start,
    MAX(event_timestamp)                  AS session_end,
    MAX(ga_session_number)                AS session_number,
    COUNT(*)                              AS event_count,
    COUNTIF(event_name = 'page_view')     AS page_view_count,
    -- GA4 marque `session_engaged=1` sur les événements d'une session engagée
    -- (>10 s, ≥2 pages, ou une conversion). On reprend sa définition.
    MAX(COALESCE(session_engaged, 0)) = 1 AS is_engaged,
    SUM(COALESCE(engagement_time_msec, 0)) AS engagement_time_msec,

    -- Étapes du tunnel franchies (plan §4.2)
    COUNTIF(event_name = 'estimation_start')                                     AS estimation_start_count,
    MAX(IF(event_name = 'estimation_step_view' AND step_direction = 'forward',
           step_number, NULL))                                                   AS max_step_reached,
    COUNTIF(event_name = 'estimation_step_error')                                AS step_error_count,
    COUNTIF(event_name = 'estimation_submit')                                    AS submit_count,
    COUNTIF(event_name = 'estimation_failed')                                    AS failed_count,
    COUNTIF(event_name = 'report_view')                                          AS report_view_count,
    COUNTIF(event_name = 'report_pdf_download')                                  AS pdf_download_count,
    COUNTIF(event_name = 'generate_lead')                                        AS generate_lead_count,
    COUNTIF(event_name = 'contact_lead')                                         AS contact_lead_count,
    COUNTIF(event_name = 'partner_click_out')                                    AS partner_click_out_count,
    COUNTIF(event_name = 'cta_click')                                            AS cta_click_count,
    SUM(IF(event_name IN ('generate_lead', 'contact_lead'), COALESCE(event_value, 0), 0)) AS lead_value,

    -- Consentement observé sur la session. `denied` partout signifie que la
    -- session est intégralement modélisée par Google : la lire comme une
    -- session normale fausserait tous les taux.
    MAX(IF(consent_ads = 'granted', 1, 0)) = 1       AS consent_ads_granted,
    MAX(IF(consent_analytics = 'granted', 1, 0)) = 1 AS consent_analytics_granted
  FROM evenements
  GROUP BY session_key
)

SELECT
  a.session_key,
  a.user_pseudo_id,
  a.session_date,
  a.session_start,
  a.session_end,
  a.session_number,
  p.e.page_path        AS landing_page_path,
  p.e.platform         AS platform,
  p.e.campaign_id      AS campaign_id,
  p.e.campaign_name    AS campaign_name,
  p.e.ads_customer_id  AS ads_customer_id,
  p.e.utm_source       AS utm_source,
  p.e.utm_medium       AS utm_medium,
  p.e.utm_content      AS utm_content,
  p.e.gclid            AS gclid,
  p.e.device_category  AS device_category,
  p.e.browser          AS browser,
  p.e.geo_country      AS geo_country,
  p.e.geo_region       AS geo_region,
  p.e.geo_city         AS geo_city,
  a.* EXCEPT (session_key, user_pseudo_id, session_date, session_start, session_end, session_number)
FROM agrege AS a
JOIN premier_evenement AS p USING (session_key);
