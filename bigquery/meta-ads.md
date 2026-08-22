# Ingestion Meta Ads — comment ça marche

Ce document explique la **mécanique**. Pour brancher, renouveler ou dépanner,
voir [`README.md` §4](README.md) — le mode opératoire y est, et il n'est pas
répété ici.

---

## Pourquoi un script plutôt qu'un connecteur

Google fournit deux tuyaux vers BigQuery : l'export natif de GA4 et le Data
Transfer Service pour Ads. Meta n'en fournit aucun. Les connecteurs du marché
(Fivetran, Airbyte Cloud, Windsor) facturent au mois plus que le budget média
des premières campagnes, et pour un besoin qui tient en un appel d'API.

`scripts/ingest-meta-ads.mjs` fait donc le strict nécessaire, **sans aucune
dépendance** — comme le reste de `scripts/`. Il s'authentifie auprès de Google
en signant lui-même son JWT, ce qui lui permet de tourner dans un conteneur qui
n'a ni `npm install` ni le SDK Google.

---

## La chaîne d'authentification

C'est la partie qui a coûté le plus de temps, parce que **quatre objets
différents portent tous le nom de « token »**. Ils ne sont ni
interchangeables ni obtenus au même endroit.

```
  ┌─ 1. Jeton d'administrateur ──────────── toi, ~1 h ──────────────┐
  │    scope business_management                                     │
  │    Obtenu en te connectant (explorateur d'API ou dialogue OAuth). │
  │    Prouve que tu es admin du portefeuille. Ne lit aucune donnée.  │
  └───────────────────────────┬───────────────────────────────────────┘
                              │ sert une seule fois, à :
                              ▼
  ┌─ 2. Installation de l'app ───────────── une fois pour toutes ────┐
  │    POST /<utilisateur système>/applications                       │
  │    Autorise l'utilisateur système à frapper des jetons pour l'app.│
  │    Fait le 22/08/2026. Ne se refait jamais.                       │
  └───────────────────────────┬───────────────────────────────────────┘
                              │ débloque :
                              ▼
  ┌─ 3. Jeton d'ingestion ───────────────── celui du script ─────────┐
  │    scope ads_read — c'est META_ACCESS_TOKEN dans .env             │
  │    Deux variantes, cf. README §4a et §4b :                        │
  │      a. jeton d'utilisateur système — permanent                   │
  │      b. jeton utilisateur échangé    — 60 jours  ← en place       │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ 4. appsecret_proof ─────────────────── calculé, jamais stocké ──┐
  │    HMAC-SHA256 du jeton, clé = la clé secrète de l'app.           │
  │    Exigé par Meta sur les appels sensibles : prouve que l'appel   │
  │    vient de l'app, et pas de quelqu'un qui aurait seulement       │
  │    intercepté le jeton.                                           │
  └───────────────────────────────────────────────────────────────────┘
```

**L'étape 2 est le nœud de toute l'affaire.** Le Business Manager ne propose
nulle part d'installer une application pour un utilisateur système : il suppose
que c'est déjà fait, et son écran « Générer un token » répond « Aucune
autorisation disponible » sans jamais expliquer pourquoi. Seul l'appel API
réalise l'installation. Une fois passée, l'interface fonctionne normalement.

### Côté Google

| Contexte | Méthode | Pourquoi |
|---|---|---|
| Exécution à la main | identifiants locaux `gcloud` | Rien à faire circuler |
| Exécution planifiée | compte de service, via `GOOGLE_APPLICATION_CREDENTIALS` | Ne redemande jamais rien |

Le chemin `gcloud` bute périodiquement sur une **ré-authentification** : Google
la réclame pour les accès sensibles, et elle ne peut pas s'obtenir depuis un
terminal non interactif. Le message est explicite (« cannot prompt during
non-interactive execution ») et se règle par `gcloud auth
application-default login`. C'est précisément pour ne jamais le rencontrer en
production que la tâche planifiée doit utiliser un compte de service.

---

## Ce que fait une exécution

```
  API Meta  ──▶  conversion  ──▶  table tampon  ──▶  transaction  ──▶  table cible
   Insights      en NDJSON       WRITE_TRUNCATE     DELETE+INSERT    ad_insights_daily
                                                          │
                                                          ▼
                                                  ops.ingestion_runs
```

1. **Lecture** — `GET /act_<compte>/insights`, au niveau `ad`, avec
   `time_increment=1`. Ce paramètre est ce qui sépare un entrepôt d'une capture
   d'écran : sans lui, l'API renvoie un total unique pour toute la période.
   La pagination se fait par curseur, 500 lignes par page, avec un garde-fou à
   200 pages — une pagination qui ne s'arrête pas est un bug de l'API, pas une
   grosse journée, et mieux vaut échouer que boucler toute la nuit.

