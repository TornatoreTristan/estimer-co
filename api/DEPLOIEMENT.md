# Déploiement de l'API d'estimation sur Coolify

Marche à suivre complète pour mettre `api.estimer.co` en ligne.
Référence fonctionnelle : `../specs/estimation-donnees-reelles.md` (§2.2, §2.5, §2.6, §6.4).

> **Ne commitez jamais les valeurs réelles.** Toutes les variables sensibles se
> saisissent dans l'interface Coolify, qui les stocke chiffrées.

---

## 1. Service base de données — `estimer-db`

**Coolify → Project → + New → Database → PostgreSQL.**

Point critique : **remplacer l'image par défaut par `postgis/postgis:16-3.4`.**
Une image `postgres` nue n'a pas l'extension PostGIS, et `CREATE EXTENSION postgis`
échouera à la première migration. C'est le risque n° 1 identifié au cadrage.

| Réglage | Valeur |
|---|---|
| Image | `postgis/postgis:16-3.4` |
| Database | `estimer` |
| Username | `estimer` |
| Password | généré, gardé dans Coolify (voir §3) |
| Port public | **aucun** — la base ne doit jamais être joignable depuis Internet |
| Volume persistant | oui, 20 Go (≈ 4 Go de données + marge staging, vues, WAL) |
| Sauvegarde | quotidienne, rétention 14 jours |

