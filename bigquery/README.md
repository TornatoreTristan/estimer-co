# Entrepôt BigQuery — mode opératoire

Croiser GA4, Google Ads et Meta Ads dans un seul endroit, pour répondre sans
discussion à « combien nous coûte un lead, et lequel ». Le
[plan de taggage](../specs/plan-taggage-conversions.md) reste la source de
vérité de **ce qui est mesuré** ; ce dossier ne traite que de **ce qui est
stocké et croisé**.

| Fichier | Rôle |
|---|---|
| `bigquery/sql/**` | **Source de vérité de l'entrepôt.** C'est là qu'on modifie |
| `scripts/deploy-bigquery.mjs` | Applique `sql/` au projet (`npm run bq:deploy`) |
| `scripts/ingest-meta-ads.mjs` | Ingestion Meta, seule source sans connecteur natif (`npm run bq:meta`) |
| [`meta-ads.md`](meta-ads.md) | **Comment marche cette ingestion** — jetons, fenêtre glissante, pannes |

> **Ne pas créer de vue à la souris.** Même raison que pour le conteneur GTM
> (`gtm/README.md`) : une vue écrite dans la console n'est ni relisible en
> revue, ni comparable d'une version à l'autre, ni reconstructible. Tout passe
> par `sql/` puis par `npm run bq:deploy`, qui est idempotent.

---

## 1. Ce qui est en place

**Projet GCP** `estimer-505209` — **localisation `EU`, sans exception.**
BigQuery ne joint pas deux datasets de régions différentes. Un export GA4 créé
par mégarde en `US` ne serait pas « à déplacer plus tard » : il serait à
refaire, et l'historique déjà exporté serait perdu.

```
  GA4 (G-B066RRFQL5)          Google Ads (AW-18402972391)        Meta Ads
        │ export natif               │ Data Transfer Service          │ scripts/ingest-meta-ads.mjs
        ▼                            ▼                               ▼
  analytics_<propertyId>        raw_google_ads                  raw_meta_ads
        └────────────────────────────┴───────────────┬───────────────┘
                                                     ▼
                                  staging   normalisation, une vue par source
                                                     ▼
                                  marts     ← LE SEUL DATASET À LIRE
                                                     ▼
                                Looker Studio, analyses, exports
```

| Dataset | Contenu | Qui lit |
|---|---|---|
| `raw_google_ads` | Tables du transfert Google Ads, telles quelles | Personne, hors mise au point |
| `raw_meta_ads` | `ad_insights_daily`, niveau annonce, pas quotidien | idem |
| `raw_app` | Réservé au lot T5 (leads applicatifs). **Vide** | Accès restreint le jour venu |
| `staging` | Vues de normalisation + 2 fonctions de lecture des paramètres GA4 | Les modèles `marts` |
| `marts` | Modèles métier | **Tout le monde** |
| `ops` | `ingestion_runs` — journal de nos ingestions | Supervision |

La séparation n'est pas décorative : elle décide de qui a le droit de lire quoi.
`raw_app` portera un jour des coordonnées de prospects et ne doit jamais suivre
le même chemin d'accès que `marts`.

### État au 22/08/2026

| Source | État | Conséquence |
|---|---|---|
| Google Ads | ✅ transfert actif en `europe`, compte **Estimer Mon Bien** (`3838716042`, EUR, balisage automatique activé) | Le modèle tourne. **Zéro ligne** : aucune campagne n'existe encore dans le compte |
| Meta Ads | ✅ ingestion en service, compte **Revontuli - Marketing** (`act_298109181477918`, EUR) | Tourne. **Zéro ligne** : aucune dépense sur la fenêtre. ⚠️ Jeton à renouveler avant le **21/10/2026** (§4) |
| GA4 | ❌ **dataset absent** | 8 modèles sur 16 non déployés, dont tous les `marts` de conversion (§2) |

