-- marts.fct_leads — un lead, une ligne. Le grain le plus fin de l'entrepôt.
--
-- C'est la table à interroger pour toute question qui commence par « combien de
-- leads… » : elle porte à la fois la qualification métier (§5.1 du plan de
-- taggage), les caractéristiques du bien, et le canal qui l'a amené. Les marts
-- agrégés en descendent ; ils ne doivent jamais la contredire.
--
-- Ce qu'elle ne contient pas, et ne contiendra jamais : nom, e-mail,
-- téléphone, adresse. Le plan §2.6 les interdit dans le dataLayer, donc GA4 ne
-- les a pas, donc BigQuery ne les a pas. Le jour où le lot T5 branchera un
-- export applicatif, c'est `raw_app` qui les portera, sous un contrôle d'accès
-- distinct — pas ici.
--
-- `lead_value` est la valeur *envoyée aux enchères* (§5.2), pas un chiffre
-- d'affaires. Tant que `VALEUR_BASE_LEAD` vaut 100 par défaut, elle n'a de sens
-- qu'en relatif : comparer deux campagnes, oui ; l'afficher comme un revenu à
-- la direction, non.

CREATE OR REPLACE VIEW `${PROJECT}.marts.fct_leads`
OPTIONS (
  description = "Un lead par ligne : qualification, bien, estimation, canal d'acquisition et campagne. Aucune donnée personnelle."
)
AS
SELECT
  l.lead_id,
  l.lead_id_missing,
  l.lead_category,
  l.lead_type,
  l.is_primary_conversion,
  l.event_date                       AS lead_date,
  l.event_timestamp                  AS lead_timestamp,

  -- Qualification métier (§5.1)
  l.lead_quality,
  l.is_owner,
  l.want_to_sell,
  l.lead_value,
  l.currency,
  l.contact_subject,

  -- Le bien
  l.property_type,
  l.surface_bucket,
  l.rooms,
  l.dpe,
  l.postal_code,
  l.departement_code,
  l.region,
  l.estimation_value,
  l.estimation_status,

  -- Acquisition
  l.platform,
  l.campaign_id,
  COALESCE(c.campaign_name, l.campaign_name) AS campaign_name,
  c.channel_type,
  c.naming_objective,
  c.naming_audience,
  c.naming_zone,
  c.naming_is_compliant,
  l.utm_source,
  l.utm_medium,
  l.utm_content,
  l.gclid,
  l.first_user_source,
  l.first_user_medium,

  l.first_touch_platform,
  -- Vrai quand le premier contact et la conversion viennent de canaux
  -- différents : c'est la population que l'attribution au dernier clic
  -- sous-estime, et la seule justification honnête d'un modèle multi-touch.
  -- La comparaison porte sur des canaux, jamais sur des sources brutes — voir
  -- `stg_ga4__events`, qui classe les deux avec les mêmes règles.
  l.first_touch_platform != l.platform AS is_multi_touch,

  -- Contexte
  l.session_key,
  l.user_pseudo_id,
  l.device_category,
  l.browser,
  l.geo_country,
  l.geo_region,
  l.geo_city
FROM `${PROJECT}.staging.stg_ga4__leads` AS l
LEFT JOIN `${PROJECT}.marts.dim_campaign` AS c
  ON c.platform = l.platform AND c.campaign_id = l.campaign_id;
