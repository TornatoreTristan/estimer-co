-- marts.fct_leads — un lead, une ligne. Le grain le plus fin de l'entrepôt.
--
-- C'est la table à interroger pour toute question qui commence par « combien de
-- leads… » : elle porte à la fois la qualification métier (§5.1 du plan de
-- taggage), les caractéristiques du bien, et le canal qui l'a amené. Les marts
-- agrégés en descendent ; ils ne doivent jamais la contredire.
--
-- Ce qu'elle ne contient pas, et ne contiendra jamais : nom, e-mail,
-- téléphone, adresse. Le plan §2.6 les interdit dans le dataLayer, donc GA4 ne
-- les a pas, donc BigQuery ne les a pas. L'export applicatif annoncé pour le
-- lot T5 est branché depuis le 26/08/2026 et alimente `raw_app.crm_leads` —
-- il ne change RIEN à cette garantie : l'API qui l'alimente refuse toute
-- donnée personnelle, et `external_id` est une clé opaque dont seul le CRM du
-- client sait retrouver la personne.
--
-- `lead_value` est la valeur *envoyée aux enchères* (§5.2), pas un chiffre
-- d'affaires. Tant que `VALEUR_BASE_LEAD` vaut 100 par défaut, elle n'a de sens
-- qu'en relatif : comparer deux campagnes, oui ; l'afficher comme un revenu à
-- la direction, non. `crm_deal_value`, elle, EST un revenu — c'est toute la
-- raison d'avoir branché le CRM. Ne pas confondre les deux colonnes.
--
-- RAPPROCHEMENT CRM — quatre passes, de la plus fiable à la moins :
--   1. `match_lead_id` = `lead_id`. L'UUID émis par le navigateur à la
--      soumission (§2.4), celui qui vaut déjà `transaction_id` côté Google Ads
--      et `eventID` côté Meta. Exact. Quand le CRM le porte, tout le reste est
--      superflu — et c'est le seul cas où on peut parler de taux de
--      transformation sans se faire mal.
--   2. `gclid`. Exact, mais Google Ads seulement.
--   3. `session_key`, puis `user_pseudo_id`. Exacts côté GA4.
--   4. Triplet UTM dans une fenêtre de 72 h. **Probabiliste**, et signalé comme
--      tel par `crm_match_confidence`. Toujours disponible, jamais fiable.
--
-- `crm_match_method` et `crm_match_confidence` ne sont pas cosmétiques : un
-- taux calculé sur des rapprochements `utm_window` ne vaut pas le même calculé
-- sur des `lead_id`, et l'écran doit pouvoir le dire.

CREATE OR REPLACE VIEW `${PROJECT}.marts.fct_leads`
OPTIONS (
  description = "Un lead par ligne : qualification, bien, estimation, canal d'acquisition, campagne et état CRM. Aucune donnée personnelle."
)
AS
WITH crm AS (
  SELECT * FROM `${PROJECT}.staging.stg_crm__leads`
),

/*
 * Une passe par clé plutôt qu'une jointure à `OR` : BigQuery résout un `OR`
 * de jointure par un produit cartésien filtré, ce qui devient très cher dès
 * que le CRM grossit. Quatre équi-jointures unies coûtent quatre balayages
 * indexables, et se lisent mieux.
 */
