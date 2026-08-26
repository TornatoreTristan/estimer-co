-- raw_app.crm_leads — la boîte aux lettres de l'application de pilotage.
--
-- SEULE table de tout l'entrepôt qu'une application extérieure écrit. Elle
-- reçoit les leads que les CRM des clients poussent sur l'API
-- `POST /api/v1/projects/:projectId/leads` d'`app-marketing`, et rien d'autre.
-- L'application n'a AUCUN droit de lecture ici : elle dépose, elle ne relit
-- jamais. Ce qu'elle relira, c'est `marts.v_crm_reconciliation`, comme
-- n'importe quel autre mart.
--
-- POURQUOI `raw_app` ET PAS `raw` : le dataset était déjà réservé aux données
-- applicatives estimer.co, avec un contrôle d'accès distinct, précisément
-- parce qu'on savait qu'un export applicatif viendrait un jour. Le voici.
--
-- AUCUNE DONNÉE PERSONNELLE, et c'est structurel plutôt que déclaratif :
-- l'API refuse tout champ hors liste blanche, et refuse en plus tout ce qui
-- ressemble à un e-mail ou un téléphone dans un champ libre. `external_id`
-- est la clé de rejointure du client, chez lui, dans son CRM. La garantie
-- portée par `fct_leads` — ni nom, ni e-mail, ni téléphone, ni adresse —
-- reste donc entière après branchement du CRM.
--
-- `CREATE TABLE IF NOT EXISTS` et non `CREATE OR REPLACE` : un `REPLACE`
-- viderait la table à chaque déploiement. C'est le seul objet de ce dépôt qui
-- porte de la donnée qu'aucune source ne sait régénérer.
--
-- UNE LIGNE = UN ÉVÉNEMENT REÇU, pas un lead unique. Un CRM qui repousse le
-- même lead avec un statut à jour ajoute une ligne. La déduplication et le
-- choix de la version courante sont le travail de `stg_crm__leads`.

CREATE TABLE IF NOT EXISTS `${PROJECT}.raw_app.crm_leads`
(
  -- UUID applicatif de la ligne dans le tampon Postgres d'`app-marketing`.
  -- Sert d'`insertId` à l'insertion : c'est sur lui que repose la
  -- déduplication au mieux de BigQuery, et le filet de `stg_crm__leads`.
  ingestion_id      STRING  NOT NULL OPTIONS (description = "UUID de l'événement d'ingestion côté application. Unique."),
  external_id       STRING  NOT NULL OPTIONS (description = "Identifiant du lead chez le CRM. Clé de rejointure du client, chez lui."),
  crm_source        STRING           OPTIONS (description = "hubspot / pipedrive / salesforce / custom…"),
  project_id        STRING           OPTIONS (description = "Projet applicatif émetteur. Un seul par entrepôt aujourd'hui."),

  occurred_at       TIMESTAMP NOT NULL OPTIONS (description = "Création du lead DANS LE CRM, fournie par l'appelant."),
  received_at       TIMESTAMP NOT NULL OPTIONS (description = "Réception par l'API. Horodatage serveur, jamais fourni par l'appelant."),

  -- Clés de rapprochement, par fiabilité décroissante. `match_lead_id` est
  -- l'UUID émis par le navigateur à la soumission (plan de taggage §2.4) —
  -- le même que `transaction_id` côté Google Ads et `eventID` côté Meta.
  -- Quand le CRM le porte, le rapprochement est exact et le reste est inutile.
  match_lead_id     STRING OPTIONS (description = "UUID de soumission du formulaire. La clé exacte."),
  match_gclid       STRING OPTIONS (description = "gclid capté en champ caché. Exact, Google Ads uniquement."),
  match_session_key STRING OPTIONS (description = "Clé de session GA4."),
  match_user_pseudo_id STRING OPTIONS (description = "Identifiant client anonymisé GA4."),
  match_utm_source  STRING,
  match_utm_medium  STRING,
  match_utm_content STRING,
  match_utm_campaign STRING OPTIONS (description = "Accepté par l'API, sans contrepartie : fct_leads n'expose pas utm_campaign."),

  deal_status       STRING  OPTIONS (description = "Vocabulaire du CRM, jamais normalisé par l'application."),
  deal_stage        STRING,
  deal_value        NUMERIC OPTIONS (description = "Montant de l'affaire. Un revenu réel, contrairement à fct_leads.lead_value."),
  deal_currency     STRING  OPTIONS (description = "ISO 4217. Exigé par l'API dès que deal_value est présent."),
  deal_closed_at    TIMESTAMP,
  deal_lost_reason  STRING
)
PARTITION BY DATE(occurred_at)
CLUSTER BY external_id
OPTIONS (
  description = "Brut — leads CRM poussés par app-marketing. Écrit par l'application, jamais relu par elle. Aucune donnée personnelle."
);
