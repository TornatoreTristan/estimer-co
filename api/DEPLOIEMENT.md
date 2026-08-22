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
RATE_LIMIT_LEADS=5/1 minute
RATE_LIMIT_LEADS_DAILY=20/1 day
```

`RATE_LIMIT_LEADS` est volontairement bien plus serré que les autres : un abus
sur `POST /v1/leads` ne coûte pas du CPU, il **fait partir des e-mails depuis
notre domaine**. Ce qui se consomme là, c'est la réputation d'expéditeur — et
un domaine grillé chez les gros fournisseurs met des semaines à revenir,
pendant lesquelles plus aucun accusé de réception n'arrive chez personne. Cinq
envois par minute couvrent très largement un humain qui corrige et resoumet son
formulaire.

### E-mails transactionnels

Voir la section 4 ci-dessous : la mise en service demande une configuration
DNS chez le registrar en plus des variables Coolify.

---

## 4. E-mails transactionnels — Scaleway TEM

`POST /v1/leads` transmet par e-mail les demandes d'estimation et les messages
de contact. **Par défaut, rien ne part.** Tant que `MAIL_TRANSPORT` n'est pas
posé à `smtp`, l'API tourne en `dry-run` : le message est intégralement
construit, rendu et journalisé, mais aucune connexion SMTP n'est ouverte.

C'est délibéré, et cela a deux conséquences pratiques :

- un déploiement existant ne casse pas en montant cette version — il n'envoie
  simplement pas encore d'e-mail ;
- **le jour de la bascule, il faut penser à cette variable**, sinon le
  formulaire répondra 200 à tout le monde sans qu'un seul lead n'arrive. Le
  service journalise un avertissement au démarrage quand il tourne en `dry-run`
  en production, précisément pour que cet état ne passe pas inaperçu.

### 4.1 Prérequis Scaleway — le domaine d'abord

**Console Scaleway → Transactional Email → Domaines → Ajouter un domaine.**

Scaleway refuse tout envoi depuis un domaine non vérifié : ce n'est pas une
formalité administrative, c'est ce qui empêche n'importe qui d'écrire au nom de
`estimer.co`. Tant que la vérification n'est pas au vert, chaque envoi échoue —
et l'API répondra 502 `MAIL_UNAVAILABLE`.

La console affiche les enregistrements DNS à créer chez le registrar du
domaine. **Copiez les valeurs exactes qu'elle affiche** : elles contiennent une
clé publique et un identifiant propres à votre projet, et aucun exemple de
documentation ne peut s'y substituer.

| Enregistrement | Rôle | Ce qui casse s'il manque |
|---|---|---|
| TXT de vérification | prouve que le domaine vous appartient | le domaine reste « non vérifié », **aucun envoi possible** |
| **SPF** (TXT sur le domaine) | autorise les serveurs Scaleway à émettre pour `estimer.co` | les e-mails partent mais sont classés en spam, ou rejetés |
| **DKIM** (TXT sur `<sélecteur>._domainkey.estimer.co`) | signe cryptographiquement chaque message | même effet que SPF absent, en pire chez Gmail et Outlook |
| **DMARC** (TXT sur `_dmarc.estimer.co`) | dit aux destinataires quoi faire d'un message non authentifié | délivrabilité dégradée, et aucun retour sur les usurpations |
| MX | seulement si le domaine doit aussi *recevoir* | sans objet ici : la boîte interne est ailleurs (voir `MAIL_TO`) |

Si le domaine porte déjà un SPF (Google Workspace, un autre envoyeur…),
**fusionnez** les `include:` dans un enregistrement TXT unique. Deux
enregistrements SPF distincts sur le même domaine invalident les deux — c'est
l'erreur la plus fréquente de cette étape, et elle est silencieuse.

Pour DMARC, commencez en `p=none` (observation seule), vérifiez pendant
quelques jours que les rapports ne signalent rien d'anormal, puis durcissez
vers `p=quarantine`. Passer directement en `p=reject` sur un domaine dont on
n'a pas encore l'inventaire complet des envoyeurs revient à couper sa propre
messagerie.

La propagation DNS prend de quelques minutes à quelques heures. Relancez la
vérification depuis la console jusqu'au vert **avant** de basculer
`MAIL_TRANSPORT`.

### 4.2 Identifiants SMTP

**Console Scaleway → IAM → Clés API → Générer une clé API**, avec la permission
Transactional Email sur le projet concerné.

| Ce que demande l'API | Ce que fournit Scaleway |
|---|---|
| `SMTP_USERNAME` | l'**ID du projet** Scaleway (un UUID) — ni secret, ni personnel |
| `SMTP_PASSWORD` | la **clé API secrète**, affichée **une seule fois** à la création |

La clé secrète n'est jamais réaffichée : si elle est perdue, il faut en générer
une nouvelle et révoquer l'ancienne. Elle se saisit **uniquement** dans les
Environment Variables de Coolify, qui les stocke chiffrées — jamais dans un
fichier du dépôt, jamais dans un ticket, jamais dans une capture d'écran.

> L'API ne journalise jamais cette valeur. Le récapitulatif de configuration
> écrit au démarrage l'omet par construction (elle n'est pas masquée : elle est
> absente), et les erreurs de transport ne sont journalisées que par leur
> message, jamais par l'objet d'erreur — lequel embarque les options de
> connexion, mot de passe compris.

### 4.3 Variables Coolify

À saisir dans **Environment Variables** du service `estimer-api` :

```
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.tem.scw.cloud
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USERNAME=<ID du projet Scaleway>
SMTP_PASSWORD=<clé API secrète Scaleway>
MAIL_FROM_ADDRESS=contact@estimer.co
MAIL_FROM_NAME=Estimer mon bien
MAIL_REPLY_TO=contact@estimer.co
MAIL_TO=<boîte interne qui reçoit les leads>
MAIL_TIMEOUT=10000
MAIL_SEND_ACKNOWLEDGEMENT=true
```

| Variable | Rôle | Défaut si absente |
|---|---|---|
| `MAIL_TRANSPORT` | `smtp` (envoi réel) ou `dry-run` (aucune connexion SMTP) | `dry-run` |
| `SMTP_HOST` | endpoint SMTP Scaleway, identique dans toutes les régions | `smtp.tem.scw.cloud` |
| `SMTP_PORT` | voir la matrice ci-dessous | `587` |
| `SMTP_SECURE` | TLS implicite. `true` **obligatoire** sur 465 / 2465 | déduit du port |
| `SMTP_USERNAME` | ID du projet Scaleway | — *(requis si `smtp`)* |
| `SMTP_PASSWORD` | clé API secrète | — *(requis si `smtp`)* |
| `MAIL_FROM_ADDRESS` | expéditeur — **doit appartenir au domaine vérifié** | — *(requis si `smtp`)* |
| `MAIL_FROM_NAME` | nom d'affichage de l'expéditeur | `Estimer mon bien` |
| `MAIL_REPLY_TO` | adresse de réponse des accusés de réception | `MAIL_FROM_ADDRESS` |
| `MAIL_TO` | boîte interne destinataire des leads | — *(requis si `smtp`)* |
| `MAIL_TIMEOUT` | délai maximal d'un envoi, en ms, borné à `[1000, 60000]` | `10000` |
| `MAIL_SEND_ACKNOWLEDGEMENT` | accusé de réception au prospect | `true` |

**Matrice des ports.** Scaleway TEM écoute sur plusieurs ports parce que
beaucoup d'hébergeurs filtrent les ports bas en sortie :

| Port | Chiffrement | `SMTP_SECURE` | Quand l'utiliser |
|---|---|---|---|
| 587 | STARTTLS | `false` | **défaut recommandé** |
| 2587 | STARTTLS | `false` | si 587 est filtré en sortie |
| 465 | TLS implicite | `true` | alternative classique |
| 2465 | TLS implicite | `true` | si 465 est filtré |
| 25 | STARTTLS | `false` | à éviter, filtré presque partout |

Symptôme d'un port filtré : les envois échouent tous en `timeout` après
`MAIL_TIMEOUT`, sans jamais d'erreur d'authentification. Si l'authentification
échoue, en revanche, c'est la clé API ou l'ID de projet qui sont en cause, pas
le port.

`MAIL_FROM_ADDRESS` **doit** appartenir au domaine vérifié à l'étape 4.1. Une
adresse d'un domaine voisin (un `@gmail.com`, par exemple) est refusée par
Scaleway à l'envoi. `MAIL_TO`, en revanche, est libre : c'est un destinataire,
pas un expéditeur — la boîte interne peut rester chez n'importe quel
fournisseur.

### 4.4 Ce que l'API refuse de faire

Le contrôle de cohérence tourne **au démarrage**, avant d'accepter la moindre
requête :

- `MAIL_TRANSPORT=smtp` avec un `SMTP_HOST`, `SMTP_USERNAME`, `SMTP_PASSWORD`,
  `MAIL_FROM_ADDRESS` ou `MAIL_TO` manquant ou invalide → **le service ne
  démarre pas**, avec la liste des variables fautives dans les journaux.

  C'est volontaire, et c'est la même règle que pour le reste de cette API : un
  service qui refuse de démarrer se voit en trente secondes, une boîte de
  réception vide se remarque au bout d'une semaine — après avoir perdu les
  leads de la semaine.

- `MAIL_TRANSPORT=dry-run` en production → le service démarre et **journalise
  un avertissement**. C'est un état légitime pendant la vérification du domaine,
  mais qui ne doit pas s'installer par inadvertance.

- `MAIL_TRANSPORT` avec une valeur inconnue → `dry-run` est appliqué et un
  avertissement est journalisé. En cas de doute, on n'envoie pas.

### 4.5 Vérification après bascule

```bash
curl -s -X POST https://api.estimer.co/v1/leads \
  -H 'Content-Type: application/json' -H 'Origin: https://estimer.co' \
  -d '{"kind":"contact","name":"Test Deploiement",
       "email":"<votre adresse de test>","subject":"information",
       "message":"Verification du canal transactionnel."}'
