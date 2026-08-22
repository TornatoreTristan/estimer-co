-- staging.stg_ads__spend_daily — Google Ads et Meta dans un seul tableau.
--
-- Point de couture des deux régies. Les colonnes portent les mêmes noms et les
-- mêmes unités des deux côtés (le travail a été fait dans les deux vues
-- amont) : ajouter une troisième régie demain ne demandera qu'un `UNION ALL`
-- de plus, pas de retoucher les marts.
--
-- Ce que cette vue NE fait PAS : convertir les devises. Les deux comptes sont
-- en euros ; si l'un passait dans une autre devise, il faudrait un taux de
-- change daté, et le silence actuel vaut mieux qu'une addition fausse. La
-- colonne `currency` est là pour qu'on s'en aperçoive.

CREATE OR REPLACE VIEW `${PROJECT}.staging.stg_ads__spend_daily`
OPTIONS (
  description = "Dépense publicitaire unifiée Google Ads + Meta, au grain (jour, plateforme, campagne)."
)
AS
SELECT * FROM `${PROJECT}.staging.stg_google_ads__campaign_daily`
UNION ALL
SELECT * FROM `${PROJECT}.staging.stg_meta_ads__campaign_daily`;
