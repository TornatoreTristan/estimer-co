-- raw_meta_ads.ad_insights_daily — cible de `scripts/ingest-meta-ads.mjs`.
--
-- Grain : une ligne par (date, annonce). C'est le grain le plus fin que l'API
-- Insights sert avec `time_increment=1`, et le seul qui permette d'agréger
-- ensuite au niveau annonce, ensemble ou campagne sans re-appeler Meta.
--
-- `actions` et `action_values` restent des tableaux bruts : Meta y empile des
-- dizaines de types d'action dont la liste dépend du pixel et change sans
-- préavis. Les aplatir ici figerait une liste qui vieillirait mal ; le staging
-- en extrait les deux ou trois qui nous intéressent.
--
-- La table est rechargée par fenêtre glissante (cf. le script) : Meta
-- ré-attribue les conversions jusqu'à 28 jours en arrière, un chargement en
-- append pur produirait des doublons ET des chiffres périmés.

CREATE TABLE IF NOT EXISTS `${PROJECT}.raw_meta_ads.ad_insights_daily` (
  date              DATE   NOT NULL OPTIONS (description = "Jour de diffusion (date_start de l'API)."),
  account_id        STRING OPTIONS (description = "Sans le préfixe act_."),
  account_name      STRING,
  campaign_id       STRING OPTIONS (description = "Clé de jointure avec utm_id côté GA4 (plan de taggage §10.1)."),
  campaign_name     STRING,
  adset_id          STRING,
  adset_name        STRING,
  ad_id             STRING,
  ad_name           STRING OPTIONS (description = "Repris en utm_content par la convention de nommage."),
  impressions       INT64,
  clicks            INT64,
  inline_link_clicks INT64 OPTIONS (description = "Clics sortants vers le site — le comparable des sessions GA4, pas `clicks`."),
  reach             INT64,
  frequency         FLOAT64,
  spend             NUMERIC OPTIONS (description = "Dans la devise du compte."),
  currency          STRING,
  actions           ARRAY<STRUCT<action_type STRING, value FLOAT64>>
                    OPTIONS (description = "Conversions déclarées par Meta, brutes."),
  action_values     ARRAY<STRUCT<action_type STRING, value FLOAT64>>,
  ingested_at       TIMESTAMP NOT NULL
)
PARTITION BY date
CLUSTER BY campaign_id, adset_id
OPTIONS (
  description = "Brut Meta Marketing API, niveau annonce, pas quotidien. Écrit par scripts/ingest-meta-ads.mjs."
);