2. **Conversion** — chaque ligne est mise à plat, sauf `actions` et
   `action_values` qui restent des tableaux imbriqués. La dépense est **gardée
   en chaîne** jusqu'à BigQuery : la colonne est `NUMERIC`, et un passage par
   `Number` réintroduirait l'arrondi binaire que ce type sert justement à
   éviter.

3. **Chargement** — envoi en NDJSON multipart vers une **table tampon**, en
   `WRITE_TRUNCATE`, avec un **schéma déclaré en dur**. Pas d'`autodetect` :
   l'auto-détection lit les premières lignes du fichier, et une journée sans
   conversion produirait un `actions` vide, donc une colonne absente, donc un
   schéma qui change d'un jour à l'autre — et toutes les vues en aval
   tomberaient.

4. **Bascule** — `BEGIN TRANSACTION; DELETE` de la fenêtre `; INSERT` depuis le
   tampon `; COMMIT`. Sans transaction, un incident entre les deux laisserait un
   **trou** de 28 jours dans l'entrepôt. Un trou est bien pire qu'un doublon :
   il se lit comme une chute de performance, et on cherche la cause du côté des
   campagnes.

5. **Journalisation** — une ligne dans `ops.ingestion_runs`, succès comme échec,
   avec la fenêtre couverte, le nombre de lignes et le message d'erreur.

---

## Fenêtre glissante, et pourquoi on remplace

Par défaut le script recharge **les 28 derniers jours, jusqu'à hier**.

- **28 jours**, parce que Meta réattribue ses conversions jusqu'à 28 jours en
  arrière : les chiffres d'hier ne sont pas définitifs. Une fenêtre plus courte
  figerait des valeurs qui bougent encore.
- **Jusqu'à hier, jamais aujourd'hui**, parce qu'une journée en cours est
  incomplète, et l'écrire dans l'entrepôt revient à publier un chiffre qu'on
  sait faux.
- **On remplace, on n'ajoute pas.** Un chargement en ajout produirait à la fois
  des doublons et des chiffres périmés — et personne ne s'en apercevrait avant
  de comparer avec le gestionnaire de publicités.

Conséquence pratique : **rejouer deux fois la même journée est sans effet.**
C'est voulu, et c'est ce qui rend le script sûr à relancer après un incident.

Zéro ligne n'est pas une erreur : un compte à l'arrêt ne dépense rien. La
fenêtre est quand même remplacée, sans quoi une campagne stoppée garderait
indéfiniment sa dernière dépense dans l'entrepôt.

---

## Le rapprochement avec GA4 tient à un seul paramètre

`utm_id={{campaign.id}}`, exigé par le [plan de taggage](../specs/plan-taggage-conversions.md)
§10.1, est **la seule** chose qui relie une dépense Meta à une session GA4.

Sans lui, GA4 ne connaît de la campagne que son nom — qui change au premier
renommage — et la dépense se retrouve à côté de sessions qu'on ne sait plus lui
rattacher. Aucun traitement en aval ne peut rattraper ça. C'est à mettre au
moment de créer les annonces, pas après.

---

## Où ça se voit quand ça casse

```sql
SELECT started_at, status, window_start, window_end, rows_loaded, error_message
  FROM `estimer-505209.ops.ingestion_runs`
 WHERE source = 'meta_ads'
 ORDER BY started_at DESC
 LIMIT 10;
```

`marts.v_data_freshness` répond à la question d'à côté, et plus utile au
quotidien : distinguer « rien ne s'est passé » de « rien n'est arrivé ».

| Symptôme | Cause probable |
|---|---|
| `Error validating access token` | Jeton expiré ou invalidé par un changement de mot de passe → README §4 |
| `Unsupported request - method type: post` | Mauvais nœud : un profil personnel homonyme de l'utilisateur système → README §4, étape 2 |
| `(#100) Tried accessing nonexisting field` | Champ retiré par une montée de version de l'API |
| `Unsupported get request` | Version d'API retirée — monter `META_API_VERSION`, pas le code |
| `cannot prompt during non-interactive execution` | Ré-authentification Google → compte de service |
| `success` mais `rows_loaded = 0` | Aucune dépense sur la fenêtre. Pas une panne |

Meta retire ses versions d'API au bout d'environ deux ans. Le jour où le script
répond « Unsupported get request », c'est `META_API_VERSION` qu'il faut monter.

---

## En aval

`raw_meta_ads.ad_insights_daily` est du brut, au niveau de l'annonce : personne
ne le lit hors mise au point. Le chemin est le même que pour les autres
sources :

```
raw_meta_ads.ad_insights_daily
        ▼  staging.stg_meta_ads__campaign_daily      agrège au niveau campagne
        ▼  staging.stg_ads__spend_daily              unifie Google et Meta
        ▼  marts.fct_marketing_performance_daily     coût, sessions, leads, CPL
```

Tout se lit dans `marts`. Interroger `staging` ou `raw_*` dans un rapport, c'est
recréer une règle métier ailleurs — et se garantir deux chiffres divergents.