candidats AS (
  SELECT
    l.lead_id AS ga4_lead_id, c.external_id,
    1 AS priorite, 'lead_id' AS methode, 'exact' AS confiance,
    ABS(TIMESTAMP_DIFF(c.occurred_at, l.event_timestamp, SECOND)) AS ecart_s
  FROM `${PROJECT}.staging.stg_ga4__leads` AS l
  JOIN crm AS c ON c.match_lead_id = l.lead_id
  WHERE NOT l.lead_id_missing

  UNION ALL
  SELECT
    l.lead_id, c.external_id, 2, 'gclid', 'exact',
    ABS(TIMESTAMP_DIFF(c.occurred_at, l.event_timestamp, SECOND))
  FROM `${PROJECT}.staging.stg_ga4__leads` AS l
  JOIN crm AS c ON c.match_gclid = l.gclid
  WHERE l.gclid IS NOT NULL

  UNION ALL
  SELECT
    l.lead_id, c.external_id, 3, 'session', 'exact',
    ABS(TIMESTAMP_DIFF(c.occurred_at, l.event_timestamp, SECOND))
  FROM `${PROJECT}.staging.stg_ga4__leads` AS l
  JOIN crm AS c ON c.match_session_key = l.session_key
  WHERE l.session_key IS NOT NULL

  UNION ALL
  SELECT
    l.lead_id, c.external_id, 4, 'session', 'exact',
    ABS(TIMESTAMP_DIFF(c.occurred_at, l.event_timestamp, SECOND))
  FROM `${PROJECT}.staging.stg_ga4__leads` AS l
  JOIN crm AS c ON c.match_user_pseudo_id = l.user_pseudo_id
  WHERE l.user_pseudo_id IS NOT NULL

  UNION ALL
  -- 72 h : au-delà, un même triplet UTM couvre trop de leads pour que le
  -- rapprochement veuille encore dire quelque chose.
  SELECT
    l.lead_id, c.external_id, 5, 'utm_window', 'probable',
    ABS(TIMESTAMP_DIFF(c.occurred_at, l.event_timestamp, SECOND))
  FROM `${PROJECT}.staging.stg_ga4__leads` AS l
  JOIN crm AS c
    ON  c.match_utm_source = LOWER(l.utm_source)
    AND c.match_utm_medium = LOWER(l.utm_medium)
  WHERE l.utm_source IS NOT NULL
    AND l.utm_medium IS NOT NULL
    AND ABS(TIMESTAMP_DIFF(c.occurred_at, l.event_timestamp, HOUR)) <= 72
),

/*
 * Appariement glouton, un lead GA4 pour un lead CRM au plus.
 *
 * Un `gclid` ou un triplet UTM peut couvrir des dizaines de leads : sans cette
 * double contrainte, une seule affaire signée se recopierait sur toutes les
 * lignes qui partagent sa clé, et `crm_deal_value` deviendrait un multiplicateur
 * de chiffre d'affaires imaginaire. On garde donc les paires qui sont le
 * meilleur choix **des deux côtés**.
 *
 * C'est une approximation, pas un couplage optimal : elle laisse tomber une
 * paire correcte quand deux leads se disputent la même contrepartie. Le lead
 * perdant ressort `unmatched`, ce qui est visible et comptable — l'inverse
 * (gonfler le revenu) ne le serait pas.
 */
classes AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY ga4_lead_id ORDER BY priorite, ecart_s, external_id
    ) AS rang_lead,
    ROW_NUMBER() OVER (
      PARTITION BY external_id ORDER BY priorite, ecart_s, ga4_lead_id
    ) AS rang_crm
  FROM candidats
),

appariements AS (
  SELECT ga4_lead_id, external_id, methode, confiance
  FROM classes
  WHERE rang_lead = 1 AND rang_crm = 1
)

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
  l.geo_city,

  -- État CRM. Tout est NULL pour un lead qu'aucune affaire n'a rejoint, et
  -- c'est la lecture correcte : « le CRM n'en sait rien », jamais « zéro ».
  crm.external_id      AS crm_external_id,
  crm.crm_source,
  crm.deal_status      AS crm_status,
  crm.deal_stage       AS crm_stage,
  crm.deal_value       AS crm_deal_value,
  crm.deal_currency    AS crm_currency,
  crm.deal_closed_at   AS crm_closed_at,
  crm.is_won           AS crm_is_won,
  a.methode            AS crm_match_method,
  a.confiance          AS crm_match_confidence
FROM `${PROJECT}.staging.stg_ga4__leads` AS l
LEFT JOIN `${PROJECT}.marts.dim_campaign` AS c
  ON c.platform = l.platform AND c.campaign_id = l.campaign_id
LEFT JOIN appariements AS a ON a.ga4_lead_id = l.lead_id
LEFT JOIN crm ON crm.external_id = a.external_id;