Les 16 modèles ont été validés à l'exécution contre un jeu de données factice
(GA4, Ads et Meta), puis ce jeu a été purgé ; les modèles Google Ads ont ensuite
été revalidés sur le transfert réel.

> **Le schéma réel du transfert Google Ads diffère de la documentation.** Trois
> écarts constatés sur le compte 383-871-6042, et corrigés :
> `_DATA_DATE` n'existe pas (partitionnement par temps d'ingestion, donc
> `_PARTITIONDATE`) ; `campaign_start_date_time` est un `DATETIME` malgré son
> suffixe ; `metrics_all_conversions` n'existe sur aucune table de campagne.
> Le rattrapage de 30 jours s'étale sur environ 18 h, une exécution par jour
> espacée de 35 minutes.

---

## 2. Brancher l'export GA4 — **à faire en premier**

C'est la source qui porte les conversions, le tunnel et l'attribution. Sans
elle, l'entrepôt n'a rien à croiser.

> ⏳ **L'export ne rattrape pas le passé.** Il commence le jour où le lien est
> créé. Chaque jour d'attente est un jour définitivement absent de l'entrepôt —
> c'est la seule étape de ce document qui ait un coût à différer.

1. GA4 → *Admin* → *Liens BigQuery* → **Associer**.
2. Projet : `estimer-505209`.
3. **Emplacement des données : `EU`.** Voir §1.
4. Flux : le flux Web estimer.co. **Ne pas** filtrer d'événement : le filtrage
   se fait dans `staging`, où il est relisible et réversible.
5. Fréquence : **quotidien uniquement**. Le streaming est facturé à
   l'événement et n'apporte rien ici — aucune décision de ce projet ne se prend
   à l'heure près.
6. Vérifier le lendemain qu'un dataset `analytics_<propertyId>` est apparu.

Puis :

```bash
npm run bq:deploy
```

Le script détecte le dataset tout seul et déploie les 8 modèles restants.

---

## 3. Brancher le transfert Google Ads

Compte Ads **383-871-6042**, soit `3838716042` sans les tirets. À ne pas
confondre avec `AW-18402972391`, qui est l'identifiant de *conversion* et n'a
rien à voir.

```bash
bash bigquery/create-ads-transfer.sh
```

**À lancer depuis un vrai terminal.** Le script affiche une URL de consentement
OAuth et attend un `version_info` collé en retour : il échoue immédiatement si
son entrée standard n'est pas un terminal. Le premier chargement remonte
30 jours et prend quelques heures.

Le paramétrage tient dans le script plutôt que dans cette page : collée à la
main, la commande `bq mk --transfer_config` dépasse la largeur d'un terminal, et
le retour à la ligne la coupe en deux — le shell exécute alors `--params=…`
comme s'il s'agissait d'une commande.

`refresh_window_days: 30` n'est pas un réglage de confort : Google réattribue
ses conversions pendant 30 jours. Une fenêtre plus courte figerait des chiffres
qui bougent encore, et les rapports d'aujourd'hui ne correspondraient plus à
ceux de la semaine prochaine sans qu'on sache pourquoi.

Puis `npm run bq:deploy` : le script détecte les tables `p_ads_*`, remplace le
bouchon par le vrai modèle et le dit en clair.

> ⚠️ **Le vrai modèle n'a jamais tourné sur des données réelles.** Les noms de
> colonnes du Data Transfer Service (`metrics_cost_micros`,
> `campaign_advertising_channel_type`…) sont ceux de la documentation Google. Si
> l'un d'eux diffère, `npm run bq:deploy` échouera bruyamment sur ce modèle et
> sur lui seul — c'est le bon mode d'échec, mais il faut s'attendre à
> possiblement corriger un nom au premier passage.

---

## 4. Brancher Meta Ads

