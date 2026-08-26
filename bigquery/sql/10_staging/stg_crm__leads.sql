-- staging.stg_crm__leads — un lead CRM par ligne, dans son état le plus récent.
--
-- `raw_app.crm_leads` est un journal : une ligne par événement reçu, et un CRM
-- qui fait passer une affaire de `open` à `won` en ajoute une plutôt que d'en
-- modifier une. Cette vue en tire l'état courant — une ligne par
-- `(project_id, external_id)`, la dernière que le CRM ait affirmée.
--
-- DEUX DÉDUPLICATIONS, et elles ne font pas le même travail :
--   · sur `ingestion_id`, parce que l'insertion en streaming de BigQuery
--     déduplique « au mieux » sur `insertId` et que « au mieux » n'est pas
--     « toujours » — une reprise réseau côté application peut laisser passer
--     un doublon strict ;
--   · sur `(project_id, external_id)`, pour ne garder que la version courante.
-- La première protège d'un défaut de transport, la seconde met en œuvre une
-- règle de lecture. Les confondre reviendrait à perdre l'historique des
-- statuts le jour où on voudra le lire.
--
-- ON DÉPARTAGE PAR `received_at`, PAS PAR `occurred_at` : `occurred_at` est
-- fourni par l'appelant et ne bouge pas d'une mise à jour à l'autre — c'est la
-- date de création du lead, pas celle de l'affirmation. Deux versions du même
-- lead partagent donc le même `occurred_at`, et seul l'ordre d'arrivée les
-- sépare.
--
-- AUCUNE RÈGLE MÉTIER ICI. Le rapprochement avec GA4 est une jointure entre
-- deux sources : il appartient à `marts`, et se lit dans `fct_leads`.

CREATE OR REPLACE VIEW `${PROJECT}.staging.stg_crm__leads`
OPTIONS (
  description = "Un lead CRM par ligne, dans sa version la plus récente. Dédupliqué sur ingestion_id puis sur (project_id, external_id)."
)
AS
WITH sans_doublon_technique AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY ingestion_id ORDER BY received_at) AS rang_technique
  FROM `${PROJECT}.raw_app.crm_leads`
),

versions AS (
  SELECT
    * EXCEPT (rang_technique),
    ROW_NUMBER() OVER (
      PARTITION BY project_id, external_id
      ORDER BY received_at DESC, ingestion_id DESC
    ) AS rang_version,
    COUNT(*) OVER (PARTITION BY project_id, external_id) AS versions_recues
  FROM sans_doublon_technique
  WHERE rang_technique = 1
)

SELECT
  external_id,
  project_id,
  crm_source,
  ingestion_id,

  occurred_at,
  DATE(occurred_at) AS lead_date,
  received_at,
  -- Combien de fois le CRM s'est repris sur ce lead. Utile pour repérer une
  -- intégration qui repousse tout à chaque synchronisation.
  versions_recues,

  -- Clés de rapprochement. `NULLIF(..., '')` parce qu'un CRM qui « vide » un
  -- champ envoie tantôt `null`, tantôt la chaîne vide, et qu'une chaîne vide
  -- qui rentre dans une jointure rapproche tous les leads sans clé entre eux.
  NULLIF(match_lead_id, '')        AS match_lead_id,
  NULLIF(match_gclid, '')          AS match_gclid,
  NULLIF(match_session_key, '')    AS match_session_key,
  NULLIF(match_user_pseudo_id, '') AS match_user_pseudo_id,
  LOWER(NULLIF(match_utm_source, ''))  AS match_utm_source,
  LOWER(NULLIF(match_utm_medium, ''))  AS match_utm_medium,
  LOWER(NULLIF(match_utm_content, '')) AS match_utm_content,
  LOWER(NULLIF(match_utm_campaign, '')) AS match_utm_campaign,

  NULLIF(deal_status, '') AS deal_status,
  NULLIF(deal_stage, '')  AS deal_stage,
  deal_value,
  UPPER(NULLIF(deal_currency, '')) AS deal_currency,
  deal_closed_at,
  NULLIF(deal_lost_reason, '') AS deal_lost_reason,

  -- Une affaire est gagnée quand le CRM l'a dit ET l'a datée. Le vocabulaire
  -- de statut n'est jamais normalisé par l'application : on reconnaît ici les
  -- valeurs courantes, et on considère qu'une affaire close avec un montant
  -- est gagnée même si le libellé est inconnu.
  (
    LOWER(COALESCE(deal_status, '')) IN ('won', 'gagne', 'gagné', 'closed_won', 'signe', 'signé')
    OR (deal_closed_at IS NOT NULL AND COALESCE(deal_value, 0) > 0)
  ) AS is_won,

  LOWER(COALESCE(deal_status, '')) IN ('lost', 'perdu', 'closed_lost') AS is_lost
FROM versions
WHERE rang_version = 1;
