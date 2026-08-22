-- marts.v_platform_reconciliation — le contrôle §12.3 du plan de taggage,
-- automatisé.
--
-- Les régies et GA4 ne compteront JAMAIS pareil, et c'est normal : fenêtres
-- d'attribution différentes (30 j clic côté Ads, 7 j clic / 1 j vue côté Meta,
-- 90 j côté GA4), modèles différents, et surtout modélisation du consentement
-- côté Google là où GA4 ne montre que l'observé. Un écart n'est donc pas un
-- défaut.
--
-- Ce que cette vue cherche, ce sont les écarts qui, eux, sont des défauts :
--   · un rapport durablement voisin de 2 sur Google Ads = la même conversion
--     comptée deux fois, presque toujours parce qu'un import GA4 a été activé
--     en plus de la balise directe (interdit par §2.5) ;
--   · un rapport proche de 0 avec de la dépense = les balises ne remontent
--     rien, ou la conversion n'est pas rattachée au compte ;
--   · un écart qui se creuse d'un coup = quelque chose a bougé dans GTM.
--
-- ON COMPARE CE QUI EST COMPARABLE. Côté Google, on isole les conversions de
-- catégorie SUBMIT_LEAD_FORM — l'action `Estimation — lead` du plan §7.1 — et
-- non le total du compte, qui inclut `Contact — message`. Côté Meta, le pixel
-- ne remonte `Lead` que sur `generate_lead` (§8). Des deux côtés, le
-- comparable est donc le même : le lead d'estimation, et lui seul.
--
-- Le verdict est délibérément grossier. Une alerte trop fine sur des volumes de
-- démarrage crierait tous les jours, et une alerte qui crie tous les jours ne
-- se lit plus.

CREATE OR REPLACE VIEW `${PROJECT}.marts.v_platform_reconciliation`
OPTIONS (
  description = "Écart entre conversions déclarées par les régies et leads d'estimation observés dans GA4, avec verdict de vraisemblance."
)
AS
WITH conversions_regie AS (
  SELECT
    date,
    platform,
    SUM(conversions) AS platform_conversions
  FROM `${PROJECT}.staging.stg_google_ads__conversion_action_daily`
  WHERE conversion_action_category = 'SUBMIT_LEAD_FORM'
  GROUP BY date, platform

  UNION ALL

  SELECT
    date,
    platform,
    SUM(platform_conversions) AS platform_conversions
  FROM `${PROJECT}.staging.stg_meta_ads__campaign_daily`
  GROUP BY date, platform
),

depense AS (
  SELECT date, platform, SUM(cost) AS cost
  FROM `${PROJECT}.staging.stg_ads__spend_daily`
  GROUP BY date, platform
),

leads_ga4 AS (
  SELECT
    event_date                            AS date,
    platform,
    COUNTIF(lead_category = 'estimation')  AS ga4_leads_estimation,
    COUNT(*)                               AS ga4_leads_total
  FROM `${PROJECT}.staging.stg_ga4__leads`
  WHERE platform IN ('google_ads', 'meta')
  GROUP BY date, platform
),

cles AS (
  SELECT date, platform FROM conversions_regie
  UNION DISTINCT
  SELECT date, platform FROM depense WHERE platform IN ('google_ads', 'meta')
  UNION DISTINCT
  SELECT date, platform FROM leads_ga4
),

par_jour AS (
  SELECT
    k.date,
    k.platform,
    COALESCE(d.cost, 0)                     AS cost,
    COALESCE(r.platform_conversions, 0)     AS platform_conversions,
    COALESCE(l.ga4_leads_estimation, 0)     AS ga4_leads_estimation,
    COALESCE(l.ga4_leads_total, 0)          AS ga4_leads_total
  FROM cles AS k
  LEFT JOIN conversions_regie AS r USING (date, platform)
  LEFT JOIN depense           AS d USING (date, platform)
  LEFT JOIN leads_ga4         AS l USING (date, platform)
),

glissant AS (
  SELECT
    *,
    -- 7 jours glissants : à l'échelle de la journée, une conversion attribuée
    -- la veille suffit à produire un rapport de 0,5 ou de 2 qui ne veut rien
    -- dire. Le verdict se prononce sur la semaine.
    SUM(platform_conversions) OVER fenetre AS platform_conversions_7d,
    SUM(ga4_leads_estimation) OVER fenetre AS ga4_leads_7d,
    SUM(cost) OVER fenetre                 AS cost_7d
  FROM par_jour
  WINDOW fenetre AS (
    PARTITION BY platform ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
  )
)

SELECT
  date,
  platform,
  cost,
  platform_conversions,
  ga4_leads_estimation,
  ga4_leads_total,
  cost_7d,
  platform_conversions_7d,
  ga4_leads_7d,
  SAFE_DIVIDE(platform_conversions_7d, ga4_leads_7d) AS ratio_7d,
  CASE
    -- Sous 5 leads sur 7 jours, aucun rapport n'est interprétable.
    WHEN ga4_leads_7d < 5 AND platform_conversions_7d < 5
      THEN 'volume_insuffisant'
    WHEN cost_7d > 0 AND platform_conversions_7d = 0
      THEN 'alerte_aucune_conversion_remontee'
    WHEN SAFE_DIVIDE(platform_conversions_7d, ga4_leads_7d) BETWEEN 1.7 AND 2.4
      THEN 'alerte_double_comptage_probable'
    WHEN SAFE_DIVIDE(platform_conversions_7d, ga4_leads_7d) > 2.4
      THEN 'alerte_ecart_inexplique'
    WHEN SAFE_DIVIDE(platform_conversions_7d, ga4_leads_7d) < 0.4
      THEN 'alerte_sous_remontee'
    ELSE 'coherent'
  END AS verdict
FROM glissant;