Meta ne fournit **aucun** connecteur vers BigQuery. Les connecteurs du marché
(Fivetran, Airbyte Cloud, Windsor) coûtent plus cher par mois que le budget
média des premières campagnes ; d'où `scripts/ingest-meta-ads.mjs`, qui fait le
strict nécessaire en une centaine de lignes utiles. Sa mécanique — la chaîne des
quatre jetons, la fenêtre glissante, les modes d'échec — est décrite dans
[`meta-ads.md`](meta-ads.md) ; cette section-ci ne dit que ce qu'il y a à faire.

1. Créer une **application** Meta (cas d'utilisation « Créer et gérer des
   publicités avec l'API Marketing »), la rattacher au portefeuille business
   depuis *Paramètres d'entreprise → Comptes → Applications → Ajouter*.
   Ne pas la publier : la revue Meta ne sert qu'à accéder aux données d'autres
   entreprises.
2. Créer un **utilisateur système** (*Utilisateurs → Utilisateurs système*),
   rôle *Employé*, et lui affecter le compte publicitaire en
   « Afficher les performances ». Un utilisateur système plutôt qu'un compte
   personnel : son jeton n'expire pas et survit à un départ.

   > En place : app `1773273583881445`, utilisateur système
   > `122098996725450566`, portefeuille **Revontuli** `2277414275805484`,
   > compte publicitaire `act_298109181477918` déjà affecté.
   >
   > **Ne pas deviner l'identifiant de l'utilisateur système.** Un profil
   > Facebook ordinaire peut porter exactement le même nom — c'est le cas ici,
   > `61593516995800` s'appelle aussi « BigQuery ingestion » — et l'API répond
   > alors `Unsupported request - method type: post`, sans jamais indiquer
   > qu'on s'adresse au mauvais type de nœud. Le bon identifiant se lit avec
   > `GET /<portefeuille>/system_users?fields=id,name` ; il fait 18 chiffres,
   > là où un profil personnel en fait 14.
3. Générer le jeton :

```bash
bash bigquery/create-meta-token.sh
```

> **L'interface ne sait pas faire cette étape.** L'écran « Générer un token »
> répond invariablement « Aucune autorisation disponible » tant que
> l'utilisateur système n'a pas **installé** l'application — et « installer »
> n'est pas « affecter comme élément professionnel ». Le Business Manager ne
> propose nulle part l'installation : il la suppose déjà faite. Seul l'appel
> API la réalise, et c'est ce que fait le script. Deux heures perdues à
> chercher le bon interrupteur avant de s'en apercevoir ; l'en-tête du script
> détaille les deux valeurs à récupérer au préalable.
>
> **Installation faite le 22/08/2026** (`{"success":true}`) : elle est acquise
> une fois pour toutes, il n'y a pas à la refaire.

Le script s'arrête là où l'API refuse d'aller. Sa seconde étape, la frappe du
jeton (`POST /<utilisateur système>/access_tokens`), n'accepte qu'un jeton
d'utilisateur système **administrateur** : un jeton personnel, même
administrateur du portefeuille, se voit répondre `Unsupported request - method
type: post`. Ce message ne dit pas ce qu'il veut dire, et il est identique à
celui qu'on obtient en visant le mauvais nœud.

**Deux façons d'obtenir le jeton**, selon ce qui est accessible :

*a. L'interface — le jeton permanent, à privilégier.* Une fois l'app installée,
l'écran fonctionne :

```
https://business.facebook.com/settings/system-users/122098996725450566?business_id=2277414275805484
```

« Générer un nouveau token » → application *BigQuery Ingestion* → cocher
`ads_read`. Meta exige une vérification d'identité par SMS à ce moment-là. Si
le SMS n'arrive pas — courant en France — les **codes de récupération**
(`accountscenter.facebook.com` → sécurité → authentification à deux facteurs)
la remplacent.

*b. L'échange, quand la vérification bloque.* Un jeton utilisateur court peut
être échangé contre un jeton de 60 jours, sans aucune vérification :

```bash
curl -sS -G "https://graph.facebook.com/v23.0/oauth/access_token" \
  --data-urlencode "grant_type=fb_exchange_token" \
  --data-urlencode "client_id=1773273583881445" \
  --data-urlencode "client_secret=$META_APP_SECRET" \
  --data-urlencode "fb_exchange_token=$META_ADMIN_TOKEN"
```

> ⏳ **C'est la solution en place aujourd'hui, et elle a une date de péremption.**
> Le jeton courant expire le **21/10/2026** ; l'ingestion s'arrêtera ce jour-là,
> et `ops.ingestion_runs` le dira en `failure`. Un jeton utilisateur meurt aussi
> au changement de mot de passe. Basculer sur le chemin *a* dès que la
> vérification passe est la seule façon d'en finir.

4. Exécuter :

```bash
export META_ACCESS_TOKEN="EAAx..."
export META_AD_ACCOUNT_ID="1234567890"     # avec ou sans le préfixe act_

npm run bq:meta -- --dry-run   # appelle Meta, n'écrit rien : à faire une fois
npm run bq:meta                # charge les 28 derniers jours
```

Puis planifier une exécution **quotidienne** (cron Coolify, comme les autres
services du projet, ou Cloud Scheduler). En production, préférer un compte de
service via `GOOGLE_APPLICATION_CREDENTIALS` plutôt que les identifiants
`gcloud` locaux.

Rattrapage sur une période précise :

```bash
npm run bq:meta -- --since=2026-03-01 --until=2026-03-31
```

**Chaque exécution remplace la fenêtre qu'elle couvre**, elle n'ajoute pas.
Meta réattribue ses conversions jusqu'à 28 jours en arrière : un chargement en
ajout produirait à la fois des doublons et des chiffres périmés. Rejouer deux
fois la même journée est donc sans effet — c'est voulu.

### La convention UTM n'est pas facultative

Le rapprochement Meta ↔ GA4 repose **entièrement** sur
`utm_id={{campaign.id}}`, exigé par le plan de taggage §10.1. Sans lui, GA4 ne
connaît de la campagne que son nom, qui change au premier renommage — et la
dépense Meta se retrouve à côté de sessions qu'on ne sait plus lui rattacher.
C'est la seule chose à ne pas oublier au moment de créer les annonces.

---

## 5. Déployer

```bash
npm run bq:deploy              # crée les datasets manquants, applique tous les modèles
npm run bq:deploy -- --dry-run # affiche le SQL résolu, n'exécute rien
npm run bq:deploy -- --only=marts
```

Idempotent : rejouable autant qu'on veut. Les tables sont en
`CREATE ... IF NOT EXISTS`, les vues et fonctions en `CREATE OR REPLACE` —
aucune instruction de `sql/` ne détruit de données.

Le script ne cache pas ce qu'il ne peut pas faire : il annonce chaque source
absente, chaque bouchon déployé, et supprime les vues qui deviendraient
orphelines si une source était débranchée.

---

## 6. Ce qu'on lit, et où

Tout se lit dans `marts`. Interroger `staging` ou `raw_*` dans un rapport, c'est
recréer une règle métier ailleurs — et se garantir deux chiffres divergents.

| Modèle | Grain | À quoi il répond |
|---|---|---|
| `fct_marketing_performance_daily` | jour × plateforme × campagne | **La table de pilotage.** Coût, sessions, leads, CPL, tunnel, tout au même endroit |
| `fct_leads` | un lead | Qui a converti, avec quelle qualification, depuis quelle campagne |
| `fct_estimation_funnel_daily` | jour × plateforme × étape | Où le tunnel perd les visiteurs, et sur quels champs |
| `dim_campaign` | campagne | Référentiel, dont le respect de la convention de nommage §10.2 |
| `v_platform_reconciliation` | jour × plateforme | Les régies et GA4 se contredisent-ils anormalement ? |
| `staging.stg_google_ads__conversion_action_daily` | jour × campagne × action | Le détail par action de conversion, qui rend la comparaison ci-dessus honnête |
| `v_data_freshness` | source | **À lire en premier.** Distingue « rien ne s'est passé » de « rien n'est arrivé » |

Trois précautions valables pour toute lecture :

- **Les jours récents bougent.** Google réattribue 30 jours, Meta 28. Un chiffre
  de J-1 n'est pas comparable à ce qu'on lira dans une semaine.
- **Régies et GA4 ne compteront jamais pareil**, et ce n'est pas un défaut :
  fenêtres et modèles d'attribution différents, plus la modélisation du
  consentement côté Google que GA4 ne montre pas. `v_platform_reconciliation`
  sert à mesurer l'écart, pas à le corriger. L'expliquer une fois vaut mieux que
  de l'expliquer tous les mois.
- **`lead_value` n'est pas un chiffre d'affaires.** C'est la valeur envoyée aux
  enchères (plan §5.2), calculée avec `VALEUR_BASE_LEAD = 100` par défaut. Elle
  n'a de sens qu'en relatif, pour comparer deux campagnes. L'afficher comme un
  revenu serait un mensonge par cadrage.

### Looker Studio

Se connecter en **BigQuery → Requête personnalisée**, sur `marts` uniquement, et
lire les tableaux depuis `fct_marketing_performance_daily`. Donner le rôle
*BigQuery Data Viewer* sur le seul dataset `marts` — jamais au niveau du projet,
qui donnerait accès à `raw_*` par la même occasion.

---

## 7. Coûts

Le volume attendu (un site vitrine, quelques milliers de sessions par mois) tient
très largement dans le palier gratuit : 10 Go de stockage et 1 To de requêtes
par mois.

Deux points de vigilance quand même, parce qu'ils ne se voient qu'à la facture :

- **Tous les `marts` sont des vues**, recalculées à chaque lecture depuis
  l'export GA4 complet. Tant que l'historique est court, c'est le bon choix :
  toujours frais, rien à ordonnancer. Le jour où une lecture scanne plus de
  quelques gigaoctets, basculer `fct_marketing_performance_daily` en table
  matérialisée quotidienne — et pas avant, l'ordonnancement a son propre coût
  d'entretien.
- **Ne pas activer l'export GA4 en streaming** (§2.5). Il est facturé à
  l'événement, et aucune décision de ce projet ne se prend à l'heure près.

---

## 8. Ce qui reste à faire

| # | Action | Qui | Bloquant pour |
|---|---|---|---|
| 1 | Créer le lien BigQuery dans GA4 (§2) | Admin GA4 | **Tout.** Et chaque jour d'attente est perdu |
| 2 | ~~Créer le transfert Google Ads~~ ✅ fait le 22/08/2026 | — | — |
| 3 | ~~Créer l'utilisateur système Meta et son jeton~~ ✅ fait le 22/08/2026, par échange (§4b) | — | — |
| 3 bis | **Remplacer le jeton d'échange par le jeton permanent (§4a), avant le 21/10/2026** | Admin Meta Business | La dépense Meta, à cette date |
| 4 | Planifier `npm run bq:meta` en quotidien, avec un compte de service | Coolify / Cloud Scheduler | La fraîcheur Meta |
| 5 | Arbitrer `VALEUR_BASE_LEAD` (plan §5.2, §13.1) | Métier | Les enchères à la valeur |
| 6 | Ouvrir `marts` en lecture aux personnes concernées | Admin GCP | Les rapports partagés |

Le lot **T5** du plan de taggage (import des conversions hors ligne) trouvera
sa place dans `raw_app`, déjà créé et vide. Il suppose deux choses qui n'existent
pas encore : la persistance des leads côté API — il n'y a aujourd'hui **aucune
table `leads`**, les données traversent le processus et partent par e-mail — et
un outil de suivi commercial capable de rattacher un lead à un mandat signé.
Sans eux, l'import hors ligne n'a aucune matière.
