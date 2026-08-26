-- marts.v_crm_reconciliation — la régie, GA4 et le CRM côte à côte.
--
-- `v_platform_reconciliation` juxtapose deux sources qui ne comptent pas la
-- même chose. Celle-ci en ajoute une troisième, et le principe ne bouge pas
-- d'un pouce : une régie compte des clics convertis, GA4 des sessions
-- modélisées, un CRM des fiches créées par un humain. Trois comptages, trois
-- définitions, trois colonnes.
--
-- RÈGLE NON NÉGOCIABLE, ÉTENDUE À TROIS SOURCES. Cette vue n'expose et
-- n'exposera JAMAIS de colonne « consolidée » sommant ou moyennant
-- `platform_conversions`, `ga4_leads_estimation` et `crm_leads_total`. Le fait
-- qu'il y ait maintenant trois colonnes au lieu de deux rend la tentation plus
-- forte, pas plus légitime. Un chiffre unique serait faux par construction, et
-- l'application ne doit pas en fabriquer un non plus.
--
-- CE QUE CETTE VUE APPORTE QUE LES AUTRES N'ONT PAS : un revenu. `cost` d'un
-- côté, `crm_revenue` de l'autre, sur la même ligne. C'est le passage du coût
-- par lead au coût par affaire signée, et c'est la seule raison d'avoir
-- branché un CRM.
--
-- LA PLATEFORME `non_rattache`. Un lead CRM qu'aucun lead GA4 n'a rejoint n'a
-- pas de plateforme — il n'a pas de canal d'acquisition connu, c'est même la
-- définition. Le ranger dans `google_ads` ou `meta` serait une invention ; le
-- taire serait pire. Il ressort donc sur une ligne à part, `platform =
-- 'non_rattache'`, sans coût ni conversion en face. Cette ligne est la mesure
-- de la qualité du branchement : si elle est grosse, le rapprochement ne
-- marche pas, et tout le reste de la vue doit être lu avec méfiance.
--
-- LA DEVISE. `crm_revenue` est NULL dès que plusieurs devises coexistent sur
-- la ligne. Additionner des euros et des livres pour afficher un total est
-- exactement le genre de chiffre faux qui ne se voit jamais.

CREATE OR REPLACE VIEW `${PROJECT}.marts.v_crm_reconciliation`
OPTIONS (
  description = "Régie, GA4 et CRM juxtaposés par jour et plateforme, avec revenu réel et qualité de rapprochement. Jamais de total consolidé."
)
AS
WITH conversions_regie AS (
  SELECT date, platform, SUM(conversions) AS platform_conversions
  FROM `${PROJECT}.staging.stg_google_ads__conversion_action_daily`
  WHERE conversion_action_category = 'SUBMIT_LEAD_FORM'
  GROUP BY date, platform

  UNION ALL

  SELECT date, platform, SUM(platform_conversions)
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
    COUNTIF(lead_category = 'estimation') AS ga4_leads_estimation,
    COUNT(*)                              AS ga4_leads_total
  FROM `${PROJECT}.staging.stg_ga4__leads`
  GROUP BY date, platform
),

/*
 * Les leads CRM rapprochés héritent de la plateforme du lead GA4 auquel ils
 * ont été appariés — c'est `fct_leads` qui porte cet appariement, on ne le
 * refait pas ici.
 */
crm_rapproche AS (
  SELECT
    lead_date                                        AS date,
    platform,
    COUNT(*)                                         AS crm_leads,
    COUNTIF(crm_is_won)                              AS crm_deals_won,
    SUM(IF(crm_is_won, crm_deal_value, 0))           AS crm_revenue_brut,
    COUNT(DISTINCT crm_currency)                     AS devises_distinctes,
    ANY_VALUE(crm_currency)                          AS devise,
    COUNTIF(crm_match_method = 'utm_window')         AS crm_matchs_probabilistes
  FROM `${PROJECT}.marts.fct_leads`
  WHERE crm_external_id IS NOT NULL
  GROUP BY date, platform
),

crm_non_rattache AS (
  SELECT
    c.lead_date                                      AS date,
    'non_rattache'                                   AS platform,
    COUNT(*)                                         AS crm_leads,
    COUNTIF(c.is_won)                                AS crm_deals_won,
    SUM(IF(c.is_won, c.deal_value, 0))               AS crm_revenue_brut,
    COUNT(DISTINCT c.deal_currency)                  AS devises_distinctes,
    ANY_VALUE(c.deal_currency)                       AS devise,
    0                                                AS crm_matchs_probabilistes
  FROM `${PROJECT}.staging.stg_crm__leads` AS c
  LEFT JOIN (
    SELECT DISTINCT crm_external_id
    FROM `${PROJECT}.marts.fct_leads`
    WHERE crm_external_id IS NOT NULL
  ) AS m ON m.crm_external_id = c.external_id
  WHERE m.crm_external_id IS NULL
  GROUP BY date
),

