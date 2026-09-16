-- staging.stg_google_ads__conversion_action_daily — les conversions Google Ads
-- détaillées par action, au grain (jour, campagne, action de conversion).
--
-- Sans ce modèle, la seule mesure disponible est `metrics_conversions`, qui
-- additionne toutes les actions marquées « principales » dans le compte. Or le
-- plan de taggage §7.1 en prévoit deux (`Estimation — lead` et
-- `Contact — message`) plus trois secondaires. Comparer ce total au seul
-- `generate_lead` de GA4 donnerait un rapport durablement supérieur à 1 et
-- ferait crier le contrôle anti-doublon tous les jours — pour rien.
--
-- CLÉ D'IDENTIFICATION — on s'appuie sur `segments_conversion_action_category`,
-- pas sur le nom de l'action. Le nom est un libellé que quelqu'un renommera un
-- jour dans l'interface, et le rapprochement casserait sans bruit. La catégorie
-- est un enum de l'API, choisi à la création de l'action, et le plan §7.1 la
-- fixe déjà : `Estimation — lead` est en « Envoyer un formulaire de prospect »,
-- soit SUBMIT_LEAD_FORM.

CREATE OR REPLACE VIEW `${PROJECT}.staging.stg_google_ads__conversion_action_daily`
OPTIONS (
  description = "Conversions Google Ads par action et par catégorie, jour et campagne. Base du contrôle de cohérence avec GA4."
)
AS
SELECT
  'google_ads'                       AS platform,
  segments_date                      AS date,
  CAST(customer_id AS STRING)        AS account_id,
  CAST(campaign_id AS STRING)        AS campaign_id,
  segments_conversion_action_name    AS conversion_action_name,
  segments_conversion_action_category AS conversion_action_category,
  SUM(metrics_conversions)           AS conversions,
  SUM(metrics_conversions_value)     AS conversions_value
FROM `${PROJECT}.raw_google_ads.p_ads_CampaignConversionStats_${ADS_CUSTOMER_ID}`
GROUP BY date, account_id, campaign_id, conversion_action_name, conversion_action_category;