```

| Réponse | Interprétation |
|---|---|
| `{"status":"sent","reference":"…"}` | e-mail réellement remis à Scaleway |
| `{"status":"dry-run","reference":"…"}` | `MAIL_TRANSPORT` est resté sur `dry-run` — **rien n'est parti** |
| `422` | payload invalide (le corps liste les champs fautifs) |
| `429` | quota `RATE_LIMIT_LEADS` atteint |
| `502 MAIL_UNAVAILABLE` | l'API n'a pas pu remettre l'e-mail : domaine non vérifié, identifiants refusés, ou port filtré |

Vérifiez ensuite **les deux** e-mails : celui reçu sur `MAIL_TO`, et l'accusé de
réception arrivé sur l'adresse de test. Contrôlez que ce dernier n'est pas en
spam — c'est le signe qui trahit un SPF ou un DKIM incomplet, et il ne se voit
pas dans les journaux de l'API.

Côté journaux (Coolify → Logs), les événements à chercher :

| Événement | Signification |
|---|---|
| `mail.internal_sent` | l'e-mail interne est parti |
| `mail.internal_dry_run` | il a été construit mais **non envoyé** |
| `mail.acknowledgement_sent` | l'accusé de réception est parti |
| `mail.acknowledgement_failed` | l'accusé a échoué — **le lead reste acquis**, l'e-mail interne étant envoyé en premier et son sort indépendant |
| `mail.internal_failed` | échec de l'e-mail interne : c'est le seul qui fait perdre un lead, il est à traiter à la main |
| `mail.not_configured` | `MAIL_TO` absent |

Les adresses y apparaissent **masquées** (`j***t@example.com`) : le domaine
reste lisible, ce qui suffit à diagnostiquer un rejet par fournisseur, mais les
journaux ne constituent pas un second fichier de prospects.

### 4.6 RGPD — ce que cet endpoint fait et ne fait pas

`POST /v1/leads` est le **seul** endpoint qui reçoit des données personnelles,
et il n'en persiste aucune : les coordonnées traversent le processus, partent
par SMTP, et disparaissent. Aucune table, aucun fichier, aucun journal en clair.

`POST /v1/estimations` continue de les **refuser** explicitement (422
`forbidden_pii`). C'est cette séparation qui garantit que `estimations_log` ne
contient toujours aucune donnée d'identification, et elle ne doit pas être
fusionnée « pour simplifier ».

La mise en service ajoute un sous-traitant au registre des traitements
(Scaleway, pour l'acheminement des e-mails) : la politique de confidentialité
doit le mentionner.

### 4.7 Retour arrière

Poser `MAIL_TRANSPORT=dry-run` et redéployer. Le formulaire continue de
répondre 200, plus aucun e-mail ne part, et les journaux le disent à chaque
soumission (`mail.internal_dry_run`). C'est le bon geste si la réputation du
domaine pose problème : cela arrête l'émission sans casser le parcours des
visiteurs.

### 4.8 Alerte Discord (canal accessoire, optionnel)

Chaque lead peut, en plus de l'e-mail, déclencher une alerte immédiate dans un
salon Discord. L'objectif est le délai de rappel : un prospect recontacté dans
les dix minutes ne se transforme pas comme un prospect recontacté le lendemain.

**Ce canal est accessoire, et le code le tient pour tel** : il ne peut pas
faire échouer un dépôt de lead, ne peut pas empêcher le service de démarrer,
et est borné à 4 secondes. L'e-mail reste la trace archivée.

Récupérer l'URL : Discord → salon → *Modifier le salon* → *Intégrations* →
*Webhooks* → *Nouveau webhook* → *Copier l'URL du webhook*.

```bash
DISCORD_WEBHOOK_URL=<URL copiée depuis Discord>   # SECRET
```

| Variable | Rôle | Défaut si absente |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | URL du webhook. **Vide = canal désactivé**, aucun appel réseau | — *(désactivé)* |
| `DISCORD_TIMEOUT` | délai maximal de l'appel, en ms, borné à `[500, 15000]` | `4000` |
| `DISCORD_INCLUDE_CONTACT` | coordonnées du prospect dans le message | `true` |
| `DISCORD_MENTION` | `@here`, `@everyone` ou un identifiant de rôle | — *(aucune)* |
| `DISCORD_USERNAME` | nom d'affichage du bot | `Estimer mon bien` |

`DISCORD_WEBHOOK_URL` est un **secret** : quiconque la détient peut poster dans
le salon. Elle vit dans le gestionnaire de secrets de Coolify, et n'apparaît
dans aucun journal — pas même en cas d'échec.

Journaux à chercher :

| Événement | Signification |
|---|---|
| `discord.notify_sent` | l'alerte est arrivée dans le salon |
| `discord.notify_rejected` | Discord a refusé (404 = webhook supprimé, 429 = quota) |
| `discord.notify_failed` | réseau injoignable ou délai dépassé — **le lead n'est pas affecté** |

L'alerte part **aussi quand l'e-mail interne a échoué**, et le message le dit
en toutes lettres : dans ce cas précis, le salon est la seule trace du lead.

**RGPD.** À `DISCORD_INCLUDE_CONTACT=true` (défaut), le nom, l'e-mail, le
téléphone et l'adresse du bien sont transmis à Discord, établi aux États-Unis.
Ce destinataire figure à ce titre dans la politique de confidentialité
(`src/pages/politique-de-confidentialite.astro`, sections « Destinataires et
sous-traitants » et « Transferts »). Poser `DISCORD_INCLUDE_CONTACT=false`
produit une alerte strictement anonyme — type de bien, commune, montant,
référence — sans aucune donnée personnelle : c'est le réglage à choisir si l'on
ne veut pas de ce destinataire, et il faut alors retirer les mentions
correspondantes de la politique.

**Retour arrière** : vider `DISCORD_WEBHOOK_URL` et redéployer. Plus aucun
appel n'est fait, le reste du parcours est inchangé.

---

## 5. Premier déploiement

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

## 6. Chargement des données — l'étape longue

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

## 7. Tâches planifiées

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

## 8. Côté site statique — dernière étape

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

## 9. Contrôles avant ouverture au public

- [ ] Restauration de sauvegarde testée
- [ ] `TRUSTED_PROXY` vérifié sur la vraie plage Docker — sinon le rate limiting
      est soit global, soit contournable
- [ ] `/health` répond `hasMutations: true`
- [ ] Domaine vérifié chez Scaleway TEM, SPF + DKIM + DMARC au vert
- [ ] `MAIL_TRANSPORT=smtp` — sinon `POST /v1/leads` répond 200 sans qu'aucun
      lead n'arrive
- [ ] Un lead de test reçu sur `MAIL_TO`, **et** son accusé de réception reçu
      hors du dossier spam
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
