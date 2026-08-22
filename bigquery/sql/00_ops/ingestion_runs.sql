-- ops.ingestion_runs — journal des ingestions pilotées par nous.
--
-- Ne couvre PAS l'export GA4 ni le transfert Google Ads : ceux-là sont opérés
-- par Google et se surveillent par la fraîcheur de leurs tables
-- (`marts.v_data_freshness`). Cette table ne consigne que ce que nos scripts
-- écrivent — aujourd'hui Meta Ads, demain l'export applicatif.
--
-- Une ligne par exécution, écrite MÊME en cas d'échec : une ingestion qui
-- échoue en silence est le seul défaut qu'un contrôle de fraîcheur ne sait pas
-- distinguer d'un jour sans dépense.

CREATE TABLE IF NOT EXISTS `${PROJECT}.ops.ingestion_runs` (
  run_id        STRING  NOT NULL OPTIONS (description = "UUID de l'exécution."),
  source        STRING  NOT NULL OPTIONS (description = "Source ingérée : meta_ads, app_leads…"),
  started_at    TIMESTAMP NOT NULL,
  finished_at   TIMESTAMP,
  status        STRING  OPTIONS (description = "running | success | failure"),
  window_start  DATE    OPTIONS (description = "Premier jour de la fenêtre rechargée."),
  window_end    DATE    OPTIONS (description = "Dernier jour de la fenêtre rechargée."),
  rows_loaded   INT64,
  error_message STRING
)
PARTITION BY DATE(started_at)
OPTIONS (
  description = "Journal des ingestions maison. Une ligne par exécution, succès comme échec.",
  partition_expiration_days = 400
);
