/**
 * Vue matérialisée des statistiques de marché par commune × type × tranche de
 * surface — spec §5.1.
 *
 * Tranches de 20 m² (§5.1). Seules les mutations non aberrantes sont agrégées
 * (Annexe A.2) : une vente à 1 € entre parents ne doit pas déplacer la
 * médiane d'une petite commune.
 */
export const AGG_COMMUNE_TYPE_SQL = `
CREATE MATERIALIZED VIEW agg_commune_type AS
SELECT
  m.code_insee,
  m.type_local,
  -- Tranche de 20 m² : 0-19, 20-39, 40-59… La borne basse sert d'étiquette.
  ((m.surface_bati / 20) * 20)::integer                                   AS tranche_surface,
  count(*)::bigint                                                        AS n,
  percentile_cont(0.25) WITHIN GROUP (ORDER BY m.prix_m2)::numeric(10,2)  AS p25,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY m.prix_m2)::numeric(10,2)  AS mediane,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY m.prix_m2)::numeric(10,2)  AS p75,
  max(m.date_mutation)                                                    AS date_max,
  now()                                                                   AS refreshed_at
FROM mutations m
WHERE m.is_outlier = false
  AND m.prix_m2 IS NOT NULL
GROUP BY m.code_insee, m.type_local, ((m.surface_bati / 20) * 20)
WITH NO DATA
`

/**
 * Rafraîchissement concurrent : l'endpoint marché reste disponible pendant
 * le recalcul.
 *
 * `CONCURRENTLY` exige que la vue ait déjà été peuplée au moins une fois ;
 * `refresh:aggregates` gère ce premier remplissage.
 */
export const REFRESH_AGG_CONCURRENTLY_SQL =
  'REFRESH MATERIALIZED VIEW CONCURRENTLY agg_commune_type'

export const REFRESH_AGG_SQL = 'REFRESH MATERIALIZED VIEW agg_commune_type'