crm AS (
  SELECT *, TRUE  AS rapproche FROM crm_rapproche
  UNION ALL
  SELECT *, FALSE AS rapproche FROM crm_non_rattache
),

cles AS (
  SELECT date, platform FROM conversions_regie
  UNION DISTINCT
  SELECT date, platform FROM depense WHERE platform IN ('google_ads', 'meta')
  UNION DISTINCT
  SELECT date, platform FROM leads_ga4
  UNION DISTINCT
  SELECT date, platform FROM crm
),

par_jour AS (
  SELECT
    k.date,
    k.platform,
    COALESCE(d.cost, 0)                  AS cost,
    COALESCE(r.platform_conversions, 0)  AS platform_conversions,
    COALESCE(g.ga4_leads_estimation, 0)  AS ga4_leads_estimation,
    COALESCE(c.crm_leads, 0)             AS crm_leads_total,
    COALESCE(IF(c.rapproche, c.crm_leads, 0), 0)     AS crm_leads_matched,
    COALESCE(IF(c.rapproche, 0, c.crm_leads), 0)     AS crm_leads_unmatched,
    COALESCE(c.crm_deals_won, 0)         AS crm_deals_won,
    -- NULL plutôt qu'un total faux quand plusieurs devises se mélangent.
    IF(COALESCE(c.devises_distinctes, 0) > 1, NULL, c.crm_revenue_brut) AS crm_revenue,
    IF(COALESCE(c.devises_distinctes, 0) > 1, 'MULTIPLE', c.devise)     AS crm_currency,
    COALESCE(c.crm_matchs_probabilistes, 0) AS crm_matchs_probabilistes
  FROM cles AS k
  LEFT JOIN conversions_regie AS r USING (date, platform)
  LEFT JOIN depense           AS d USING (date, platform)
  LEFT JOIN leads_ga4         AS g USING (date, platform)
  LEFT JOIN crm               AS c USING (date, platform)
),

/*
 * La qualité de rapprochement se juge à la JOURNÉE, toutes plateformes
 * confondues : un lead non rattaché n'appartient à aucune plateforme, donc un
 * taux par plateforme n'aurait pas de dénominateur honnête. Le verdict est
 * ensuite recopié sur chaque ligne du jour.
 *
 * Sur 7 jours glissants, comme `v_platform_reconciliation` : à l'échelle d'une
 * journée un seul lead non rattaché produit un taux de 100 % qui ne veut rien
 * dire.
 */
qualite_par_jour AS (
  SELECT
    date,
    SUM(crm_leads_total)          AS crm_total_jour,
    SUM(crm_leads_matched)        AS crm_matched_jour,
    SUM(crm_matchs_probabilistes) AS crm_probabilistes_jour
  FROM par_jour
  GROUP BY date
),

qualite_glissante AS (
  SELECT
    date,
    SUM(crm_total_jour)          OVER fenetre AS crm_total_7d,
    SUM(crm_matched_jour)        OVER fenetre AS crm_matched_7d,
    SUM(crm_probabilistes_jour)  OVER fenetre AS crm_probabilistes_7d
  FROM qualite_par_jour
  WINDOW fenetre AS (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)
)

SELECT
  p.date,
  p.platform,

  -- Ce que la régie a facturé et déclaré
  p.cost,
  p.platform_conversions,

  -- Ce que GA4 a observé
  p.ga4_leads_estimation,

  -- Ce que le CRM affirme
  p.crm_leads_total,
  p.crm_leads_matched,
  -- Jamais masqué : c'est la mesure de qualité du branchement.
  p.crm_leads_unmatched,
  p.crm_deals_won,
  p.crm_revenue,
  p.crm_currency,

  q.crm_total_7d,
  q.crm_matched_7d,
  SAFE_DIVIDE(q.crm_matched_7d, q.crm_total_7d) AS crm_match_rate_7d,

  CASE
    WHEN COALESCE(q.crm_total_7d, 0) < 5
      THEN 'volume_insuffisant'
    WHEN q.crm_matched_7d = 0
      THEN 'alerte_aucun_rapprochement'
    WHEN SAFE_DIVIDE(q.crm_matched_7d, q.crm_total_7d) < 0.5
      THEN 'alerte_rapprochement_faible'
    -- Rapproché, mais surtout par UTM : les chiffres tiennent debout, le taux
    -- de transformation qu'on en tirerait beaucoup moins.
    WHEN SAFE_DIVIDE(q.crm_probabilistes_7d, q.crm_matched_7d) > 0.5
      THEN 'rapprochement_majoritairement_probabiliste'
    ELSE 'coherent'
  END AS match_quality_verdict
FROM par_jour AS p
LEFT JOIN qualite_glissante AS q USING (date);
