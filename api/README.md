# API d'estimation — `estimer-api`

Application **AdonisJS 6 + PostgreSQL 16/PostGIS**, indépendante du site Astro.
Contrat : [`specs/estimation-donnees-reelles.md`](../specs/estimation-donnees-reelles.md)
(**l'Annexe A fait foi** en cas de contradiction avec le corps du document).

Périmètre livré : **Lot 0 (socle) et Lot 1 (données)**.
Le Lot 2 (moteur de valorisation, `POST /v1/estimations`) n'est pas implémenté.

---

## Démarrage

```bash
cd api
npm ci
cp .env.example .env          # puis renseigner APP_KEY et IP_HASH_SALT
docker compose up -d db       # PostGIS 16-3.4, port 5433 sur la loopback
node ace migration:run
node ace serve --hmr
```

`GET http://localhost:3333/health` doit répondre `{"status":"ok","db":true,…}`.

### Tests

```bash
docker compose --profile test up -d db_test   # base éphémère (tmpfs), port 5434
npm test                                       # Japa : unitaires + fonctionnels
npm run lint && npm run typecheck
```

**Aucun test n'accède au réseau.** La BAN et le téléchargement DVF sont
bouchonnés ; `BAN_API_URL` et `DVF_BASE_URL` pointent en test sur une adresse
inatteignable, de sorte qu'un appel réel accidentel échoue bruyamment.

---

## Endpoints

| Route | Description |
|---|---|
| `GET /health` | Sonde Coolify. **Hors CORS, hors rate limiting** (§6.1). |
| `GET /v1/meta/data-version` | Millésime, couverture, mention légale. Fonctionne **base vide**. |
| `GET /v1/geocode?q=&postcode=&city=` | Proxy caché de la BAN. 30 req/min/IP. |

À venir au Lot 2 : `POST /v1/estimations`, `GET /v1/marche/:codeInsee`.
Les limiteurs correspondants sont **déjà définis** dans `start/limiter.ts`.

---

## Commandes d'ingestion

```bash
# Référentiel communal (34 875 communes, centroïdes, has_dvf)
node ace cog:import

# DVF — toujours commencer par une simulation
node ace dvf:import --year=2025 --dep=23 --dry-run
node ace dvf:import --year=2025 --dep=23
node ace dvf:import --year=2025 --dep=all

# Vue matérialisée de marché (appelée automatiquement en fin d'import)
node ace refresh:aggregates
```

Options de `dvf:import` : `--year=` (requis), `--dep=` (code, liste CSV ou
`all`), `--dry-run`, `--force`, `--source=`.

**Idempotence** : un fichier déjà ingéré (même ETag ou même sha256, **et sous
la même version de règles**) est ignoré ; `--force` rejoue l'upsert, qui laisse
le nombre de lignes strictement identique. Un *advisory lock* PostgreSQL
interdit deux imports simultanés.

`dvf:import` alimente **deux** tables : `mutations` (bâti) et
`mutations_terrain` (ventes de terrain nu, §5.1). Cette seconde table sert au
`propertyType: 'terrain'` et au calcul de `V_terrain` du §3.6 — sans elle, le
repli forfaitaire de 8 % est systématique.

`refresh:aggregates` n'alimente plus seulement l'endpoint marché : la **garde
de cohérence de marché** (Annexe A.10) y lit désormais ses médianes
communales. Une vue jamais rafraîchie neutralise donc cette garde en silence.
`dvf:import` l'appelle en fin d'exécution pour cette raison, et **échoue
bruyamment** si le rafraîchissement est impossible.

### Ré-import et lignes obsolètes (`stale_reimport`)

L'ingestion ne supprime jamais (A.7) et l'upsert ne réécrit que ce que les
règles **courantes** retiennent. Sans précaution, corriger une règle
d'ingestion laisse donc en base les lignes produites par l'**ancienne** :
ni réécrites, ni marquées, donc toujours comptées dans les médianes. Mesuré
sur la Creuse : 105 lignes, et jusqu'à **+149 %** sur une médiane communale.

Chaque import marque désormais, dans la même transaction que l'upsert, toute
ligne de son périmètre — **département × millésime** — que l'upsert n'a pas
touchée :

```sql
UPDATE mutations
   SET is_outlier = true, exclusion_reason = 'stale_reimport'
 WHERE code_departement = $1 AND source_annee = $2 AND imported_at < now()
   AND exclusion_reason IS DISTINCT FROM 'stale_reimport';
```

Le filtre `source_annee` n'est pas optionnel : sans lui, importer 2025
marquerait obsolètes toutes les mutations 2019-2024 du département. Un test
dédié le verrouille.

Le marquage est **auto-réparateur** : l'upsert écrasant `exclusion_reason`,
une ligne redevenue légitime perd sa marque au ré-import suivant. Rien n'est
jamais supprimé (A.2).

Le compteur `rows_stale_marked` est remonté dans le rapport de commande et
enregistré dans `dvf_imports` et `ingestion_runs`. **Un non-zéro sur un
ré-import de routine est un signal** : les règles ont changé, ou des mutations
ont disparu du fichier source. Pensez à `refresh:aggregates` derrière — sans
quoi `agg_commune_type` continue de porter les lignes marquées, et avec elle
la garde de cohérence de marché (A.10).

### `DVF_RULES_VERSION` — à incrémenter à chaque correctif de règle

Constante d'`app/dvf/importer.ts`, mémorisée dans `dvf_imports.rules_version`.
Un fichier n'est *skippé* que s'il a été ingéré avec la **même** version de
règles. Sans cela le correctif ci-dessus serait inopérant : le sha256 étant
inchangé, l'import serait ignoré et le marquage n'aurait jamais lieu — il
aurait fallu penser à `--force`, ce qui s'oublie.

**Corriger une règle d'ingestion sans incrémenter `DVF_RULES_VERSION`, c'est
livrer un correctif qui ne s'appliquera à personne.**

---

## Tâches planifiées

```bash
# Purge RGPD — journal d'estimations > 12 mois, cache de géocodage expiré
node ace purge:logs
node ace purge:logs --dry-run          # comptage seul, aucune suppression
node ace purge:logs --retention-months=6
```

`geocode_cache` contient des **adresses**, donc des données à caractère
personnel (§8.3) : les entrées expirées ne servent plus à rien
(`GeocodingService` les ignore déjà à la lecture) et ne doivent pas être
conservées. `estimations_log` a une rétention de 12 mois (§5.1).

**Cron à déclarer sur le conteneur de l'API (Coolify)** :

```cron
# Purge RGPD quotidienne — 03h15 UTC
15 3 * * *   cd /app && node ace purge:logs

# Vérification mensuelle du millésime DVF — 1er du mois, 04h00 UTC
0 4 1 * *    cd /app && node ace dvf:import --year=$(date -u +%Y) --dep=all
```

La purge est idempotente et ne prend aucun verrou : la rejouer ne supprime
rien de plus et n'interfère pas avec un import en cours.

---

## Points d'architecture à connaître avant de modifier

### 1. Le piège central de DVF

Dans le CSV, **une ligne = un lot, pas une vente**, et `valeur_fonciere` est
**répétée à l'identique** sur toutes les lignes d'une même mutation. La sommer
gonfle les prix d'un facteur 2 à 4 **sans qu'aucune erreur ne se déclenche**.

La règle appliquée est celle de l'**Annexe A.1** :

| Cas | Traitement |
|---|---|
| Locaux bâtis de **types différents** | mutation écartée (`multi_type`) |
| Plusieurs lots du **même type** | conservée, surfaces et pièces **sommées** |
| **Dépendances** (cave, garage, parking) | exclues de la surface, **sans rejet**, tracées par `nb_dependances` |
| `valeur_fonciere` | comptée **une seule fois** |

Contrôle de bon sens : sur la Creuse 2025, la médiane obtenue est de
**907 €/m² pour une maison**, conforme au marché réel du département. Une
médiane à 2 000-4 000 €/m² signalerait une régression sur ce point.

### 2. Aberrants : marqués, jamais supprimés

`is_outlier` + `exclusion_reason` (Annexe A.2). Tous les index du chemin chaud
sont **partiels sur `is_outlier = false`**. Un seuil mal choisi ne doit jamais
détruire de la donnée.

### 3. Terrains : lot homogène, lot mixte, vente non bâtissable

`mutations_terrain` ne retient que les ventes **sans aucun local** (§5.1), et
seules les parcelles en nature « sols » (`code_nature_culture` vide ou `S`)
relèvent du marché du terrain à bâtir — une terre agricole se vend 0,50 à
2 €/m², un terrain à bâtir 30 à 300 €/m².

Le piège est le **lot mixte**. Ne sommer que les parcelles « sols » tout en
gardant `valeur_fonciere`, qui couvre toute la vente, produit un numérateur
complet sur un dénominateur amputé :

```
800 m² 'S' + 20 000 m² 'T', vendus 120 000 €
  → surface_terrain = 800  ⇒  150,00 €/m²   (au lieu de 5,77 €/m²)
```

Dans les bornes, non marqué, donc **inclus dans la médiane** — celle qui sert
à `propertyType: 'terrain'` et à la valorisation du jardin du §3.6. Sur un
marché rural, le lot « terrain à bâtir + terres » est courant : le biais était
systématique et haussier.

| Vente | Traitement |
|---|---|
| Toutes parcelles en `'' \| 'S'` | conservée, `surface_terrain` = somme des parcelles |
| Parcelles **mixtes** | conservée mais marquée `terrain_mixte` ; `surface_terrain` somme **tout** |
| **Aucune** parcelle en `'' \| 'S'` | rejetée `nature_culture_non_retenue` |

Le dernier motif remplace un `surface_absente` trompeur : la surface est bien
là, c'est le périmètre de marché qui ne l'est pas. Le compteur de rejets de
terrain est désormais ventilé par motif (`terrainRejectedCounts`), sans quoi
la distinction ne se voyait nulle part.

### 4. Double implémentation verrouillée par un test

Les règles d'ingestion existent en deux exemplaires :

- `database/sql/dvf_transform.ts` — set-based, imposé par le volume (A.7) ;
- `app/dvf/normalize.ts` — module **pur**, imposé par la testabilité.

`tests/unit/dvf_sql_parity.spec.ts` fait tourner les deux sur le même jeu de
lignes et exige un résultat identique. **Toute modification d'une règle doit
être portée des deux côtés**, sinon la CI casse. Ce test a déjà détecté un
bug réel (un `?` de regex consommé par Knex comme marqueur de liaison).

### 5. `ST_DWithin`, jamais `ST_Distance`, dans le `WHERE`

Annexe A.6 : seul `ST_DWithin` est réécrit en prédicat de boîte englobante
exploitable par l'index GiST. `ST_Distance` dans le `WHERE` provoque un Seq
Scan sur plusieurs millions de lignes.

### 6. Résolution d'IP derrière proxy

`TRUSTED_PROXY` doit être renseigné en production. Trop restrictif : toutes
les requêtes partagent le quota du proxy. Trop large (`0.0.0.0/0`) : n'importe
qui forge `X-Forwarded-For` et contourne tous les quotas. Voir
`app/lib/client_ip.ts`.
