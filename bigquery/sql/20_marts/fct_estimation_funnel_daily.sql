-- marts.fct_estimation_funnel_daily — le tunnel d'estimation, étape par étape.
--
-- Grain : (jour, plateforme, étape). Différent de
-- `fct_marketing_performance_daily`, où l'étape est une colonne : ici c'est
-- l'étape qui fait la ligne, ce qui permet de tracer l'entonnoir sans écrire
-- cinq colonnes en dur dans chaque rapport — et sans en ajouter une sixième le
-- jour où le tunnel gagne une étape.
--
-- On compte des **sessions distinctes**, pas des événements. Un visiteur qui
-- revient sur l'étape 2 pour corriger sa surface produit deux
-- `estimation_step_view` ; il n'a pas visité deux fois le tunnel. Compter les
-- événements gonflerait le haut de l'entonnoir et ferait croire à une fuite
-- entre les étapes 2 et 3 qui n'existe pas.
--
-- Seuls les passages en marche avant (`step_direction = 'forward'`) comptent,
-- pour la même raison.

CREATE OR REPLACE VIEW `${PROJECT}.marts.fct_estimation_funnel_daily`
OPTIONS (
  description = "Entonnoir du tunnel d'estimation : sessions distinctes par étape, erreurs de validation, taux de passage."
)
AS
WITH etapes AS (
  SELECT
    event_date                                        AS date,
    platform,
    step_number,
    ANY_VALUE(step_key)                               AS step_key,
    COUNT(DISTINCT session_key)                       AS sessions_reached
  FROM `${PROJECT}.staging.stg_ga4__events`
  WHERE event_name = 'estimation_step_view'
    AND step_direction = 'forward'
    AND step_number IS NOT NULL
  GROUP BY date, platform, step_number
),

erreurs AS (
  SELECT
    event_date                  AS date,
    platform,
    step_number,
    COUNT(DISTINCT session_key) AS sessions_with_error,
    COUNT(*)                    AS error_events,
    -- Les champs fautifs les plus fréquents du jour : c'est la donnée qui dit
    -- QUOI corriger dans le formulaire, pas seulement où ça coince.
    ARRAY_AGG(DISTINCT error_fields IGNORE NULLS LIMIT 10) AS top_error_fields
  FROM `${PROJECT}.staging.stg_ga4__events`
  WHERE event_name = 'estimation_step_error'
    AND step_number IS NOT NULL
  GROUP BY date, platform, step_number
)

SELECT
  e.date,
  e.platform,
  e.step_number,
  e.step_key,
  e.sessions_reached,
  COALESCE(x.sessions_with_error, 0)  AS sessions_with_error,
  COALESCE(x.error_events, 0)         AS error_events,
  x.top_error_fields,

  -- Sessions présentes à l'étape suivante, et taux de passage. La fenêtre est
  -- bornée à (jour, plateforme) : comparer l'étape 3 du lundi à l'étape 4 du
  -- mardi n'aurait pas de sens.
  LEAD(e.sessions_reached) OVER (
    PARTITION BY e.date, e.platform ORDER BY e.step_number
  )                                   AS sessions_next_step,
  SAFE_DIVIDE(
    LEAD(e.sessions_reached) OVER (PARTITION BY e.date, e.platform ORDER BY e.step_number),
    e.sessions_reached
  )                                   AS step_completion_rate,
  SAFE_DIVIDE(
    e.sessions_reached,
    FIRST_VALUE(e.sessions_reached) OVER (
      PARTITION BY e.date, e.platform ORDER BY e.step_number
    )
  )                                   AS retention_from_step_1
FROM etapes AS e
LEFT JOIN erreurs AS x USING (date, platform, step_number);
