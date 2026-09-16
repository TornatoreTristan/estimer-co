-- marts.fct_marketing_performance_daily — LA table de pilotage.
--
-- Grain : (jour, plateforme, campagne). Elle réunit ce que trois systèmes
-- disent d'une même journée :
--   · ce que la régie a facturé          → `stg_ads__spend_daily`
--   · ce que le site a observé            → `stg_ga4__sessions`
--   · ce que le site a converti           → `stg_ga4__leads`
-- et elle laisse volontairement les trois cohabiter sans les réconcilier de
-- force. C'est le sens de « source de vérité » ici : un seul endroit où lire
-- les trois chiffres, pas un chiffre unique obtenu en écrasant les deux autres.
--
-- JOINTURE — les trois sources sont réunies sur (date, platform, campaign_id).
-- `campaign_id` étant NULL hors régie, on passe par `campaign_key` : en SQL,
-- NULL ne s'égale pas à NULL, et une jointure directe ferait disparaître
-- l'intégralité du trafic organique et direct. C'est le genre de perte qui ne
-- se voit pas, parce qu'il ne reste rien pour la signaler.
--
-- UNION DES CLÉS plutôt que FULL OUTER JOIN en chaîne : trois FULL OUTER JOIN
-- successifs obligent à un COALESCE des clés à chaque étage, et il suffit d'en
-- oublier un pour dupliquer des lignes. L'univers des clés d'abord, les
-- LEFT JOIN ensuite — plus verbeux, mais faux nulle part.
--
-- ⚠️ Les jours récents bougent : Google Ads rejoue 30 jours, Meta 28. Un
-- rapport figé sur J-1 n'est pas comparable à ce qu'on lira dans une semaine.

CREATE OR REPLACE VIEW `${PROJECT}.marts.fct_marketing_performance_daily`
OPTIONS (
  description = "Source de vérité du pilotage : dépense régie, sessions et leads GA4 réunis par jour, plateforme et campagne."
)
AS
WITH depense AS (
  SELECT
    date,
    platform,
    COALESCE(campaign_id, '(none)') AS campaign_key,
    ANY_VALUE(campaign_id)          AS campaign_id,
    ANY_VALUE(campaign_name)        AS campaign_name,
    ANY_VALUE(account_name)         AS account_name,
    ANY_VALUE(currency)             AS currency,
    SUM(impressions)                AS impressions,
    SUM(clicks)                     AS clicks,
    SUM(link_clicks)                AS link_clicks,
    SUM(cost)                       AS cost,
    SUM(platform_conversions)       AS platform_conversions,
    SUM(platform_conversions_value) AS platform_conversions_value
  FROM `${PROJECT}.staging.stg_ads__spend_daily`
  GROUP BY date, platform, campaign_key
),

sessions AS (
  SELECT
    session_date                    AS date,
    platform,
    COALESCE(campaign_id, '(none)') AS campaign_key,
    COUNT(*)                        AS sessions,
    COUNT(DISTINCT user_pseudo_id)  AS users,
    COUNTIF(is_engaged)             AS engaged_sessions,
    SUM(engagement_time_msec) / 1000.0 AS engagement_time_sec,

    -- Le tunnel, au grain campagne. `max_step_reached` est la plus haute étape
    -- atteinte en marche avant : un retour arrière ne dégrade pas le compteur,
    -- sans quoi un visiteur hésitant ferait baisser le taux de passage.
    COUNTIF(estimation_start_count > 0)   AS sessions_estimation_start,
    COUNTIF(max_step_reached >= 3)        AS sessions_step_3_reached,
    COUNTIF(max_step_reached >= 5)        AS sessions_step_5_reached,
    COUNTIF(submit_count > 0)             AS sessions_submitted,
    COUNTIF(failed_count > 0)             AS sessions_failed,
    COUNTIF(step_error_count > 0)         AS sessions_with_step_error,
    COUNTIF(report_view_count > 0)        AS sessions_report_view,
    COUNTIF(pdf_download_count > 0)       AS sessions_pdf_download,
    COUNTIF(partner_click_out_count > 0)  AS sessions_partner_click_out,

    -- Consentement : sans cette colonne, une chute de sessions provoquée par un
    -- taux de refus en hausse se lit comme une chute d'audience.
    COUNTIF(consent_ads_granted)          AS sessions_consent_ads_granted
  FROM `${PROJECT}.staging.stg_ga4__sessions`
  GROUP BY date, platform, campaign_key
),

leads AS (
  SELECT
    event_date                      AS date,
    platform,
    COALESCE(campaign_id, '(none)') AS campaign_key,
    COUNT(*)                                             AS leads_total,
    COUNTIF(lead_category = 'estimation')                AS leads_estimation,
    COUNTIF(lead_category = 'contact')                   AS leads_contact,
    COUNTIF(lead_category = 'partenariat')               AS leads_partenariat,
    COUNTIF(lead_quality = 'hot')                        AS leads_hot,
    COUNTIF(lead_quality = 'warm')                       AS leads_warm,
    COUNTIF(lead_quality = 'cold')                       AS leads_cold,
    SUM(lead_value)                                      AS lead_value,
    SUM(IF(lead_category = 'estimation', lead_value, 0)) AS lead_value_estimation,
    AVG(IF(lead_category = 'estimation', estimation_value, NULL)) AS avg_estimation_value
  FROM `${PROJECT}.staging.stg_ga4__leads`
  GROUP BY date, platform, campaign_key
),

