#!/usr/bin/env bash
#
# Génère le jeton d'utilisateur système Meta, par l'API.
#
#   bash bigquery/create-meta-token.sh
#
# POURQUOI PAS L'INTERFACE — l'écran « Générer un token » du Business Manager
# répond « Aucune autorisation disponible » tant que l'utilisateur système n'a
# pas *installé* l'application. Or l'installation n'est pas la même chose que
# l'affectation de l'app comme élément professionnel, et l'interface ne propose
# nulle part de la faire : elle suppose qu'elle a déjà eu lieu. Le seul chemin
# est l'appel API ci-dessous.
# Cf. https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens/
#
# CE QU'IL FAUT AVANT DE LANCER
#
#   1. La clé secrète de l'app : developers.facebook.com → BigQuery Ingestion
#      → Paramètres de l'app → De base → « Clé secrète » → Afficher.
#
#   2. Un jeton d'administrateur temporaire, à récupérer dans l'explorateur :
#      https://developers.facebook.com/tools/explorer
#        · Application            : BigQuery Ingestion
#        · Type de jeton          : Jeton d'accès utilisateur
#        · Autorisations à cocher : business_management
#        · puis « Generate Access Token » et copier la valeur.
#      Ce jeton-là est jetable : il ne sert qu'aux deux appels ci-dessous et
#      expire de lui-même en une heure ou deux.
#
# PUIS
#
#   export META_APP_SECRET="…"
#   export META_ADMIN_TOKEN="…"
#   bash bigquery/create-meta-token.sh
#
# Le jeton final s'affiche à l'écran. C'est lui qui va dans META_ACCESS_TOKEN,
# et il n'expire pas.

set -euo pipefail

APP_ID="${META_APP_ID:-1773273583881445}"          # BigQuery Ingestion
SYSTEM_USER_ID="${META_SYSTEM_USER_ID:-122098996725450566}"  # BigQuery ingestion
BUSINESS_ID="${META_BUSINESS_ID:-2277414275805484}"          # Revontuli
VERSION="${META_API_VERSION:-v23.0}"

# L'identifiant d'un utilisateur système ne se devine pas : un compte Facebook
# ordinaire peut porter exactement le même nom, et l'API répond alors
# « Unsupported request - method type: post » — un message qui ne dit nulle part
# qu'on s'adresse au mauvais type de nœud. Pour le retrouver :
#   GET /<BUSINESS_ID>/system_users?fields=id,name
# Les identifiants d'utilisateur système sont longs (18 chiffres) ; un nœud à
# 14 chiffres est un profil personnel.

: "${META_APP_SECRET:?Renseigner META_APP_SECRET (Paramètres de l\'app → De base → Clé secrète)}"
: "${META_ADMIN_TOKEN:?Renseigner META_ADMIN_TOKEN (jeton utilisateur de l\'explorateur, scope business_management)}"

# Meta exige une signature HMAC-SHA256 du jeton par la clé secrète sur les
# appels sensibles. C'est ce qui prouve que l'appel vient bien de l'app et non
# de quelqu'un qui aurait seulement intercepté le jeton.
PROOF=$(printf '%s' "$META_ADMIN_TOKEN" \
  | openssl dgst -sha256 -hmac "$META_APP_SECRET" \
  | sed 's/^.* //')

echo "1/2 — installation de l'app $APP_ID pour l'utilisateur système $SYSTEM_USER_ID"
curl -sS -X POST "https://graph.facebook.com/$VERSION/$SYSTEM_USER_ID/applications" \
  -F "business_app=$APP_ID" \
  -F "access_token=$META_ADMIN_TOKEN" \
  -F "appsecret_proof=$PROOF"
echo

echo "2/2 — génération du jeton (scope ads_read)"
REPONSE=$(curl -sS -X POST "https://graph.facebook.com/$VERSION/$SYSTEM_USER_ID/access_tokens" \
  -F "business_app=$APP_ID" \
  -F "scope=ads_read" \
  -F "access_token=$META_ADMIN_TOKEN" \
  -F "appsecret_proof=$PROOF")
echo "$REPONSE"
echo

# Cet appel-ci n'accepte qu'un jeton d'utilisateur système *administrateur* —
# un jeton personnel, même administrateur du portefeuille, se voit répondre
# « Unsupported request - method type: post ». Ce n'est pas bloquant : l'étape
# 1 est la seule que l'interface ne sache pas faire, et une fois l'app
# installée, l'écran du Business Manager génère le jeton sans broncher.
case "$REPONSE" in
  *access_token*)
    echo "Le champ access_token ci-dessus est à mettre dans META_ACCESS_TOKEN."
    echo "Il ne sera plus jamais réaffiché : garde-le maintenant."
    ;;
  *)
    cat <<MSG
L'étape 1 a fait l'essentiel. Termine par l'interface, qui fonctionne
maintenant que l'app est installée :

  https://business.facebook.com/settings/system-users/$SYSTEM_USER_ID?business_id=$BUSINESS_ID

  « Générer un nouveau token » → application BigQuery Ingestion → cocher
  ads_read → générer, puis copier la valeur dans META_ACCESS_TOKEN.
MSG
    ;;
esac
