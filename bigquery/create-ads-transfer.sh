#!/usr/bin/env bash
#
# Crée le transfert BigQuery Data Transfer Service pour Google Ads.
#
# À lancer une seule fois, depuis un vrai terminal : la commande affiche une URL
# de consentement OAuth et attend qu'on lui recolle un `version_info`. Elle
# échoue immédiatement si son entrée standard n'est pas un terminal.
#
#   bash bigquery/create-ads-transfer.sh
#
# Pourquoi un script pour une seule commande : collée à la main, elle dépasse la
# largeur du terminal et le retour à la ligne la coupe en deux — le shell
# exécute alors `--params=...` comme s'il s'agissait d'une commande. Un fichier
# supprime le problème, et documente au passage le paramétrage retenu.

set -euo pipefail

PROJET="${GCP_PROJECT:-estimer-505209}"
COMPTE_ADS="${GOOGLE_ADS_CUSTOMER_ID:-3838716042}"   # 383-871-6042, sans les tirets

# 30 jours de fenêtre de rafraîchissement : c'est la durée pendant laquelle
# Google réattribue ses conversions. Plus court figerait des chiffres qui
# bougent encore, et les rapports d'aujourd'hui cesseraient de correspondre à
# ceux de la semaine prochaine sans qu'on sache pourquoi.
exec bq --project_id="$PROJET" mk --transfer_config \
  --data_source=google_ads \
  --target_dataset=raw_google_ads \
  --display_name="Google Ads - estimer.co" \
  --params="{\"customer_id\":\"$COMPTE_ADS\",\"refresh_window_days\":\"30\"}"
