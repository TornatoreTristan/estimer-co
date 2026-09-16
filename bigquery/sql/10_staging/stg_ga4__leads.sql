-- staging.stg_ga4__leads — un lead par ligne, tel que GA4 l'a vu.
--
-- Couvre les deux conversions du plan de taggage §4.3 : `generate_lead`
-- (estimation) et `contact_lead` (message de contact ou candidature
-- partenaire). Le `lead_id` est l'UUID émis par le navigateur à la soumission
-- (§2.4) : c'est LA clé du dispositif, celle qui vaut aussi `transaction_id`
-- côté Google Ads et `eventID` côté Meta. Tout ce qui se rapproche entre
-- plateformes se rapproche par elle.
--
-- DÉDUPLICATION — le site garantit déjà un `generate_lead` unique par
-- `lead_id` (verrou `localStorage`, §9.3). On déduplique quand même, pour deux
-- raisons : le verrou ne survit pas à un vidage de stockage entre deux visites,
-- et une vue qui dépend d'une garantie côté navigateur est une vue qui finira
-- par mentir. On garde le premier événement — celui qui porte la session
-- d'acquisition réelle.
--
-- Les leads sans `lead_id` (visiteurs arrivés avant la mise en place de T1,
-- cf. §9.3) sont conservés avec une clé de repli : les exclure creuserait un
-- trou silencieux dans les totaux.

CREATE OR REPLACE VIEW `${PROJECT}.staging.stg_ga4__leads`
OPTIONS (
  description = "Un lead par ligne (generate_lead + contact_lead), dédupliqué sur lead_id, avec sa session d'acquisition."
)
AS
WITH conversions AS (
  SELECT
    COALESCE(
      lead_id,
      -- Repli : pas d'UUID, on en fabrique un déterministe pour ne pas perdre
      -- la ligne. Reconnaissable au préfixe, donc jamais confondu avec un vrai.
      CONCAT('nokey-', TO_HEX(MD5(CONCAT(user_pseudo_id, '|',
                                         CAST(UNIX_MICROS(event_timestamp) AS STRING)))))
    )                                       AS lead_id,
    lead_id IS NULL                         AS lead_id_missing,
    event_name,
    COALESCE(lead_type,
             CASE event_name WHEN 'generate_lead' THEN 'estimation'
                             WHEN 'contact_lead'  THEN 'contact' END) AS lead_type,
    event_date,
    event_timestamp,
    lead_quality,
    COALESCE(event_value, 0)                AS lead_value,
    COALESCE(currency, 'EUR')               AS currency,
    contact_subject,
    property_type, surface_bucket, rooms, dpe,
    postal_code, departement_code, region,
    is_owner, want_to_sell,
    estimation_value, estimation_status,
    user_pseudo_id, session_key,
    platform, campaign_id, campaign_name,
    ads_customer_id, ads_ad_group_id,
    utm_source, utm_medium, utm_content, utm_term, gclid,
    first_user_source, first_user_medium, first_user_campaign, first_touch_platform,
    device_category, browser, geo_country, geo_region, geo_city,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(lead_id, CONCAT(user_pseudo_id, CAST(event_timestamp AS STRING))),
                   event_name
      ORDER BY event_timestamp
    ) AS rang
  FROM `${PROJECT}.staging.stg_ga4__events`
  WHERE event_name IN ('generate_lead', 'contact_lead')
)

SELECT
  * EXCEPT (rang),
  -- Segmentation prête à l'emploi pour le pilotage : le plan §7.1 tient la
  -- candidature partenaire à l'écart de l'optimisation, les rapports doivent
  -- pouvoir en faire autant sans réécrire la règle à chaque requête.
  CASE
    WHEN event_name = 'generate_lead'                         THEN 'estimation'
    WHEN contact_subject = 'partenariat'                      THEN 'partenariat'
    ELSE 'contact'
  END AS lead_category,
  event_name = 'generate_lead' AS is_primary_conversion
FROM conversions
WHERE rang = 1;