Options PostgreSQL recommandées (l'ingestion DVF fait des `COPY` volumineux) :

```
-c shared_buffers=512MB -c work_mem=64MB -c maintenance_work_mem=512MB
```

**Testez une restauration de sauvegarde avant de passer en production.** Une
sauvegarde jamais restaurée n'est pas une sauvegarde.

---

## 2. Service application — `estimer-api`

**Coolify → + New → Application → Private Repository (GitHub App).**

| Réglage | Valeur |
|---|---|
| Repository | `TornatoreTristan/estimer-co` |
| Branch | `main` (après fusion de la PR) |
| Build Pack | **Dockerfile** |
| Base Directory | `/api` |
| Dockerfile Location | `/api/Dockerfile` |
| Port Exposes | `3333` |
| Domain | `https://api.estimer.co` |
| HTTPS / Let's Encrypt | activé |
| Health Check Path | `/health` |

**Watch Paths : `api/**`** — sans ça, chaque modification du site statique
redéploierait l'API pour rien.

Le `Dockerfile` gère déjà le reste : build multi-stage, utilisateur non
privilégié, `dumb-init` pour drainer proprement les connexions à l'arrêt, et une
sonde `HEALTHCHECK` toutes les 30 s.

### DNS

Un enregistrement `A` (ou `CNAME`) `api.estimer.co` vers l'IP du serveur
Coolify, **avant** de lancer le déploiement — Let's Encrypt échoue sinon.

---

## 3. Variables d'environnement

À saisir dans **Environment Variables** du service `estimer-api`.

### Secrets — à générer, à ne jamais réutiliser d'un environnement à l'autre

```bash
# APP_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# IP_HASH_SALT — sel du HMAC appliqué aux IP dans estimations_log (§8.3)
openssl rand -hex 32
```

| Variable | Valeur |
|---|---|
| `APP_KEY` | *(généré ci-dessus)* |
| `IP_HASH_SALT` | *(généré ci-dessus)* |

> Changer `IP_HASH_SALT` plus tard rend les anciens hachages incomparables aux
> nouveaux. Ce n'est pas grave pour la conformité, mais la détection d'abus
> repart de zéro. Fixez-le une fois.

### Base de données

Coolify expose les identifiants du service PostgreSQL ; utilisez le **nom de
service interne** comme hôte, jamais une IP publique.

```
DB_HOST=<nom-du-service-postgres-dans-coolify>
DB_PORT=5432
DB_USER=estimer
DB_PASSWORD=<mot de passe du service base>
DB_DATABASE=estimer
```

Les deux services doivent être **dans le même projet Coolify** pour se voir sur
le réseau Docker interne.

### Application

```
NODE_ENV=production
PORT=3333
HOST=0.0.0.0
LOG_LEVEL=info
```

### CORS — §2.5

```
CORS_ORIGINS=https://estimer.co,https://www.estimer.co
```

Ajoutez `http://localhost:4322` seulement si vous voulez attaquer l'API de
production depuis votre poste. Le port 4322 est figé dans `astro.config.mjs`.

### Confiance proxy — §2.6, **à ne pas négliger**

```
TRUSTED_PROXY=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1/32
```

`X-Forwarded-For` n'est lu que si la connexion provient d'une de ces plages.

- **Laissé vide** : l'API voit l'IP du proxy pour tous les clients → le quota de
  10 requêtes/minute devient **global**, un seul visiteur actif bloque le site.
- **Trop large** (`0.0.0.0/0`) : n'importe qui forge son IP et contourne tous
  les quotas.

Vérifiez la plage réelle de votre réseau Docker Coolify :
`docker network inspect coolify | grep Subnet`. L'API journalise un
avertissement au démarrage si la variable est vide en production.

### Sources de données

```
BAN_API_URL=https://api-adresse.data.gouv.fr
DVF_BASE_URL=https://files.data.gouv.fr/geo-dvf/latest/csv
ADEME_API_URL=https://data.ademe.fr/data-fair/api/v1/datasets
COG_COMMUNES_URL=https://www.insee.fr/fr/statistiques/fichier/8377162/v_commune_2025.csv
```

`COG_COMMUNES_URL` porte un millésime : à réactualiser chaque année.

### Cache et quotas

```
ESTIMATION_CACHE_TTL=86400
GEOCODE_CACHE_TTL_DAYS=90
LIMITER_STORE=database
RATE_LIMIT_ESTIMATION=10/1 minute
RATE_LIMIT_ESTIMATION_DAILY=60/1 day
RATE_LIMIT_GEOCODE=30/1 minute
RATE_LIMIT_MARCHE=60/1 minute
RATE_LIMIT_GLOBAL=120/1 minute
```

---

## 4. Premier déploiement

1. **Deploy** dans Coolify.
2. Vérifier la sonde :

   ```bash
   curl -s https://api.estimer.co/health
   # {"status":"ok","db":true,"hasMutations":false,...}
   ```

   `hasMutations: false` est normal : la base est vide.

3. **Migrations** — terminal du conteneur `estimer-api` (Coolify → Terminal) :

   ```bash
   node ace migration:run --force
   ```

   `--force` est requis en production. La première migration crée les extensions
   `postgis`, `btree_gist`, `unaccent` et `pg_trgm`.

4. **Données de référence** (coefficients, références hors DVF) :

   ```bash
   node ace db:seed
   ```

---

## 5. Chargement des données — l'étape longue

### Référentiel communal, d'abord

```bash
node ace cog:import
```

≈ 35 000 communes, quelques minutes. **Indispensable avant l'ingestion DVF** :
c'est lui qui pose le drapeau `has_dvf = false` sur les départements 57, 67, 68
et 976 (régime du Livre foncier, absents de DVF).

### Validation sur un département, avant tout

```bash
node ace dvf:import --year=2025 --dep=23 --dry-run
node ace dvf:import --year=2025 --dep=23
```

La Creuse est petite et rapide. Contrôlez ensuite la vraisemblance — médiane
maison ≈ 900 €/m² : si vous obtenez 2 000 à 4 000 €/m², le dédoublonnage est en
cause, **n'allez pas plus loin**.

### France entière

```bash
node ace dvf:import --year=2025 --dep=all
```

Comptez **25 à 45 minutes** et 6 à 7 millions de lignes retenues. Lancez-le dans
un `screen`/`tmux` ou en tâche de fond : une déconnexion du terminal Coolify
interromprait la commande.

En cas d'interruption, l'import est reprenable :

```bash
node ace dvf:import --year=2025 --dep=all --resume=<runId>
```

Répétez pour les millésimes antérieurs si vous voulez la profondeur complète
(la cascade utilise jusqu'à 60 mois d'historique).

### Vérification finale

```bash
curl -s https://api.estimer.co/health
curl -s -X POST https://api.estimer.co/v1/estimations \
  -H 'Content-Type: application/json' -H 'Origin: https://estimer.co' \
  -d '{"address":"1 rue de Rivoli","postalCode":"75001","city":"Paris",
       "propertyType":"appartement","surface":65,"rooms":3,"dpe":"D"}'
```

---

## 6. Tâches planifiées

**Coolify → Scheduled Tasks**, sur le service `estimer-api` :

| Tâche | Commande | Fréquence |
|---|---|---|
| Purge RGPD | `node ace purge:logs` | quotidienne, 03:00 |
| Ingestion DVF | `node ace dvf:import --year=<année> --dep=all` | 15 avril et 15 octobre |
| Rafraîchissement des agrégats | `node ace refresh:aggregates` | hebdomadaire |

La purge n'est pas optionnelle : `geocode_cache` contient des adresses saisies
par les visiteurs, avec une rétention annoncée de 90 jours, et `estimations_log`
une rétention de 12 mois. Sans la tâche, ce qui figure au registre des
traitements est faux.

DVF est publié en **avril** et **octobre**, à quelques jours près. La commande
est idempotente : si le millésime n'est pas encore publié, elle ne fait rien.

---

## 7. Côté site statique — dernière étape

**GitHub → Settings → Secrets and variables → Actions → New repository secret :**

| Secret | Valeur |
|---|---|
| `PUBLIC_API_URL` | `https://api.estimer.co` |

**Tant que ce secret n'existe pas, le déploiement du site échoue volontairement.**
Sans lui, le front n'émettrait aucun appel réseau et servirait à 100 % des
visiteurs les prix de l'ancienne table de 35 villes, sans qu'aucun signal ne
parvienne à l'exploitation. Un repli doit être un incident visible, jamais un
état par défaut (Annexe B.5 de la spec).

`PUBLIC_ESTIMATION_FALLBACK` peut rester vide : la valeur par défaut est
`static`, conformément à la décision client (Annexe B.2).

---

## 8. Contrôles avant ouverture au public

- [ ] Restauration de sauvegarde testée
- [ ] `TRUSTED_PROXY` vérifié sur la vraie plage Docker — sinon le rate limiting
      est soit global, soit contournable
- [ ] `/health` répond `hasMutations: true`
- [ ] Une estimation en zone dense (Paris, Lyon) revient en moins d'une seconde
- [ ] Une estimation à Strasbourg affiche la mention Livre foncier et **aucune**
      revendication de source DVF
- [ ] Tâche de purge active
- [ ] Politique de confidentialité mise à jour : nouveau sous-traitant
      (hébergeur de l'API), nouvelle finalité (calcul d'estimation), appels à
      la BAN

**Non couvert par ce déploiement :** la justesse du moteur n'est pas encore
mesurée. Le back-test prévu au §8.4 (objectif : moins de 15 % d'erreur moyenne
en zone dense) reste à faire. **Ne communiquez aucun taux de fiabilité avant.**
