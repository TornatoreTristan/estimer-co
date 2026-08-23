-- Deux fonctions pour lire `event_params` de l'export GA4.
--
-- GA4 range chaque paramètre dans l'un de quatre champs typés selon ce que le
-- navigateur a poussé : une même clé peut arriver en `int_value` un jour et en
-- `double_value` le lendemain (le dataLayer pousse du JavaScript, qui n'a qu'un
-- seul type numérique). Lire un seul champ, c'est se réveiller avec des NULL
-- inexplicables. Ces fonctions absorbent la question une fois pour toutes.
--
-- Paramètres `ANY TYPE` volontairement : figer la signature exacte du STRUCT
-- GA4 ferait tomber toutes les vues le jour où Google y ajoute un champ.

CREATE OR REPLACE FUNCTION `${PROJECT}.staging.ga4_param_string`(params ANY TYPE, k STRING)
AS ((
  SELECT COALESCE(
           p.value.string_value,
           CAST(p.value.int_value AS STRING),
           CAST(p.value.double_value AS STRING),
           CAST(p.value.float_value AS STRING)
         )
  FROM UNNEST(params) AS p
  WHERE p.key = k
  LIMIT 1
));

CREATE OR REPLACE FUNCTION `${PROJECT}.staging.ga4_param_number`(params ANY TYPE, k STRING)
AS ((
  SELECT COALESCE(
           p.value.double_value,
           p.value.float_value,
           CAST(p.value.int_value AS FLOAT64),
           SAFE_CAST(p.value.string_value AS FLOAT64)
         )
  FROM UNNEST(params) AS p
  WHERE p.key = k
  LIMIT 1
));
