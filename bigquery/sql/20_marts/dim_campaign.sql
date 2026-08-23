-- marts.dim_campaign — le référentiel des campagnes, toutes régies confondues.
--
-- Clé : (platform, campaign_id). Jamais le nom. Un nom de campagne se renomme
-- en cours de route et emporte avec lui l'historique de tous les rapports qui
-- s'y appuyaient ; l'identifiant, lui, ne bouge pas. C'est aussi la raison
-- d'être de `utm_id={{campaign.id}}` dans la convention Meta du plan de
-- taggage §10.1 — sans lui, Meta n'aurait pas de clé stable côté GA4.
--
-- La vue contrôle en passant la convention de nommage §10.2
-- (`canal_objectif_cible_zone_AAAAMM`). Ce n'est pas de la coquetterie : c'est
-- ce qui permettra de comparer « toutes les campagnes propriétaire d'Île-de-France »
-- sans tenir une table de correspondance à la main. Une campagne hors
-- convention n'est pas rejetée — elle est signalée (`naming_is_compliant`),
-- et c'est au marketing de trancher.

CREATE OR REPLACE VIEW `${PROJECT}.marts.dim_campaign`
OPTIONS (
  description = "Référentiel des campagnes Google Ads et Meta, clé (platform, campaign_id), avec contrôle de la convention de nommage."
)
AS
WITH derniere_vue AS (
  SELECT
    platform,
    campaign_id,
    campaign_name,
    campaign_status,
    channel_type,
    channel_sub_type,
    account_id,
    account_name,
    currency,
    MIN(date) OVER (PARTITION BY platform, campaign_id) AS first_active_date,
    MAX(date) OVER (PARTITION BY platform, campaign_id) AS last_active_date,
    SUM(cost) OVER (PARTITION BY platform, campaign_id) AS lifetime_cost
  FROM `${PROJECT}.staging.stg_ads__spend_daily`
  WHERE campaign_id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY platform, campaign_id ORDER BY date DESC) = 1
)

SELECT
  platform,
  campaign_id,
  campaign_name,
  campaign_status,
  channel_type,
  channel_sub_type,
  account_id,
  account_name,
  currency,
  first_active_date,
  last_active_date,
  lifetime_cost,

  -- Découpage de la convention `canal_objectif_cible_zone_AAAAMM`.
  -- `SAFE_OFFSET` partout : un nom non conforme donne des NULL, jamais une
  -- erreur qui ferait tomber la vue pour tout le monde.
  LOWER(SPLIT(campaign_name, '_')[SAFE_OFFSET(0)]) AS naming_channel,
  LOWER(SPLIT(campaign_name, '_')[SAFE_OFFSET(1)]) AS naming_objective,
  LOWER(SPLIT(campaign_name, '_')[SAFE_OFFSET(2)]) AS naming_audience,
  LOWER(SPLIT(campaign_name, '_')[SAFE_OFFSET(3)]) AS naming_zone,
  SAFE.PARSE_DATE('%Y%m',
    REGEXP_EXTRACT(campaign_name, r'_(\d{6})$'))   AS naming_month,
  REGEXP_CONTAINS(campaign_name, r'^[a-z0-9]+_[a-z0-9]+_[a-z0-9]+_[a-z0-9]+_\d{6}$')
                                                   AS naming_is_compliant
FROM derniere_vue;