cles AS (
  SELECT date, platform, campaign_key FROM depense
  UNION DISTINCT
  SELECT date, platform, campaign_key FROM sessions
  UNION DISTINCT
  SELECT date, platform, campaign_key FROM leads
)

SELECT
  k.date,
  k.platform,
  NULLIF(k.campaign_key, '(none)')                   AS campaign_id,
  COALESCE(d.campaign_name, c.campaign_name)         AS campaign_name,
  d.account_name,
  c.channel_type,
  c.naming_objective,
  c.naming_audience,
  c.naming_zone,
  c.naming_is_compliant,
  COALESCE(d.currency, 'EUR')                        AS currency,

  -- Ce que la régie facture
  COALESCE(d.impressions, 0)                         AS impressions,
  COALESCE(d.clicks, 0)                              AS clicks,
  COALESCE(d.link_clicks, 0)                         AS link_clicks,
  COALESCE(d.cost, 0)                                AS cost,
  COALESCE(d.platform_conversions, 0)                AS platform_conversions,
  COALESCE(d.platform_conversions_value, 0)          AS platform_conversions_value,

  -- Ce que le site observe
  COALESCE(s.sessions, 0)                            AS sessions,
  COALESCE(s.users, 0)                               AS users,
  COALESCE(s.engaged_sessions, 0)                    AS engaged_sessions,
  COALESCE(s.engagement_time_sec, 0)                 AS engagement_time_sec,
  COALESCE(s.sessions_estimation_start, 0)           AS sessions_estimation_start,
  COALESCE(s.sessions_step_3_reached, 0)             AS sessions_step_3_reached,
  COALESCE(s.sessions_step_5_reached, 0)             AS sessions_step_5_reached,
  COALESCE(s.sessions_submitted, 0)                  AS sessions_submitted,
  COALESCE(s.sessions_failed, 0)                     AS sessions_failed,
  COALESCE(s.sessions_with_step_error, 0)            AS sessions_with_step_error,
  COALESCE(s.sessions_report_view, 0)                AS sessions_report_view,
  COALESCE(s.sessions_pdf_download, 0)               AS sessions_pdf_download,
  COALESCE(s.sessions_partner_click_out, 0)          AS sessions_partner_click_out,
  COALESCE(s.sessions_consent_ads_granted, 0)        AS sessions_consent_ads_granted,

  -- Ce que le site convertit
  COALESCE(l.leads_total, 0)                         AS leads_total,
  COALESCE(l.leads_estimation, 0)                    AS leads_estimation,
  COALESCE(l.leads_contact, 0)                       AS leads_contact,
  COALESCE(l.leads_partenariat, 0)                   AS leads_partenariat,
  COALESCE(l.leads_hot, 0)                           AS leads_hot,
  COALESCE(l.leads_warm, 0)                          AS leads_warm,
  COALESCE(l.leads_cold, 0)                          AS leads_cold,
  COALESCE(l.lead_value, 0)                          AS lead_value,
  COALESCE(l.lead_value_estimation, 0)               AS lead_value_estimation,
  l.avg_estimation_value,

  -- Indicateurs dérivés. SAFE_DIVIDE partout : une division par zéro un jour
  -- sans dépense ferait tomber la requête entière, pas seulement sa ligne.
  SAFE_DIVIDE(d.cost, d.clicks)                      AS cpc,
  SAFE_DIVIDE(d.cost * 1000, d.impressions)          AS cpm,
  SAFE_DIVIDE(d.clicks, d.impressions)               AS ctr,
  SAFE_DIVIDE(d.cost, s.sessions)                    AS cost_per_session,
  SAFE_DIVIDE(d.cost, l.leads_estimation)            AS cost_per_lead,
  SAFE_DIVIDE(d.cost, l.leads_hot)                   AS cost_per_hot_lead,
  SAFE_DIVIDE(l.leads_estimation, s.sessions)        AS lead_rate,
  SAFE_DIVIDE(s.sessions_submitted, s.sessions_estimation_start) AS funnel_completion_rate,
  SAFE_DIVIDE(l.lead_value, d.cost)                  AS value_per_cost
  -- Pas de rapport « régie / GA4 » ici, délibérément. `platform_conversions`
  -- additionne toutes les actions principales du compte Ads (estimation ET
  -- contact) : le comparer au seul `generate_lead` donnerait un écart
  -- structurel qu'on finirait par prendre pour un défaut de mesure. La
  -- comparaison à périmètre égal vit dans `marts.v_platform_reconciliation`,
  -- et elle est le seul endroit où la lire.
FROM cles AS k
LEFT JOIN depense  AS d USING (date, platform, campaign_key)
LEFT JOIN sessions AS s USING (date, platform, campaign_key)
LEFT JOIN leads    AS l USING (date, platform, campaign_key)
LEFT JOIN `${PROJECT}.marts.dim_campaign` AS c
  ON c.platform = k.platform AND c.campaign_id = NULLIF(k.campaign_key, '(none)');
