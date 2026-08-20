# Specs — Estimation fondée sur des données réelles (DVF + BAN + PostGIS)

Statut : **Ready for Dev (Lot 0 et Lot 1)** — Lots 2 à 8 : cadrés, à réestimer après Lot 1
Auteur : Product Owner
Dépend de : `specs/estimation-wizard.md` (wizard 5 étapes, contrat `lastEstimation`)

**Architecture retenue (décision client, non négociable) : API backend séparée.**
Nouveau dossier `api/` dans le même dépôt = application **AdonisJS 6** + **PostgreSQL 16 / PostGIS**, déployée comme service **Coolify indépendant**. Le site Astro reste **100 % statique** sur GitHub Pages et consomme l'API via `PUBLIC_API_URL`.

Fichiers concernés côté front :
- `src/scripts/estimation-wizard.js` — `calculerEstimation()` (~l.381) et `prixMoyenM2` (~l.325) : l'algorithme actuel
- `src/scripts/estimation-ui.js` — soumission, `localStorage`, EmailJS
- `src/pages/estimation.astro`, `src/pages/rapport.astro`
- `src/scripts/rapport-report.js`, `src/scripts/pdf-report.js` — **consommateurs** de `lastEstimation.estimation`
- `src/data/prix.ts` — prix région/département en dur (`/carte`)
- `src/lib/config.ts`, `src/components/ClientConfig.astro`, `.env.example`

---

## 0. Point de départ — ce qui ne va pas aujourd'hui

`calculerEstimation(city, surface, rooms, propertyType, dpe)` est intégralement documenté comme une « copie exacte de l'algorithme existant, non-régression pure ». Il est aujourd'hui la faiblesse centrale du produit :

| Limite | Détail | Conséquence |
|---|---|---|
| **Table de 35 villes en dur** | `prixMoyenM2` couvre 37 villes + `default: 3000` | ~34 900 communes françaises tombent sur 3 000 €/m², de la Creuse au Cap-Ferret |
| **Matching par `includes()`** | `cityLower.includes(ville) \|\| ville.includes(cityLower)` | Faux positifs certains : **« Metz » matche « Metz-en-Couture » (62)**, **« Tours » matche « Tours-sur-Marne » (51)**, et `default` vaut 3000 pour Neuilly comme pour Guéret. L'itération `for…in` s'arrête au **premier** match, dépendant de l'ordre de déclaration. |
| **Coefficients arbitraires** | `maison = 0,95`, `terrain = 0,3`, `local-commercial = 0,8`, DPE A = +15 %, `rooms >= 4` = +5 % | Aucune source, aucun ancrage marché, non auditables, faux dans une majorité de cas |
| **Fourchette fixe ±10 %** | `× 0,9` et `× 1,1` | Ne traduit aucune incertitude réelle : identique à Paris intra-muros et dans une commune de 300 habitants où l'on n'a aucune donnée |
| **Aucune donnée réelle** | Aucune transaction, aucun comparable | La promesse « prix le plus juste » n'est pas tenue |
| **Aucune notion de confiance** | Le chiffre est présenté avec la même autorité partout | Risque de crédibilité, risque juridique (avis de valeur implicite) |
| **Aucun comparable affiché** | `/rapport` ne montre aucune transaction | Rien à opposer à un vendeur qui conteste |
| **Duplication de données** | `prixMoyenM2` (wizard) vs `src/data/prix.ts` (carte) : valeurs différentes, granularités différentes, déjà signalé en commentaire l.324-328 | Deux vérités contradictoires sur le même site |

Objectif de cette spec : remplacer ce calcul par une valorisation **fondée sur des transactions réelles géolocalisées**, avec **fourchette dérivée de la dispersion observée**, **indice de confiance** et **comparables affichables**.

---

## 1. Sources de données réelles françaises

### 1.1 Comparatif

| Source | Couverture | Fraîcheur | Licence | Accès | Clé / CORS | Volumétrie |
|---|---|---|---|---|---|---|
| **DVF géolocalisé** (Etalab, `files.data.gouv.fr/geo-dvf/latest/csv/`) | France entière **sauf 57, 67, 68 et 976** (voir §1.3) | Publication **semestrielle : avril et octobre**. Millésime « latest » = 5 ans glissants + année en cours. Latence réelle 6-12 mois sur les mutations récentes | **Licence ouverte Etalab 2.0** | CSV `.gz`, un fichier par année × département | Pas de clé. **Pas de CORS** → téléchargement serveur uniquement | ~15-20 M lignes brutes (1 ligne = 1 lot/local) → ~5 M mutations, dont **~2,5-3,5 M mutations bâties exploitables** après filtrage. ~3-6 Go table + index |
| **API DVF** (`app.dvf.etalab.gouv.fr/api`, `api.cquest.org/dvf`) | Idem DVF | Idem | Etalab 2.0 | REST JSON | Sans clé, CORS souvent ouvert, **mais service non contractuel, sans SLA ni quota documenté** | — |
| **DVF+ / DV3F** (Cerema) | Idem + typologie de mutation, filtrage des ventes non marchandes, chaînage parcelles | Semestrielle | Accès **sous convention** (gratuit pour acteurs publics, payant/contractualisé sinon) | PostgreSQL/dump | Convention obligatoire | Idem, enrichi |
| **BAN / `api-adresse.data.gouv.fr`** | France entière, ~25 M adresses | Continue | Licence ouverte (BAN sous LO depuis 2024 — **à revérifier à l'implémentation**) | REST `/search`, `/reverse`, `/search/csv` (bulk) | **Sans clé, CORS ouvert.** Limite d'usage ~50 req/s/IP sur `/search`, bulk CSV pour les volumes | Retourne `citycode` (INSEE), `lon/lat`, `score` |
| **ADEME — Observatoire DPE** (`data.ademe.fr`, jeux `dpe-v2-logements-existants` / `dpe03existant`) | France entière | Quotidienne (flux continu) | Licence ouverte Etalab 2.0 | API Opendatasoft (REST JSON) + exports | **Sans clé, CORS ouvert**, quotas ODS raisonnables | >10 M DPE. Champs : classe énergie/GES, surface, année construction, adresse + `ban_id` |
| **INSEE** (COG, populations légales, grille de densité, contours IRIS via IGN) | France entière, ~34 900 communes | Annuelle | Licence ouverte | CSV/API BDM | Sans clé (API BDM = clé pour certains flux) | Quelques Mo |
| **Indice Insee-Notaires** des prix des logements anciens | France, régions, Paris/IdF, par type (appartement/maison) | **Trimestrielle**, publiée ~3 mois après le trimestre | Licence ouverte | Séries BDM Insee, CSV | Sans clé | Quelques Ko |
| **Cadastre Etalab** (`cadastre.data.gouv.fr`) | France entière (hors Alsace-Moselle pour le parcellaire DGFiP partiel) | Trimestrielle | Licence ouverte | GeoJSON par commune | Sans clé | ~100 M parcelles, volumineux |

### 1.2 Combinaison recommandée

| Rôle | Source | Justification |
|---|---|---|
| **Socle de valorisation** | **DVF géolocalisé** (fichiers, ingérés en base) | Seule source publique de **prix de transaction réels**, exhaustive, gratuite, redistribuable, avec `longitude/latitude` déjà présentes → PostGIS immédiatement exploitable. On ingère les **fichiers**, pas l'API tierce : maîtrise de la disponibilité, des performances et de la fraîcheur. |
| **Géocodage + rattachement INSEE** | **BAN via `api-adresse.data.gouv.fr`**, appelée **côté API** (pas côté navigateur) et mise en cache | Gratuite, sans clé, précise à l'adresse. Appelée côté serveur pour cacher les résultats, ne pas exposer notre volume d'appels et ne pas dépendre du CORS. Élimine définitivement le matching `includes()` sur le nom de ville. |
| **Ajustement temporel** | **Indice Insee-Notaires** (région × type) | Ramène une transaction de 2022 à la valeur d'aujourd'hui, avec une source officielle et citable. |
| **DPE / valeur verte** | **ADEME Observatoire DPE** | Deux usages : (a) pré-remplir le DPE à partir de l'adresse (gain UX majeur : ~40 % des utilisateurs répondent « je ne sais pas ») ; (b) **calibrer les coefficients DPE sur nos propres données** par jointure DVF × DPE sur `ban_id`, au lieu d'inventer des pourcentages. |
| **Référentiel communal** | **INSEE (COG + densité)** + centroïdes | Repli quand le géocodage échoue, libellés propres, rattachement EPCI/département/région, drapeau `has_dvf`. |
| **Cadastre** | **Non retenu au MVP** | Coût d'ingestion élevé, apport marginal tant qu'on ne fait pas d'analyse parcellaire fine. À rouvrir au Lot 8. |
| **DV3F** | **Non retenu au MVP** | Nécessite une convention Cerema. À rouvrir si la qualité du filtrage DVF s'avère insuffisante (ventes entre parents, VEFA, démembrements). |

**Ce qui est explicitement écarté** : scraping d'annonces (illégal/fragile, et une annonce n'est pas un prix de vente), API d'agrégateurs privés payantes (coût récurrent, dépendance), estimation par ML (aucune donnée d'entraînement propriétaire, non explicable — or l'explicabilité est ici un argument commercial).

### 1.3 Trou de couverture connu — Alsace-Moselle et Mayotte

**Point fonctionnel important, à ne pas découvrir en production.**

Les départements **Bas-Rhin (67), Haut-Rhin (68), Moselle (57)** relèvent du **Livre foncier** (droit local alsacien-mosellan) et non du fichier immobilier de la DGFiP : **leurs mutations sont absentes de DVF**. Idem pour **Mayotte (976)**. Cela représente ~3,3 M d'habitants et une part non nulle du trafic (Strasbourg, Mulhouse, Metz figurent d'ailleurs dans la table en dur actuelle).

Traitement retenu : **repli explicite et assumé** (voir §3.9), jamais un silence ni une fausse mention DVF.

---

## 2. Architecture

### 2.1 Décision et justification courte

**API AdonisJS 6 + PostgreSQL 16/PostGIS dans `api/`, service Coolify indépendant. Front Astro inchangé, 100 % statique.**

Justification en trois points :
1. **Le volume interdit le statique.** DVF exploitable = ~3 M mutations, ~3-6 Go avec index. Un pré-calcul au build ne pourrait embarquer qu'un agrégat par commune × type × tranche de surface — soit précisément ce qui fait perdre la valeur : la **proximité géographique réelle**. Un bien rue de Rivoli et un bien porte de la Chapelle sont dans la même commune.
2. **La sélection par rayon exige un index spatial.** `ST_DWithin` + index GiST donne des comparables « à 400 m » en quelques millisecondes. Aucun équivalent côté navigateur sur un JSON statique.
3. **La fraîcheur et la traçabilité.** DVF sort tous les 6 mois, l'indice Insee tous les 3 mois, l'ADEME en continu. Un dataset figé au build imposerait un redéploiement du site à chaque mise à jour de donnée, et rendrait la mention légale « données au {date} » dépendante du calendrier de déploiement du front.

Coût accepté : un service à exploiter, une base à sauvegarder, un point de panne supplémentaire — traité au §2.4.

### 2.2 Topologie

```
estimer.co (dépôt)
├── src/, public/, astro.config.mjs      ← inchangé, build statique, GitHub Pages
├── Dockerfile                           ← inchangé (nginx, image du site statique)
├── .github/workflows/deploy.yml         ← inchangé
└── api/                                 ← NOUVEAU, service Coolify indépendant
    ├── Dockerfile                       ← node:22-alpine, build AdonisJS
    ├── package.json                     ← indépendant de celui de la racine
    ├── start/{routes.ts,kernel.ts}
    ├── app/{controllers,services,models,validators,middleware}
    ├── database/migrations
    ├── commands/{dvf_import.ts,indices_import.ts,dpe_import.ts}
    └── tests/{unit,functional}          ← Japa (fourni par AdonisJS)
```

Le dépôt reste unique (un seul historique, une seule PR pour un changement de contrat front/back), mais **les deux CI sont indépendantes** : `.github/workflows/deploy.yml` ne se déclenche que sur les chemins hors `api/**`, et une nouvelle CI `api.yml` ne se déclenche que sur `api/**` (tests + build image). Le déploiement de l'API se fait par Coolify (webhook sur push `main` filtré sur `api/**`).

Services Coolify :
- `estimer-api` : image Node, variables d'env, port interne 3333, domaine `api.estimer.co`, TLS Let's Encrypt.
- `estimer-db` : PostgreSQL 16 + PostGIS (image `postgis/postgis:16-3.4`), volume persistant, sauvegarde quotidienne (dump `pg_dump -Fc`, rétention 14 j). **Non exposé publiquement.**

### 2.3 Configuration front

`.env.example` (racine, front) — ajouter :
```
# URL de base de l'API d'estimation (service Coolify). Vide = mode dégradé (§2.4).
PUBLIC_API_URL=https://api.estimer.co
# Repli statique (démo/preview uniquement). 'none' (défaut) | 'static'
PUBLIC_ESTIMATION_FALLBACK=none
```
`src/lib/config.ts` expose `CONFIG.API = { BASE_URL, FALLBACK }`, injecté par `ClientConfig.astro` comme les autres clés.

### 2.4 Comportement du front si l'API est indisponible — **décision tranchée**

**Décision : PAS de repli silencieux sur la table statique actuelle.**

Justification :
- La promesse produit devient « un prix juste fondé sur des transactions réelles ». Afficher, sous la même interface et avec la même mention « source DVF », un chiffre issu d'une table de 35 villes serait **factuellement mensonger** et exposerait juridiquement (la mention de source deviendrait fausse).
- Le **lead est la vraie valeur business**, pas le chiffre affiché immédiatement. On peut donc dégrader l'affichage sans perdre le lead.

Séquence retenue :

| Étape | Comportement |
|---|---|
| 1 | Appel `POST /v1/estimations`, **timeout 6 s**, **1 retry** avec backoff 1,5 s (uniquement sur erreur réseau / 5xx / timeout — **jamais** sur 4xx). |
| 2a | Succès → `lastEstimation.estimation` renseignée, redirection `/rapport/` normale. |
| 2b | Échec définitif → **mode « estimation différée »** : le formulaire est **quand même soumis** (EmailJS, lead conservé), `lastEstimation.estimation = null` et `lastEstimation.estimationStatus = 'deferred'`. `/rapport` affiche un état dédié : « Nous n'avons pas pu calculer votre estimation en direct. Un conseiller vous l'adresse sous 24 h ouvrées. » + CTA contact. Aucun prix inventé n'est affiché. |
| 2c | Exception encadrée : si `CONFIG.API.FALLBACK === 'static'` (**désactivé par défaut**, réservé aux previews et démos hors ligne), on utilise `calculerEstimation()` conservée telle quelle, avec un **bandeau permanent** « Estimation indicative, hors données DVF » et `estimationStatus = 'static-fallback'`. Ce mode ne doit jamais être activé en production — à contrôler en revue de déploiement. |
| 3 | Dans tous les cas d'échec, l'e-mail EmailJS envoyé à l'équipe contient explicitement `ESTIMATION NON CALCULEE (API indisponible)` pour que le lead soit traité manuellement. |

**Conséquence sur `calculerEstimation()`** : la fonction et la table `prixMoyenM2` **restent dans le code** (mode fallback + tests de non-régression existants `scripts/test-estimation-wizard.mjs`), mais ne sont plus le chemin nominal. Leur commentaire doit être mis à jour pour l'indiquer sans ambiguïté.

### 2.5 CORS

`@adonisjs/cors`, configuration explicite (`api/config/cors.ts`) :
```
enabled: true
origin: ['https://estimer.co', 'https://www.estimer.co', 'http://localhost:4322']
methods: ['GET', 'POST', 'OPTIONS']
headers: ['Content-Type', 'Accept']
exposeHeaders: ['Retry-After', 'X-Data-Version']
credentials: false          // aucune session, aucun cookie
maxAge: 86400
```
Notes :
- `http://localhost:4322` correspond au port figé dans `astro.config.mjs` (`server.port: 4322`, `strictPort`) — cohérent avec la restriction de référent Google.
- La liste est pilotée par une variable d'environnement `CORS_ORIGINS` (CSV) pour permettre l'ajout d'une preview sans rebuild d'image.
- `credentials: false` est délibéré : **aucune authentification utilisateur** sur ce site (§2.6).

### 2.6 Rate limiting et anti-abus (endpoint public, sans authentification)

`@adonisjs/limiter` (store `database` sur PostgreSQL au Lot 0 ; passer à Redis si la charge le justifie).

| Route | Limite | Clé |
|---|---|---|
| `POST /v1/estimations` | **10 req / minute** et **60 req / jour** | IP client |
| `GET /v1/geocode` | 30 req / minute | IP client |
| `GET /v1/marche/:codeInsee` | 60 req / minute | IP client |
| Global (toutes routes) | 120 req / minute | IP client |

Dépassement → **429** avec en-tête `Retry-After` (secondes) et corps `{ "code": "RATE_LIMITED", "message": "Trop de requêtes, réessayez dans N secondes." }`. Le front affiche un message explicite (pas un échec silencieux) et **ne retente pas**.

Résolution de l'IP : `X-Forwarded-For` accepté **uniquement** depuis le proxy Coolify (`TRUSTED_PROXY` renseigné avec le CIDR interne). Sans cela, un attaquant forge l'en-tête et contourne la limite.

Autres protections :
1. **Aucune PII acceptée sur l'API.** `POST /v1/estimations` ne reçoit **ni nom, ni e-mail, ni téléphone** — ces champs restent côté front (EmailJS). Conséquence : la surface d'attaque n'a aucune valeur pour un exfiltreur, et le RGPD est réglé par construction (minimisation).
2. **Payload borné** : `bodyParser` limité à 4 Ko sur `/v1/*` ; validation VineJS stricte avec bornes numériques (§6).
3. **Vérification d'`Origin`** en production : requête sans `Origin` ou hors liste → 403 `FORBIDDEN_ORIGIN`. Ce n'est pas une protection forte (l'en-tête se forge en cURL), mais elle élimine le bruit et les intégrations sauvages.
4. **Cache applicatif** : réponse mise en cache 24 h sur la clé `(round(lat,3), round(lon,3), type, tranche_surface_10m2, dpe, options)` → un même quartier interrogé en boucle ne recalcule pas. Absorbe l'essentiel d'un abus « lent ».
5. **Journalisation anonymisée** dans `estimations_log` (hash HMAC de l'IP avec sel serveur, pas l'IP en clair), rétention **12 mois**, pour détecter les motifs d'abus et suivre la qualité.
6. **Pas de CAPTCHA au Lot 1** : friction disproportionnée sur un tunnel de conversion, pour une donnée publique et non monétisable unitairement. À réévaluer si l'observabilité montre un scraping réel (critère : > 5 000 req/jour depuis moins de 20 IP).

### 2.7 Périmètre géographique

**France entière, ~34 900 communes, DOM inclus** (971 Guadeloupe, 972 Martinique, 973 Guyane, 974 La Réunion — présents dans DVF).
**Hors couverture DVF : 57, 67, 68, 976** → repli documenté au §3.9, drapeau `communes.has_dvf = false`, exposé par `GET /v1/meta/data-version`.

---

## 3. Le nouvel algorithme

> Formules et paramètres ; aucun code. **Tous les paramètres numériques sont stockés en base (`coefficients_reference`) ou en configuration, jamais en dur dans le code** : ils devront être recalibrés (Lot 7) et chaque valeur doit porter sa source.

### 3.0 Vue d'ensemble

```
adresse ─► [1] géocodage BAN ─► point (lon,lat) + code INSEE
                                     │
                                     ▼
                     [2] sélection des comparables par rayon (PostGIS, cascade)
                                     │
                     [3] nettoyage / écrêtage des aberrations
                                     │
                     [4] ajustement temporel de chaque comparable
                                     │
                     [5] prix de référence = MÉDIANE PONDÉRÉE €/m²
                                     │
                     [6] coefficients d'ajustement du bien (bornés)
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
   [7] valeur centrale     [8] fourchette (IQR)   [9] indice de confiance
```

### 3.1 Géocodage

`GET https://api-adresse.data.gouv.fr/search/?q={adresse}&postcode={cp}&limit=1&type=housenumber`

- Résultat exploité : `geometry.coordinates` (lon, lat), `properties.citycode` (INSEE), `properties.score`, `properties.type`.
- **Mise en cache** en base (`geocode_cache`, TTL 90 jours, clé = hash SHA-256 de la requête normalisée). Objectif : ne jamais réinterroger la BAN pour une adresse déjà vue, et rester très en deçà de ses limites d'usage.
- Qualité :
  - `type === 'housenumber'` et `score ≥ 0,7` → `geocodePrecision = 'exact'`
  - `type ∈ {street, locality}` ou `score ∈ [0,4 ; 0,7[` → `'approximate'`, malus de confiance
  - échec, `score < 0,4`, ou BAN injoignable → repli sur le **centroïde de la commune** (`communes.centroid` déduit du code postal → INSEE ; si un code postal couvre plusieurs communes, on prend celle dont le libellé correspond le mieux, sinon la plus peuplée) → `'city-centroid'`, malus fort.
- Timeout BAN : 3 s, 1 retry. Un échec BAN **ne fait jamais échouer l'estimation** : on descend en précision.

### 3.2 Sélection des comparables — cascade par rayon réel (PostGIS)

Requête de base (formulation, pas du SQL final) :
```
SELECT ... FROM mutations
WHERE ST_DWithin(geom, :point, :radius)          -- index GiST, geography → mètres
  AND type_local = :type
  AND surface_bati BETWEEN :surface*0.7 AND :surface*1.3
  AND date_mutation >= now() - :window
  AND prix_m2 BETWEEN 200 AND 25000
ORDER BY ST_Distance(geom, :point)
LIMIT 300
```

**Cascade** (on s'arrête au premier niveau satisfaisant) :

| Niveau | Périmètre | Fenêtre temporelle | Condition d'acceptation |
|---|---|---|---|
| L1 | rayon **500 m** | 24 mois | N ≥ 15 |
| L2 | rayon **1 km** | 24 mois | N ≥ 15 |
| L3 | rayon **2 km** | 36 mois | N ≥ 12 |
| L4 | rayon **5 km** | 36 mois | N ≥ 10 |
| L5 | **commune** (`code_insee`) | 36 mois | N ≥ 8 |
| L6 | **EPCI** | 36 mois | N ≥ 8 |
| L7 | **département** | 60 mois | N ≥ 8 |
| L8 | **région** | 60 mois | N ≥ 8 |
| L9 | **national** (même type, même tranche de surface, même strate de densité INSEE) | 60 mois | toujours accepté |

Règles complémentaires :
- **N_min absolu = 5.** En dessous de 5 comparables **après écrêtage**, le niveau est rejeté quelle qu'en soit la condition, et l'on passe au suivant.
- Élargissement de la surface : si aucun niveau jusqu'à L5 n'atteint son seuil, on relâche la tolérance de surface de ±30 % à ±40 % et on **rejoue une seule fois** L1→L5 avant de passer à L6. Consigné dans `method.surfaceToleranceUsed`.
- Le rayon est **plafonné à 5 km** pour les niveaux géographiques : au-delà, un rayon perd son sens (à 10 km on traverse trois marchés), la cascade administrative est plus lisible pour l'utilisateur (« à l'échelle de votre commune »).
- Le niveau retenu (`level`) et le rayon effectif (`radiusM`) sont **exposés dans la réponse** et affichés à l'utilisateur : c'est la clé de la transparence.
- Cas particuliers de type de bien :
  - `terrain` → table `mutations_terrain`, mêmes règles, tolérance de surface ±50 %, seuils divisés par 2.
  - `local-commercial` → DVF renseigne très mal ce segment. **Décision : au Lot 1-3, on ne calcule pas.** L'API répond 200 avec `method.kind = 'not-supported'`, `value = null`, et le front bascule sur l'écran « estimation différée » (§2.4) avec un message spécifique. Il vaut mieux dire « nous vous rappelons » que sortir un chiffre au hasard. À rouvrir au Lot 8.

### 3.3 Nettoyage et écrêtage

Sur l'échantillon retourné, dans cet ordre :
1. **Bornes absolues** (déjà appliquées à l'ingestion, redoublées ici par sécurité) : `prix_m2 ∈ [200, 25 000]`, `valeur_fonciere ∈ [5 000, 15 000 000]`, `surface_bati ∈ [9, 1 000]`.
2. **Écrêtage IQR** sur l'échantillon : calcul de Q1, Q3, IQR = Q3 − Q1 ; rejet de tout `prix_m2` hors `[Q1 − 1,5·IQR ; Q3 + 1,5·IQR]`.
3. **Plafond d'échantillon** : on conserve au maximum les **150 comparables les plus proches** (au sens de la distance) pour borner le temps de calcul.
4. Si `N < 5` après (1) et (2) → niveau rejeté, on descend dans la cascade (§3.2).

Le nombre de comparables écartés et le motif sont retournés dans `method.rejected` (audit et débogage).

### 3.4 Ajustement temporel

Chaque comparable est ramené à la date du jour :
```
p_adj(i) = p(i) × I(T0) / I(T_i)
```
- `I` = indice Insee-Notaires des prix des logements anciens, série **(région, type de bien)**, trimestrielle.
- `T_i` = trimestre de la mutation, `T0` = dernier trimestre **publié**.
- Si l'indice manque pour la région ou le type, repli en cascade : (région, tous types) → (France, type) → (France, tous types). Le niveau utilisé est consigné.
- **Aucune extrapolation au-delà du dernier trimestre publié** : entre le trimestre publié et aujourd'hui (jusqu'à ~6 mois de latence), le facteur vaut 1. C'est un choix conservateur assumé, à mentionner dans la méthodologie.
- Le facteur d'ajustement médian appliqué est exposé (`method.timeAdjustmentFactor`) — utile pour expliquer un écart avec le brut DVF.

### 3.5 Prix de référence — médiane pondérée

**Médiane et non moyenne** : la distribution des prix/m² est asymétrique à droite (quelques biens d'exception tirent la moyenne), et la médiane résiste aux valeurs extrêmes résiduelles.

Poids de chaque comparable : `w_i = w_geo(i) × w_temps(i) × w_surface(i)`

| Composante | Formule | Effet |
|---|---|---|
| `w_geo` | `1 / (1 + (d_i / 500)²)`, `d_i` en mètres | à 0 m : 1 ; à 500 m : 0,50 ; à 1 km : 0,20 ; à 2 km : 0,06 |
| `w_temps` | `0,5 ^ (age_mois / 24)` | demi-vie de 24 mois |
| `w_surface` | `1 / (1 + |S_i − S| / S)` | à surface égale : 1 ; à ±30 % : 0,77 |

`P_ref` = **médiane pondérée** = valeur de `p_adj` au point où la somme cumulée des poids (série triée par `p_adj` croissant) atteint 50 % de la somme totale des poids.

Sont également calculés sur la même distribution pondérée : `Q1_w` (25 %), `Q3_w` (75 %) — utilisés au §3.7.

### 3.6 Coefficients d'ajustement du bien

Appliqués multiplicativement à `P_ref`. **Tous bornés individuellement, et leur produit est borné globalement.**

| Coefficient | Règle | Bornes |
|---|---|---|
| **`k_surface`** — dégressivité du prix au m² | `k = (S_med / S) ^ α`, avec `S_med` = surface **médiane des comparables retenus** et α = **0,12** (appartement) / **0,18** (maison). Neutre (=1) quand le bien est à la médiane de son échantillon → **pas de double comptage** avec le filtre ±30 %. | [0,85 ; 1,15] |
| **`k_etage`** (appartement uniquement) | RDC : **0,95** ; dernier étage **avec** ascenseur : **1,05** ; étage ≥ 3 **sans** ascenseur : **0,93** ; étage 1-2 sans ascenseur : **0,98** ; sinon **1,00**. Champs inconnus → 1,00. | [0,90 ; 1,06] |
| **`k_exterieur`** | aucun : 1,00 ; balcon : **1,02** ; terrasse : **1,04** ; jardin privatif (appartement) : **1,06** ; pour une maison, non appliqué (déjà dans le comparable). Non cumulables : on prend le meilleur. | [1,00 ; 1,08] |
| **`k_etat`** | à rénover : **0,88** ; correct : **1,00** ; bon : **1,03** ; refait à neuf : **1,07**. Non renseigné → 1,00. | [0,85 ; 1,08] |
| **`k_dpe`** | Table **calibrée sur la valeur verte**, différenciée appartement/maison (voir ci-dessous). `unknown` → **1,00** + malus de confiance. | [0,80 ; 1,15] |

**Table `k_dpe` — valeurs de départ et règle de calibration**

Valeurs initiales alignées sur les ordres de grandeur publiés de la « valeur verte » (Notaires de France / ADEME), référence D = 1,00 :

| Classe | Appartement | Maison |
|---|---|---|
| A | 1,06 | 1,12 |
| B | 1,05 | 1,09 |
| C | 1,03 | 1,05 |
| D | 1,00 | 1,00 |
| E | 0,96 | 0,94 |
| F | 0,91 | 0,88 |
| G | 0,87 | 0,84 |

**Règles impératives :**
1. Chaque ligne est stockée dans `coefficients_reference` avec `source_label`, `source_url`, `date_source`. **Une valeur sans source ne doit pas exister en base** (contrainte `NOT NULL`).
2. Ces valeurs sont **provisoires**. Le **Lot 5** les remplace par une calibration sur nos propres données : jointure DVF × DPE ADEME sur `ban_id`, régression du log(prix/m²) sur la classe DPE avec contrôles (commune, type, surface, période), coefficients recalculés **par strate de densité INSEE** (l'écart de valeur verte est beaucoup plus fort en zone rurale qu'en zone tendue — un coefficient national unique est faux).
3. Tant que le Lot 5 n'est pas livré, la méthodologie affichée mentionne « coefficients de valeur verte de référence (source : {source}) », pas « calculés à partir de nos données ».

**Terrain (maisons)** — la valeur foncière DVF **inclut déjà le terrain** : on n'additionne donc jamais un prix de terrain à un prix de bâti.
```
V_terrain = P_terrain_m2 × (S_terrain − S_terrain_med)
```
- `S_terrain_med` = médiane des surfaces de terrain **des comparables maisons retenus** → un terrain « dans la norme du secteur » ne change rien.
- `P_terrain_m2` = médiane des prix/m² des mutations de terrains (table `mutations_terrain`) dans le même périmètre géographique ; à défaut, **8 %** de `P_ref` (valeur de repli, à sourcer/calibrer).
- Plafonds : `V_terrain` borné à **±25 %** de la valeur bâtie ; si `S_terrain > 5 000 m²`, la fraction au-delà de 5 000 m² est valorisée à **30 %** de `P_terrain_m2` (dégressivité des grands terrains).
- Si `hasTerrain = 'no'` ou surface non renseignée → `V_terrain = 0`.

**Garde-fou cumulé** :
```
k_total = clamp(k_surface × k_etage × k_exterieur × k_etat × k_dpe, 0,70 ; 1,35)
```
Si la borne est atteinte, `method.clamped = true` — l'information est retournée, affichée dans la méthodologie du rapport, et **coûte 10 points de confiance**. Un bien qui sort de ces bornes est un bien atypique, donc mal estimé par comparaison : il faut le dire.

### 3.7 Valeur centrale et fourchette dynamique

```
V_brut = P_ref × k_total × S + V_terrain
V      = arrondi(V_brut)   -- au millier si V ≥ 100 000 €, à la centaine sinon
prixM2 = arrondi(V / S)    -- à l'euro
```

**Fourchette dérivée de la dispersion réelle** (fini le ±10 % fixe) :
```
dispersion = (Q3_w − Q1_w) / P_ref                 -- IQR relatif de l'échantillon
f(N)       = 1 + 4 / sqrt(N)                        -- pénalité d'échantillon faible
a          = clamp(0,5 × dispersion × f(N) , 0,04 , 0,25)
low  = arrondi(V × (1 − a))
high = arrondi(V × (1 + a))
```
Repères :
- Marché homogène, N = 40, dispersion 0,20 → `a ≈ 0,16` → ±16 %… ramené par le calibrage réel ; **à valider en backtest Lot 7** (paramètre `0,5` ajustable en configuration).
- Échantillon national de repli (L9), N = 8, dispersion 0,55 → `a` plafonné à **±25 %**.
- Marché très homogène et bien fourni → plancher **±4 %** (on ne prétend jamais mieux : une transaction dépend aussi de l'acheteur).

`a` est retourné (`range.halfWidthPct`) et l'amplitude est **toujours affichée**, jamais masquée.

### 3.8 Indice de confiance (0-100)

```
C = C_n + C_geo + C_temps + C_disp − malus,   borné à [0 ; 100]
```

| Composante | Formule | Max |
|---|---|---|
| `C_n` — nombre de comparables | `40 × min(1, ln(1+N) / ln(31))` | 40 |
| `C_geo` — proximité | Niveaux rayon : `25 × (1 − min(1, radiusM / 5000))` ; L5 commune : **12** ; L6 EPCI : **7** ; L7 département : **3** ; L8/L9 : **0** | 25 |
| `C_temps` — fraîcheur | `15 × (1 − min(1, age_median_mois / 36))` | 15 |
| `C_disp` — homogénéité | `20 × (1 − min(1, dispersion / 0,60))` | 20 |

| Malus | Points |
|---|---|
| Géocodage `approximate` | −5 |
| Géocodage `city-centroid` | −12 |
| DPE `unknown` | −5 |
| `k_total` écrêté (bien atypique) | −10 |
| Département sans DVF (§3.9) | plafonnement à **35** (et non un malus) |
| Tolérance de surface élargie à ±40 % | −5 |

**Seuils d'affichage** :

| Score | Libellé | Couleur | Comportement UI |
|---|---|---|---|
| **75-100** | « Confiance élevée » | vert | Affichage normal, valeur centrale mise en avant |
| **50-74** | « Confiance moyenne » | orange | Affichage normal + phrase « la fourchette reflète la dispersion observée sur votre secteur » |
| **30-49** | « Confiance faible » | rouge | Valeur centrale **atténuée visuellement**, fourchette mise en avant, encart « peu de transactions comparables : une visite sur place est recommandée » + CTA expert |
| **0-29** | « Données insuffisantes » | gris | **La valeur centrale n'est pas affichée.** Seule une fourchette large est montrée, avec un message explicite et le CTA contact en action principale. L'API renvoie tout de même `value` (pour le back-office et l'e-mail interne), avec `display.showCentralValue = false`. |

C'est l'API qui décide (`display.showCentralValue`, `display.confidenceLabel`), pas le front : la règle doit être identique sur le site, dans le PDF et dans l'e-mail.

### 3.9 Repli Alsace-Moselle (57, 67, 68) et Mayotte (976)

Déclenchement : `communes.has_dvf = false` pour le code INSEE géocodé.

Comportement :
- L'API répond **200** (jamais une erreur : ce n'est pas une panne).
- `method.kind = 'reference-table'`, `method.level = 'departement-reference'`, `comparables = []`, `dataCoverage = 'no-dvf'`.
- Le prix de référence provient de la table `references_departementales` (§5), alimentée par des références départementales **sourcées** (observatoires notariaux locaux ; à défaut, `src/data/prix.ts` migré en base **et explicitement étiqueté `source_label = 'Estimation interne, hors DVF'`**).
- `confidence` **plafonnée à 35** → l'UI bascule automatiquement en mode « confiance faible ».
- Fourchette : `a = 0,20` fixe (pas de dispersion observée à exploiter).
- **Mention légale spécifique**, obligatoire sur la page et dans le PDF :
  > « Les départements du Bas-Rhin, du Haut-Rhin, de la Moselle et de Mayotte relèvent du régime du Livre foncier : leurs transactions ne figurent pas dans la base publique DVF de la DGFiP. Cette estimation repose sur des références départementales et non sur des transactions comparables. Sa précision est nettement réduite ; nous vous recommandons une évaluation sur place. »
- Le CTA « Être rappelé par un expert » devient l'action **principale** sur ces territoires.

### 3.10 Performance attendue

| Opération | Cible p95 |
|---|---|
| `POST /v1/estimations` bout en bout (cache froid, géocodage inclus) | **< 900 ms** |
| idem, géocodage en cache | < 500 ms |
| idem, réponse en cache applicatif | < 80 ms |
| Requête PostGIS de comparables (L1, index GiST chaud) | < 60 ms |
| `GET /v1/marche/:codeInsee` (vue matérialisée) | < 100 ms |

---

## 4. User stories et critères d'acceptation

### US-1 — Obtenir une estimation fondée sur des transactions réelles
> En tant que vendeur potentiel, je veux que mon estimation soit calculée à partir de ventes réelles proches de mon bien afin d'obtenir un prix crédible et défendable.

```gherkin
Scénario: Estimation nominale en zone bien couverte
  Given l'API est disponible et la base contient des mutations DVF
  And j'ai renseigné "12 rue de la Paix, 75002 Paris", appartement, 65 m², 3 pièces, DPE C
  When je soumets le formulaire
  Then l'API POST /v1/estimations répond 200 en moins de 900 ms (p95)
  And la réponse contient une valeur centrale, une fourchette, un indice de confiance et au moins 5 comparables
  And method.level vaut "radius" et method.radiusM est inférieur ou égal à 5000
  And la page /rapport affiche la valeur centrale, la fourchette et le nombre de transactions analysées

Scénario: Le prix de référence est une médiane, pas une moyenne
  Given un échantillon de comparables contenant une valeur extrême haute non écrêtée
  When le prix de référence est calculé
  Then il est égal à la médiane pondérée de l'échantillon
  And il n'est pas égal à la moyenne arithmétique

Scénario: Deux adresses de la même commune donnent des prix différents
  Given deux adresses distantes de plus de 3 km dans la même commune, mêmes caractéristiques de bien
  When je demande une estimation pour chacune
  Then les deux résultats reposent sur des échantillons de comparables différents
  And les prix au m² diffèrent d'au moins 1 %
```

### US-2 — Voir les transactions comparables
> En tant que vendeur, je veux voir les ventes réelles utilisées afin de comprendre et de contester le chiffre proposé.

```gherkin
Scénario: Affichage des comparables sur le rapport
  Given une estimation calculée avec 24 comparables
  When j'ouvre /rapport
  Then un bloc "Transactions comparables" liste les 5 plus proches
  And chaque ligne affiche : nom de voie, distance arrondie à 50 m, mois et année, type, surface, prix au m²
  And aucun numéro de voie n'est affiché
  And un lien "Voir la méthodologie" détaille le rayon retenu et la période analysée

Scénario: Aucun comparable disponible
  Given une estimation calculée en repli départemental ou national
  Then le bloc "Transactions comparables" affiche un état vide explicite
  And le message précise le niveau géographique effectivement utilisé
```

### US-3 — Comprendre la fiabilité de l'estimation
> En tant que vendeur, je veux savoir à quel point l'estimation est fiable afin de décider si je dois demander une expertise.

```gherkin
Scénario: Confiance élevée
  Given une estimation avec confidence = 82
  Then le rapport affiche "Confiance élevée" avec l'indicateur vert
  And la valeur centrale est mise en avant

Scénario: Confiance faible
  Given une estimation avec confidence = 41
  Then le rapport affiche "Confiance faible" avec l'indicateur rouge
  And un encart recommande une visite sur place
  And le CTA "Être rappelé par un expert" est visible sans défilement

Scénario: Données insuffisantes
  Given une estimation avec confidence = 18
  And display.showCentralValue vaut false
  Then aucune valeur centrale n'est affichée
  And seule la fourchette est présentée, accompagnée du message "données insuffisantes sur ce secteur"
  And le PDF applique exactement la même règle
```

### US-4 — Fourchette qui reflète la réalité du marché local
```gherkin
Scénario: Marché homogène et bien fourni
  Given 45 comparables avec une dispersion interquartile relative de 0,15
  Then la demi-amplitude a est inférieure à 0,12
  And la fourchette n'est pas égale à la valeur centrale plus ou moins 10 %

Scénario: Marché hétérogène ou peu fourni
  Given 7 comparables avec une dispersion interquartile relative de 0,60
  Then la demi-amplitude a est plafonnée à 0,25
  And le rapport explique que l'amplitude traduit la dispersion des ventes du secteur

Scénario: Bornes de l'amplitude
  Then a est toujours compris entre 0,04 et 0,25 inclus
```

### US-5 — Ne jamais afficher un prix inventé quand l'API est indisponible
```gherkin
Scénario: API injoignable
  Given l'API ne répond pas dans les 6 secondes, après un retry
  When je soumets le formulaire
  Then le lead est tout de même envoyé par EmailJS
  And l'e-mail interne contient la mention "ESTIMATION NON CALCULEE (API indisponible)"
  And /rapport affiche l'écran "estimation différée" avec un délai de réponse annoncé
  And aucun prix n'est affiché
  And lastEstimation.estimationStatus vaut "deferred"

Scénario: Mode repli statique explicitement activé (démo)
  Given CONFIG.API.FALLBACK vaut "static"
  When l'API est injoignable
  Then une estimation est calculée par calculerEstimation()
  And un bandeau permanent affiche "Estimation indicative, hors données DVF"
  And aucune mention de la source DVF n'apparaît sur la page ni dans le PDF

Scénario: Requête invalide, pas de retry
  Given l'API répond 422
  Then le front n'effectue aucun retry
  And le message d'erreur de validation est affiché sur le champ concerné
```

### US-6 — Départements non couverts par DVF
```gherkin
Scénario: Bien situé à Strasbourg (67)
  Given une adresse dont le code INSEE appartient au département 67
  When je demande une estimation
  Then l'API répond 200 avec dataCoverage = "no-dvf"
  And method.kind vaut "reference-table"
  And confidence est inférieure ou égale à 35
  And comparables est un tableau vide
  And le rapport et le PDF affichent la mention "Livre foncier" prévue au paragraphe 3.9
  And aucune mention "source DVF" n'apparaît pour cette estimation

Scénario: Bien situé à Mayotte (976)
  Then le comportement est identique au scénario précédent
```

### US-7 — Ingestion DVF idempotente
```gherkin
Scénario: Import initial
  Given une base vide
  When j'exécute "node ace dvf:import --year=2024 --dep=all"
  Then la table mutations contient les mutations bâties exploitables de 2024
  And dvf_imports enregistre une ligne par département avec statut "success", rows_read et rejected_counts

Scénario: Rejeu du même import
  When j'exécute exactement la même commande une seconde fois
  Then le nombre de lignes en base est strictement identique
  And aucune mutation n'est dupliquée

Scénario: Import concurrent
  Given un import déjà en cours
  When j'en lance un second sur le même périmètre
  Then le second s'arrête immédiatement avec un message explicite et un code de sortie non nul

Scénario: Dédoublonnage multi-lots
  Given une mutation DVF présente sur 4 lignes (4 lots d'un même immeuble)
  Then elle est comptée une seule fois
  And si elle porte plus d'un local bâti, elle est exclue de l'échantillon de valorisation
  And le motif d'exclusion est comptabilisé dans rejected_counts

Scénario: Mode simulation
  When j'exécute la commande avec --dry-run
  Then aucune écriture n'a lieu en base
  And le rapport de comptage (lignes lues, retenues, rejetées par motif) est affiché
```

### US-8 — Protection de l'endpoint public
```gherkin
Scénario: Dépassement de quota
  Given j'ai envoyé 10 requêtes POST /v1/estimations en moins d'une minute depuis la même IP
  When j'en envoie une onzième
  Then l'API répond 429 avec un en-tête Retry-After
  And le front affiche "Trop de demandes, réessayez dans N secondes" sans retenter

Scénario: Origine non autorisée
  Given une requête portant un en-tête Origin absent de la liste autorisée
  Then l'API répond 403 avec le code FORBIDDEN_ORIGIN

Scénario: Aucune donnée personnelle acceptée
  Given un payload contenant les champs name, email et phone
  When il est soumis à POST /v1/estimations
  Then l'API répond 422
  And aucune de ces valeurs n'est journalisée
```

### US-9 — Transparence de la source et de la date
```gherkin
Scénario: Mention systématique
  Given une estimation calculée à partir de DVF
  Then la page /rapport affiche "Source : Demandes de valeurs foncières (DGFiP), publiées le {date}, licence ouverte Etalab 2.0"
  And la même mention figure dans le PDF téléchargé
  And la date affichée provient de la réponse de l'API, jamais d'une valeur écrite en dur

Scénario: Avertissement légal
  Then chaque page et chaque PDF affichant un prix comporte la mention
       "Cette estimation automatisée ne constitue ni une expertise immobilière ni un avis de valeur engageant."
```

### US-10 — Pré-remplissage du DPE depuis l'ADEME (Lot 5)
```gherkin
Scénario: DPE trouvé pour l'adresse
  Given une adresse géocodée avec un identifiant BAN
  And l'observatoire ADEME contient un DPE en cours de validité pour cette adresse
  When j'arrive à l'étape 3 du wizard
  Then le champ DPE est pré-rempli avec la classe trouvée
  And un texte indique "Trouvé dans l'observatoire ADEME, vous pouvez le corriger"
  And la valeur reste modifiable

Scénario: Aucun DPE trouvé
  Then le champ reste vide et aucun message n'est affiché
  And le parcours est identique à l'existant
```

### US-11 — Non-régression du contrat `/rapport` (dépendance forte)
```gherkin
Scénario: Structure de lastEstimation.estimation préservée
  Given une estimation calculée par l'API
  Then lastEstimation.estimation contient toujours les clés prixM2, estimationMin, estimationMax et estimationMoyenne, de type number
  And rapport-report.js et pdf-report.js fonctionnent sans modification pour ces quatre valeurs
  And les nouvelles clés (confidence, comparables, range, method, dataSource) sont additionnelles

Scénario: Rapport ouvert avec un lastEstimation issu de l'ancienne version
  Given un localStorage contenant une estimation au format antérieur, sans confidence ni comparables
  When j'ouvre /rapport
  Then la page s'affiche sans erreur JavaScript
  And les blocs confiance et comparables sont simplement masqués
```

**Dépendances entre stories** : US-7 précède US-1 (pas de données, pas de calcul). US-1 précède US-2, US-3, US-4, US-9, US-11. US-5, US-6 et US-8 sont indépendantes de US-2/US-3/US-4. US-10 dépend de US-1 (géocodage) mais de rien d'autre.

---

## 5. Modèles de données

### 5.1 Schéma PostgreSQL (migrations Lucid)

> Extensions requises : `postgis`. Le conteneur `postgis/postgis:16-3.4` la fournit ; la première migration exécute `CREATE EXTENSION IF NOT EXISTS postgis;`.

**`communes`**
| Colonne | Type | Notes |
|---|---|---|
| `code_insee` | `char(5)` PK | |
| `nom` | `text` NOT NULL | |
| `codes_postaux` | `text[]` | index GIN |
| `code_departement` | `char(3)` NOT NULL | index |
| `code_region` | `char(2)` NOT NULL | |
| `code_epci` | `char(9)` NULL | index |
| `population` | `integer` | |
| `densite_grille` | `smallint` | grille de densité INSEE 1-7 |
| `centroid` | `geography(Point,4326)` NOT NULL | index GiST |
| `has_dvf` | `boolean` NOT NULL DEFAULT true | false pour 57/67/68/976 |

**`mutations`** — `PARTITION BY RANGE (date_mutation)`, une partition par année
| Colonne | Type | Notes |
|---|---|---|
| `id` | `bigserial` | PK composite `(id, date_mutation)` (contrainte du partitionnement) |
| `id_mutation` | `text` NOT NULL | identifiant DVF, unique par partition |
| `date_mutation` | `date` NOT NULL | clé de partitionnement |
| `nature_mutation` | `text` NOT NULL | filtré à `'Vente'` |
| `valeur_fonciere` | `numeric(12,2)` NOT NULL | |
| `type_local` | `text` NOT NULL | `'appartement' \| 'maison'` (normalisé) |
| `surface_bati` | `integer` NOT NULL | |
| `nb_pieces` | `smallint` | |
| `surface_terrain` | `integer` DEFAULT 0 | |
| `nb_locaux` | `smallint` NOT NULL DEFAULT 1 | > 1 → exclu à l'ingestion |
| `code_insee` | `char(5)` NOT NULL | |
| `code_departement` | `char(3)` NOT NULL | |
| `adresse_voie` | `text` | **sans le numéro** (voir §8) |
| `code_postal` | `char(5)` | |
| `longitude`, `latitude` | `double precision` NOT NULL | |
| `geom` | `geography(Point,4326)` NOT NULL | `ST_SetSRID(ST_MakePoint(lon,lat),4326)` |
| `prix_m2` | `numeric(10,2)` GENERATED ALWAYS AS `(valeur_fonciere / surface_bati)` STORED | |
| `source_annee` | `smallint` NOT NULL | millésime du fichier |
| `imported_at` | `timestamptz` NOT NULL | |

Index :
- `GIST (geom)` — **le plus important**
- `BTREE (type_local, surface_bati)`
- `BTREE (code_insee, type_local, date_mutation DESC)`
- `BTREE (code_departement, date_mutation DESC)`
- Index partiel : `GIST (geom) WHERE prix_m2 BETWEEN 200 AND 25000`
- `UNIQUE (id_mutation, date_mutation)`

**`mutations_terrain`** — même structure, `type_local = 'terrain'`, `surface_bati` NULL, `prix_m2` calculé sur `surface_terrain`.

**`indices_prix`**
`(id, code_region char(2) | 'FR', type_bien, trimestre date, indice numeric(8,3), base_100 text, source_label, source_url, published_at)` — unique `(code_region, type_bien, trimestre)`.

**`coefficients_reference`**
`(id, cle text, type_bien text, valeur numeric(6,4) NOT NULL, source_label text NOT NULL, source_url text NOT NULL, date_source date NOT NULL, densite_min smallint, densite_max smallint, actif boolean)` — unique `(cle, type_bien, densite_min, densite_max) WHERE actif`.
Contient : `dpe.A`…`dpe.G`, `etat.to-renovate`…, `etage.*`, `exterieur.*`, `surface.alpha`, `terrain.fallback_ratio`. **`source_label` et `source_url` sont NOT NULL : un coefficient sans source ne peut pas exister.**

**`references_departementales`** (repli §3.9)
`(code_departement char(3) PK, type_bien, prix_m2 numeric, source_label NOT NULL, source_url, date_source, note text)`.

**`geocode_cache`**
`(query_hash char(64) PK, query text, label text, code_insee char(5), longitude, latitude, geom geography(Point,4326), score numeric(4,3), result_type text, provider text DEFAULT 'ban', fetched_at timestamptz, expires_at timestamptz)` — index sur `expires_at`.

**`dvf_imports`**
`(id, source_url, annee smallint, code_departement char(3), etag text, sha256 char(64), rows_read bigint, rows_kept bigint, rejected_counts jsonb, status text, error text, started_at, finished_at)`.

**`estimations_log`** (anonymisé, rétention 12 mois)
`(id, created_at, code_insee, code_departement, type_bien, surface, method_kind, method_level, radius_m, n_comparables, confidence, value_low, value_mid, value_high, price_m2, duration_ms, ip_hmac char(64), ua_hash char(64), api_version)`.
**Aucune adresse complète, aucun numéro de voie, aucune donnée personnelle.** Purge automatique par tâche planifiée.

**Vue matérialisée `agg_commune_type`**
`(code_insee, type_local, tranche_surface, n, p25, mediane, p75, date_max, refreshed_at)` — tranches de 20 m². Alimente `GET /v1/marche/:codeInsee`, les pages SEO départementales et le repli rapide. Rafraîchie en fin d'import (`REFRESH MATERIALIZED VIEW CONCURRENTLY`).

### 5.2 Modèles Lucid

`app/models/` : `Commune`, `Mutation`, `MutationTerrain`, `IndicePrix`, `CoefficientReference`, `ReferenceDepartementale`, `GeocodeCacheEntry`, `DvfImport`, `EstimationLog`.
Note : les requêtes de comparables passent par **SQL brut / query builder** (fonctions PostGIS non exprimables en ORM) ; le modèle Lucid `Mutation` sert au CRUD d'administration et aux tests, pas au chemin chaud.

### 5.3 DTO de réponse — `EstimationResult`

```ts
/** Réponse de POST /v1/estimations (api-version: 1). */
export interface EstimationResult {
  apiVersion: 1;
  requestId: string;                     // uuid, tracé dans les logs, affiché en cas d'erreur

  /** Valeur centrale. `null` si method.kind === 'not-supported'. */
  value: number | null;
  pricePerSqm: number | null;

  range: {
    low: number;
    high: number;
    halfWidthPct: number;                // `a` du §3.7, ex. 0.14
    basis: 'iqr' | 'fixed';              // 'fixed' uniquement en repli sans comparables
  };

  confidence: {
    score: number;                       // 0-100
    label: 'high' | 'medium' | 'low' | 'insufficient';
    breakdown: {
      count: number; proximity: number; freshness: number; dispersion: number; penalties: number;
    };
  };

  /** Ce que le front DOIT afficher — décidé côté API, jamais recalculé côté front. */
  display: {
    showCentralValue: boolean;
    confidenceLabelFr: string;           // "Confiance élevée" …
    warnings: string[];                  // messages prêts à afficher, en français
  };

  method: {
    kind: 'comparables' | 'reference-table' | 'not-supported';
    level: 'radius' | 'commune' | 'epci' | 'departement' | 'region' | 'national' | 'departement-reference';
    radiusM: number | null;
    windowMonths: number;
    surfaceTolerancePct: number;         // 30 ou 40
    comparablesCount: number;
    comparablesRejected: Record<string, number>;
    medianPriceM2Raw: number | null;     // médiane pondérée avant coefficients
    timeAdjustmentFactor: number;        // médiane des facteurs appliqués
    coefficients: {
      surface: number; floor: number; outdoor: number; condition: number; dpe: number;
      total: number; clamped: boolean;
    };
    landValue: number;                   // V_terrain, 0 si non applicable
  };

  location: {
    label: string;                       // libellé BAN retenu
    cityCode: string;                    // INSEE
    city: string;
    postcode: string;
    lon: number; lat: number;
    geocodePrecision: 'exact' | 'approximate' | 'city-centroid';
  };

  /** Comparables anonymisés — jamais de numéro de voie, distance arrondie. */
  comparables: Array<{
    street: string;                      // "Rue de la Paix"
    city: string;
    distanceM: number;                   // arrondi au multiple de 50
    date: string;                        // "2024-06" (mois, jamais le jour)
    propertyType: 'appartement' | 'maison';
    surface: number;
    rooms: number | null;
    pricePerSqm: number;                 // arrondi à la dizaine
    price: number;                       // arrondi au millier
    timeAdjustedPricePerSqm: number;
  }>;

  dataSource: {
    dataCoverage: 'dvf' | 'no-dvf';
    primary: 'DVF';                      // ou 'REFERENCE'
    dvfPublicationDate: string;          // "2025-10-01"
    lastImportAt: string;                // ISO
    priceIndexQuarter: string | null;    // "2025-T2"
    licence: 'Licence Ouverte / Etalab 2.0';
    attributionFr: string;               // phrase complète prête à afficher
    disclaimerFr: string;                // avertissement légal prêt à afficher
  };

  computedAt: string;                    // ISO
}
```

### 5.4 Contrat `lastEstimation` côté front — **non-régression obligatoire**

`rapport-report.js` (l.101-111) et `pdf-report.js` lisent `estimation.prixM2`, `estimation.estimationMin`, `estimation.estimationMax`, `estimation.estimationMoyenne`. **Ces quatre clés doivent être conservées à l'identique** (nombres, arrondis). On enrichit sans casser :

```js
lastEstimation = {
  ...payloadExistant,                       // inchangé (specs/estimation-wizard.md §3.2)
  estimationStatus: 'ok' | 'deferred' | 'static-fallback',
  estimation: {
    // --- contrat historique, inchangé ---
    prixM2: number,
    estimationMin: number,       // = range.low
    estimationMax: number,       // = range.high
    estimationMoyenne: number,   // = value
    // --- ajouts, tous optionnels côté lecteurs ---
    confidence, range, method, comparables, location, dataSource, computedAt, apiVersion,
  } | null,                                  // null si estimationStatus === 'deferred'
};
```
Tous les consommateurs doivent tolérer `estimation === null` et l'absence des nouvelles clés (US-11).

---

## 6. Contrats d'interface

### 6.1 Endpoints REST

Base : `https://api.estimer.co`. Versionnement par préfixe `/v1` ; **tout changement cassant crée `/v2`**, l'ancienne version reste servie 6 mois.

---

#### `POST /v1/estimations`

Requête (`Content-Type: application/json`) — validée par **VineJS** :

| Champ | Type | Règle |
|---|---|---|
| `address` | string | requis, `minLength(3)`, `maxLength(200)`, `trim()` |
| `postalCode` | string | requis, `regex(/^\d{5}$/)` |
| `city` | string | requis, `minLength(1)`, `maxLength(100)` |
| `propertyType` | enum | requis : `appartement \| maison \| terrain \| local-commercial` |
| `surface` | number | requis, `min(9)`, `max(1000)` (`min(1)`/`max(100000)` si `terrain`) |
| `rooms` | number | requis si bâti, entier, `min(1)`, `max(30)` |
| `dpe` | enum | requis : `A..G \| unknown` |
| `floor` | number | optionnel, entier, `min(0)`, `max(50)` |
| `hasElevator` | boolean | optionnel |
| `outdoor` | enum | optionnel : `none \| balcony \| terrace \| garden` |
| `condition` | enum | optionnel : `to-renovate \| fair \| good \| new` |
| `terrainSize` | number | optionnel, `min(0)`, `max(100000)` |
| `lat`, `lon` | number | optionnels, `min/max` France + DOM ; si fournis et cohérents avec `postalCode`, le géocodage BAN est court-circuité |

**Champs interdits** : `name`, `email`, `phone`, ou tout champ non déclaré → `422` (VineJS en mode strict, pas de passthrough).

Réponses :

| Code | Corps | Cas |
|---|---|---|
| **200** | `EstimationResult` | Succès, y compris repli `no-dvf` et `not-supported` |
| **403** | `{ code: 'FORBIDDEN_ORIGIN', message }` | Origin absente ou hors liste (production) |
| **422** | `{ code: 'VALIDATION_ERROR', errors: [{ field, rule, message }] }` | Payload invalide. `message` en **français**, directement affichable |
| **429** | `{ code: 'RATE_LIMITED', message, retryAfter: number }` + `Retry-After` | Quota dépassé |
| **503** | `{ code: 'DATA_UNAVAILABLE', message }` | Base vide, import en cours bloquant, ou dépendance critique indisponible |
| **500** | `{ code: 'INTERNAL_ERROR', requestId }` | Erreur inattendue. **Jamais de trace ni de message SQL exposé** |

En-tête de réponse `X-Data-Version: dvf-2025-10` sur toutes les réponses 200.

---

#### `GET /v1/geocode?q={texte}&postcode={cp}`
Proxy caché de la BAN (évite au front de dépendre du CORS BAN et mutualise le cache).
`200` → `{ label, cityCode, city, postcode, lon, lat, score, precision, hasDvf }`
`404` → `{ code: 'NOT_FOUND' }` — `429`, `503` idem ci-dessus.

#### `GET /v1/marche/{codeInsee}?type=appartement`
Statistiques de marché issues de `agg_commune_type` : `{ cityCode, city, type, samples: [{ surfaceBand, n, p25, median, p75 }], median, evolution12mPct, lastTransactionDate, dataSource }`.
Alimente le bloc « marché local » de `/rapport` (aujourd'hui inventé à partir de seuils sur `prixM2` dans `rapport-report.js` l.122-156 — **à remplacer**) et, à terme, les pages départementales SEO.
`404` si code INSEE inconnu.

#### `GET /v1/meta/data-version`
`{ dvfPublicationDate, lastImportAt, coveredDepartmentsCount, missingDepartments: ['57','67','68','976'], priceIndexQuarter, coefficientsUpdatedAt, licence, attributionFr }`
Consommé **au build Astro** (mention légale figée dans les pages statiques) **et au runtime** (rapport).

#### `GET /health`
`{ status: 'ok'|'degraded', db: boolean, mutationsCount: number, lastImportAt }` — readiness/liveness Coolify. Hors rate limiting, hors CORS.

### 6.2 Modules internes de l'API

```ts
// app/services/geocoding_service.ts
geocode(input: { address: string; postalCode: string; city: string }): Promise<GeocodeResult>
// Cache -> BAN -> centroïde commune. Ne rejette jamais : retourne toujours un GeocodeResult
// avec `precision: 'city-centroid'` en dernier recours.

// app/services/comparables_service.ts
findComparables(criteria: ComparablesCriteria): Promise<ComparablesSet>
// ComparablesSet = { level, radiusM, windowMonths, surfaceTolerancePct, items: RawComparable[], rejected: Record<string, number> }
// Implémente la cascade §3.2 et l'écrêtage §3.3. Seul module qui touche PostGIS.

// app/services/price_index_service.ts
adjustToToday(pricePerSqm: number, mutationDate: Date, regionCode: string, propertyType: string): number
getCurrentQuarter(): string

// app/services/valuation_service.ts  ← CŒUR MÉTIER, FONCTION PURE
computeValuation(input: ValuationInput): ValuationOutput
// ValuationInput = { property, comparables: AdjustedComparable[], coefficients: CoefficientTable,
//                    geocodePrecision, level, radiusM, windowMonths, landPricePerSqm }
// AUCUN accès base, AUCUN appel réseau, AUCUNE horloge implicite (la date est passée en paramètre).
// C'est ce module qui porte §3.5 à §3.8 et qui doit être couvert à 100 % par des tests unitaires.

// app/services/estimation_service.ts
estimate(request: EstimationRequest): Promise<EstimationResult>
// Orchestrateur : géocodage -> comparables -> indices -> computeValuation -> DTO + cache + log.

// commands/dvf_import.ts        node ace dvf:import --year= --dep= --source= --dry-run --force
// commands/indices_import.ts    node ace indices:import
// commands/dpe_import.ts        node ace dpe:import --since=      (Lot 5)
// commands/refresh_aggregates.ts
// commands/purge_logs.ts        rétention 12 mois
```

**Règle d'architecture non négociable** : `valuation_service` est **pur et testable sans base ni réseau**. C'est la condition pour pouvoir recalibrer, backtester (Lot 7) et faire réviser les formules sans monter une infrastructure.

### 6.3 Module front à créer

`src/scripts/estimation-api.js` — injecté via `RawScript.astro`, **sans `import`/`export`** (contrainte du projet : pas de bundler, tout en portée globale, cf. en-tête de `estimation-wizard.js`), chargé **avant** `estimation-ui.js`.

```js
/**
 * @typedef {{status:'ok'|'deferred'|'rate-limited'|'invalid', result:object|null, errors:object|null}} EstimationApiResponse
 */

/** Construit le payload API à partir de wizard.state.data. Fonction pure. Ne transmet JAMAIS name/email/phone. */
function buildEstimationApiPayload(data) {}

/** Appelle POST /v1/estimations. timeout 6 s, 1 retry sur réseau/5xx uniquement. Ne rejette jamais. */
function requestEstimation(payload, options) {} // -> Promise<EstimationApiResponse>

/** Mappe un EstimationResult vers le contrat historique `estimation` (§5.4). Fonction pure. */
function mapApiResultToLegacyEstimation(result) {}

/** Décide du statut final à écrire dans lastEstimation. Fonction pure. */
function resolveEstimationStatus(apiResponse, config) {} // -> 'ok'|'deferred'|'static-fallback'
```

Tests : `scripts/test-estimation-api.mjs`, même technique `vm.Script#runInThisContext()` que `scripts/test-estimation-wizard.mjs`, exécuté par `node --test`. Ajouter `"test:estimation-api"` dans `package.json` et un script `"test"` agrégateur.

### 6.4 Variables d'environnement de l'API

```
NODE_ENV, PORT=3333, APP_KEY, HOST=0.0.0.0, LOG_LEVEL
DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_DATABASE
CORS_ORIGINS=https://estimer.co,https://www.estimer.co,http://localhost:4322
TRUSTED_PROXY=10.0.0.0/8
BAN_API_URL=https://api-adresse.data.gouv.fr
DVF_BASE_URL=https://files.data.gouv.fr/geo-dvf/latest/csv
ADEME_API_URL=https://data.ademe.fr/data-fair/api/v1/datasets
IP_HASH_SALT=              # sel HMAC pour estimations_log, jamais commité
ESTIMATION_CACHE_TTL=86400
RATE_LIMIT_ESTIMATION=10/1m
```

---

## 7. Interface utilisateur

### 7.1 Wizard (`/estimation`)

**Étape 3 — nouveaux champs, tous optionnels** (ne pas dégrader la conversion : le wizard actuel convertit avec 3 champs requis, on n'en ajoute aucun d'obligatoire) :

| Champ | Contrôle | Conditionnel |
|---|---|---|
| `floor` — Étage | `<input type="number" min="0" max="50">` | visible si `propertyType === 'appartement'` |
| `hasElevator` — Ascenseur | `<select>` Oui / Non / Je ne sais pas | visible si `propertyType === 'appartement'` |
| `outdoor` — Extérieur | `<select>` Aucun / Balcon / Terrasse / Jardin privatif | visible si bâti |
| `condition` — État général | `<select>` À rénover / Correct / Bon / Refait à neuf | visible si bâti |

**Impératif d'implémentation** : ces règles de visibilité vont dans `WIZARD_STEPS[].conditionalFields` (`estimation-wizard.js` §1) — **source unique de vérité**, jamais redéclarées dans `estimation-ui.js` (`computeConditionalVisibility` délègue déjà à `isFieldVisible`).

Libellé d'aide sous le groupe : « Facultatif, mais chaque précision resserre la fourchette. »

**Écran de soumission** — l'appel API a lieu pendant l'envoi :
| État | Affichage |
|---|---|
| `loading` | Bouton désactivé, « Analyse des transactions réelles autour de votre bien… » + indicateur de progression indéterminé. Message secondaire après 2,5 s : « Nous consultons les ventes des 24 derniers mois. » |
| `success` | Redirection `/rapport/` (comportement actuel) |
| `rate-limited` | Message `role="alert"` : « Trop de demandes depuis votre connexion. Réessayez dans N secondes. » Bouton réactivé, **pas de redirection**, pas de retry automatique |
| `invalid` (422) | Erreurs reportées champ par champ, retour à l'étape concernée, focus sur le premier champ invalide (mécanique US-9 du wizard existant) |
| `deferred` | Lead envoyé, redirection `/rapport/` en mode différé |

### 7.2 Page `/rapport`

Blocs modifiés / ajoutés :

1. **Bloc prix** (existant, `#estimationMoyenne` / `#estimationMin` / `#estimationMax` / `#prixM2`) : structure conservée. Ajout sous la fourchette : « Fourchette calculée à partir de la dispersion de **N** ventes réelles » et suppression de toute mention de ±10 %.
2. **Nouveau — Jauge de confiance** : barre 0-100 + libellé + pictogramme, avec un lien « Comment est-elle calculée ? » ouvrant un `<details>` détaillant `confidence.breakdown`. Respecter `prefers-reduced-motion` (règle déjà présente en fin de `global.css`) — pas d'animation de remplissage.
3. **Nouveau — Transactions comparables** : tableau des 5 plus proches (voie, distance, mois/année, type, surface, €/m²). En-tête « Ventes réelles enregistrées par la DGFiP ». État vide explicite si `comparables.length === 0`.
4. **Nouveau — Méthodologie** (`<details>` replié) : niveau géographique retenu, rayon, période, tolérance de surface, facteur d'ajustement temporel, coefficients appliqués un par un avec leur source, mention `clamped` le cas échéant.
5. **Marché local** (`#cityAnalysis`) : remplacer les seuils inventés de `rapport-report.js` (l.122-156 : `delaiVenteMoyen`, `evolutionAnnuelle`, `tauxNegociation`, `prixMaisonM2 = prixM2 × 0,85`…) par les données de `GET /v1/marche/:codeInsee`. **Tout indicateur non sourcé est supprimé** — pas remplacé par une autre valeur inventée. Le délai de vente et le taux de négociation, absents de DVF, sont retirés au Lot 3 (à réintroduire seulement si une source est identifiée).
6. **Carte** (`#propertyMap`) : ajouter les marqueurs des comparables, **positionnés au centre de la voie et non à l'adresse exacte**, sans étiquette d'adresse.
7. **Nouveaux états de page** :
   - `deferred` : bloc prix remplacé par « Estimation en cours de préparation », explication, délai annoncé, CTA contact en action principale.
   - `no-dvf` : bandeau Livre foncier (§3.9) au-dessus du bloc prix.
   - `insufficient` (confiance < 30) : valeur centrale masquée, fourchette seule.
   - `static-fallback` : bandeau « Estimation indicative, hors données DVF », aucune mention de source DVF.
8. **Bandeau source**, permanent, sous le bloc prix : `dataSource.attributionFr` + `dataSource.disclaimerFr`.

### 7.3 PDF (`pdf-report.js`)

En s'appuyant sur les primitives existantes (`pdfHeading`, `pdfParagraph`, `pdfStatBand`, `pdfDataGrid`, `pdfNote`) :
- `pdfEstimationBlock` : ajouter l'amplitude réelle sous la barre min/max et un ruban de confiance à droite de la valeur.
- **Nouvelle section `pdfComparablesSection`** : tableau des 5 comparables via `pdfDataGrid`.
- **Nouvelle section `pdfMethodologySection`** : niveau, rayon, période, coefficients et leurs sources.
- `pdfNationalSection` : les affirmations en dur sur le DPE (« surcote pouvant atteindre 15 % », `/rapport` l.107-112 et section équivalente du PDF) doivent être **alignées sur `coefficients_reference` et porter leur source**, ou supprimées.
- `pdfPaintFooters` : ajouter en pied de chaque page « Source : DVF (DGFiP), {date} — Licence ouverte Etalab 2.0 ».
- Le PDF applique **exactement** les mêmes règles d'affichage que la page (`display.showCentralValue`, bandeaux, avertissements) : `/pdf-preview/` doit couvrir les 4 états (`ok`, `low-confidence`, `no-dvf`, `deferred`).

### 7.4 Autres pages

`/carte` consomme `src/data/prix.ts` (valeurs 2025 en dur). **Hors scope de cette spec**, mais l'incohérence devient visible dès que `/rapport` affiche des chiffres DVF. À traiter au **Lot 8** : alimenter `/carte` depuis un export statique généré au build à partir de `GET /v1/marche` agrégé par département — ce qui supprime enfin la double source de vérité signalée dans `estimation-wizard.js` l.324-328.

---

## 8. Transparence et conformité

### 8.1 Mentions obligatoires

Partout où un prix issu de DVF est affiché (page `/rapport`, PDF, e-mail interne) :

> **Source** : Demandes de valeurs foncières (DVF), Direction générale des finances publiques, publiées le {dvfPublicationDate}, mises à jour dans notre base le {lastImportAt}. Données diffusées sous **Licence Ouverte / Open Licence version 2.0 (Etalab)**. Géocodage : Base Adresse Nationale. Ajustement temporel : indice Insee-Notaires des prix des logements anciens, {priceIndexQuarter}.

Et, sans exception :

> **Cette estimation automatisée ne constitue ni une expertise immobilière, ni un avis de valeur au sens de la Charte de l'expertise en évaluation immobilière. Elle repose sur des transactions comparables et ne tient compte ni de l'état intérieur réel du bien, ni de ses spécificités (vue, exposition, nuisances, servitudes, travaux votés en copropriété). Seule une visite sur place permet une évaluation engageante.**

Ces deux textes proviennent de `dataSource.attributionFr` / `dataSource.disclaimerFr` — **jamais écrits en dur dans le front**, pour que la date reste juste sans redéploiement.

### 8.2 Obligations de la Licence Ouverte Etalab 2.0

1. **Paternité** : mentionner la source et la date de la dernière mise à jour → couvert par 8.1.
2. Réutilisation commerciale autorisée, y compris modification — mais l'obligation de paternité est ferme.
3. Ne pas laisser croire que la DGFiP cautionne notre estimation : formuler « calculée **à partir de** DVF », jamais « estimation officielle DGFiP ».
4. Indiquer clairement quand une donnée n'est **pas** issue de DVF : cas `no-dvf` (§3.9) et `static-fallback` (§2.4).

### 8.3 RGPD

| Sujet | Traitement |
|---|---|
| **Données transmises à l'API** | Adresse, code postal, ville, caractéristiques du bien. **Aucune donnée d'identification directe** (nom, e-mail, téléphone restent côté front / EmailJS). L'adresse d'un bien reste une donnée à caractère personnel dès qu'elle est reliable à une personne : elle n'est donc **jamais journalisée en clair** — `estimations_log` ne conserve que le code INSEE. |
| **Journalisation** | `ip_hmac` = HMAC-SHA256(IP, `IP_HASH_SALT`) — jamais l'IP en clair. Rétention **12 mois**, purge automatisée (`node ace purge:logs`, cron quotidien). |
| **Cache de géocodage** | Contient des adresses. TTL 90 jours, purge automatique. Justification : intérêt légitime (performance, respect des limites d'usage d'un service public). À inscrire au registre des traitements. |
| **Données DVF** | Données publiques, non nominatives (DVF ne diffuse ni le nom des vendeurs ni celui des acquéreurs). **Nous n'ingérons pas le numéro de voie** dans `mutations.adresse_voie`, et nous n'affichons ni le numéro ni le jour exact de la mutation : à l'échelle d'une petite commune, numéro + date exacte + prix rendraient un vendeur identifiable. Distances arrondies à 50 m, dates au mois, prix arrondis. |
| **Documents à mettre à jour** | Politique de confidentialité (nouveau sous-traitant : hébergeur de l'API ; nouvelle finalité : calcul d'estimation), mentions légales (sources de données), registre des traitements. |
| **Dette existante** | `localStorage.estimationDatabase` conserve nom/e-mail/téléphone sans expiration (déjà signalé `specs/estimation-wizard.md` §3.3). **Toujours hors scope**, mais la dette s'aggrave à mesure que le produit gagne du trafic — à planifier. |

### 8.4 Qualité et honnêteté du chiffre

- **Aucun coefficient sans source** : contrainte `NOT NULL` sur `coefficients_reference.source_label` / `source_url`.
- **Aucun indicateur inventé** dans le rapport : ceux qui ne peuvent pas être sourcés sont supprimés, pas remplacés (§7.2 point 5).
- **Backtest obligatoire avant mise en production** (Lot 7, critère de sortie) : sur un échantillon de 5 000 mutations retirées de l'apprentissage, **MAPE (erreur absolue moyenne en pourcentage) cible ≤ 15 %** et **taux de couverture de la fourchette ≥ 80 %** (la valeur réelle tombe dans `[low, high]` 4 fois sur 5). Si ces seuils ne sont pas atteints, la spec doit être révisée avant d'exposer le calcul au public.

---

## 9. Lots livrables (MoSCoW)

### Lot 0 — Socle d'infrastructure `api/` — **MUST**
Squelette AdonisJS 6 (`api/`), Dockerfile, service Coolify + PostgreSQL 16/PostGIS, migration `CREATE EXTENSION postgis`, CORS (§2.5), `@adonisjs/limiter` (§2.6), `GET /health`, `GET /v1/meta/data-version` (renvoyant un état vide), CI `api.yml`, filtrage du workflow front sur `api/**`, `PUBLIC_API_URL` dans `.env.example` et `src/lib/config.ts`.
**Valeur** : débloque tout le reste ; aucune valeur utilisateur directe.
**Risque** : *moyen* — mise en place Coolify, TLS, sauvegardes, secrets. Risque principal : PostGIS mal provisionné (utiliser l'image `postgis/postgis`, ne pas tenter d'ajouter l'extension à une image `postgres` nue).

### Lot 1 — Ingestion DVF + référentiel communal + géocodage — **MUST**
Tables `communes`, `mutations` (partitionnée), `mutations_terrain`, `dvf_imports`, `geocode_cache`. Commande `dvf:import` complète (téléchargement, COPY en staging, dédoublonnage multi-lots, écrêtage, swap de partition, idempotence, `--dry-run`, verrou concurrent). Import du COG INSEE + centroïdes + drapeau `has_dvf`. `GeocodingService` + `GET /v1/geocode`. Cron mensuel de vérification d'ETag.
**Valeur** : la donnée existe et est requêtable — c'est le vrai actif du produit.
**Risque** : *élevé* — volumétrie (2,5-3,5 M mutations retenues, plusieurs Go), durée d'import, qualité du dédoublonnage. **Mitigation** : démarrer sur 2 départements contrastés (75 et 23), valider les comptages contre l'explorateur DVF officiel, puis généraliser.

### Lot 2 — Moteur de valorisation + `POST /v1/estimations` — **MUST**
`ComparablesService` (cascade PostGIS §3.2, écrêtage §3.3), `ValuationService` **pur** (§3.5-3.8), `coefficients_reference` + `references_departementales` semées avec leurs sources, repli Alsace-Moselle/Mayotte (§3.9), validation VineJS, cache applicatif, `estimations_log`, DTO complet. Tests Japa + tests unitaires exhaustifs du module pur.
**Valeur** : le cœur de la promesse produit.
**Risque** : *élevé* — justesse des formules et performance des requêtes spatiales. **Mitigation** : `EXPLAIN ANALYZE` systématique sur les 9 niveaux de cascade ; jeu de 30 cas de référence gelés (« golden tests ») ; le module pur est révisable sans base.

### Lot 3 — Intégration front + rapport — **MUST**
`src/scripts/estimation-api.js` + tests `node --test`, câblage dans `estimation-ui.js`, mode dégradé §2.4, nouveaux champs optionnels de l'étape 3, refonte des blocs de `/rapport` (confiance, comparables, méthodologie, marché local sourcé), bandeaux source et avertissement, sections PDF, 4 états couverts par `/pdf-preview/`.
**Valeur** : le bénéfice devient visible pour l'utilisateur et pour le SEO.
**Risque** : *moyen* — régression sur `/rapport` et le PDF (contrat `lastEstimation`, US-11). **Mitigation** : conserver strictement les 4 clés historiques ; tester avec un `lastEstimation` d'ancienne génération.

### Lot 4 — Ajustement temporel (indice Insee-Notaires) — **SHOULD**
`indices_prix`, commande `indices:import`, `PriceIndexService`, exposition dans la méthodologie.
**Valeur** : corrige un biais systématique (une transaction de 2022 vaut mécaniquement moins qu'aujourd'hui) — plusieurs points d'erreur gagnés.
**Risque** : *faible* — petit volume, format stable. Peut être livré après le Lot 3 sans le bloquer (facteur = 1 en attendant).

### Lot 5 — ADEME : pré-remplissage DPE + calibration de la valeur verte — **SHOULD**
Commande `dpe:import` (ou requête API à la volée avec cache), pré-remplissage du champ DPE dans le wizard (US-10), jointure DVF × DPE sur `ban_id`, recalcul des coefficients `k_dpe` **par strate de densité**, mise à jour de `coefficients_reference` avec la mention « calibré sur nos données, {date} ».
**Valeur** : double — UX (une friction majeure du formulaire disparaît) et justesse (fin des coefficients DPE d'emprunt).
**Risque** : *moyen* — taux d'appariement adresse DVF ↔ DPE incertain. **Mitigation** : passer par `ban_id` des deux côtés ; si l'appariement est trop faible (< 20 %), livrer uniquement le pré-remplissage et conserver les coefficients de référence sourcés.

### Lot 6 — Observabilité et pilotage qualité — **SHOULD**
Tableau de bord interne : volume d'estimations, distribution des niveaux de cascade, distribution de la confiance, part d'estimations `deferred`, temps de réponse, échecs d'import. Alerte si `p95 > 1,5 s`, si `deferred > 2 %` sur 24 h, ou si un import échoue.
**Valeur** : sans cela, une dérive de qualité est invisible.
**Risque** : *faible*.

### Lot 7 — Backtest et recalibration — **SHOULD** (critère de sortie du Lot 2, cf. §8.4)
Commande `valuation:backtest` : rejoue l'estimation sur 5 000 mutations retirées de l'échantillon, mesure MAPE, taux de couverture de la fourchette, biais par strate (densité, type, tranche de prix). Ajustement de `α`, du facteur `0,5` de la fourchette, des poids et des seuils de confiance.
**Valeur** : la seule preuve objective que le nouvel algorithme est meilleur que l'ancien.
**Risque** : *moyen* — peut révéler que des paramètres doivent être revus. C'est précisément l'objectif : mieux le savoir avant les utilisateurs.

### Lot 8 — Enrichissements — **COULD**
Contours IRIS (comparables intra-quartier en zone dense), cadastre (surface de terrain vérifiée), carte interactive des comparables, `local-commercial` (nécessite une autre source), alimentation de `/carte` depuis l'API (fin de la double source de vérité), DV3F sous convention Cerema.
**Valeur** : précision marginale et cohérence du site.
**Risque** : *variable*, aucun blocage.

### **WON'T** (explicitement hors périmètre)
Modèle de machine learning (aucune donnée propriétaire, non explicable — or l'explicabilité est un argument commercial), scraping d'annonces (illégal/fragile, et une annonce n'est pas une vente), API d'estimation payantes tierces (coût récurrent et dépendance), authentification utilisateur, espace client.

---

## 10. Décisions tranchées

| Question | Décision | Motif |
|---|---|---|
| Architecture | **API AdonisJS 6 + PostGIS séparée** | Décision client. Volume, index spatial, fraîcheur (§2.1) |
| Repli si l'API est indisponible | **Pas de prix affiché** (mode « estimation différée »), lead conservé | Ne jamais afficher un chiffre faux sous une mention de source réelle. Le lead est la valeur business (§2.4) |
| Repli statique `calculerEstimation()` | **Conservé mais désactivé par défaut**, derrière `PUBLIC_ESTIMATION_FALLBACK=static` | Utile en démo/preview ; jamais en production |
| Moyenne ou médiane | **Médiane pondérée** | Distribution asymétrique, robustesse aux extrêmes (§3.5) |
| Sélection des comparables | **Rayon géographique réel** (500 m → 5 km) puis cascade administrative | Une commune n'est pas un marché homogène (§3.2) |
| Fourchette | **Dérivée de l'IQR observé**, bornée à ±4 % / ±25 % | Le ±10 % fixe ne veut rien dire (§3.7) |
| Confiance < 30 | **Valeur centrale non affichée** | Mieux vaut assumer l'ignorance que produire un chiffre non défendable (§3.8) |
| Alsace-Moselle et Mayotte | **Repli départemental sourcé, confiance ≤ 35, mention Livre foncier obligatoire** | DVF ne les couvre pas ; le silence serait trompeur (§3.9) |
| `local-commercial` | **Non calculé** au Lot 1-3 → estimation différée | DVF renseigne trop mal ce segment (§3.2) |
| PII sur l'API | **Aucune** — nom/e-mail/téléphone restent côté front | Minimisation RGPD, surface d'attaque nulle (§2.6) |
| CAPTCHA | **Non au Lot 1** | Friction disproportionnée sur le tunnel de conversion ; rate limiting + cache suffisent au volume actuel |
| Nouveaux champs du wizard | **Tous optionnels** | Ne pas dégrader une conversion qui fonctionne avec 3 champs requis |
| Coefficients | **En base, avec source obligatoire** | Auditables, recalibrables sans déploiement, jamais inventés |
| Fréquence d'import DVF | **Vérification mensuelle de l'ETag, import si changement** (publication réelle : avril et octobre) | Robuste à un décalage de calendrier |

## 11. Questions ouvertes (réponse requise avant le Lot 2)

1. **Sources pour l'Alsace-Moselle et Mayotte** : dispose-t-on d'un accès à des références notariales locales, ou assume-t-on `src/data/prix.ts` étiqueté « estimation interne, hors DVF » ? *(bloque §3.9)*
2. **Seuil de confiance masquant la valeur centrale** : 30 est un choix de PO. Le validez-vous commercialement, sachant qu'il rend visible le fait que l'on ne sait pas ? *(bloque §3.8)*
3. **Suppression des indicateurs non sourcés** de `/rapport` (délai de vente, marge de négociation) : accepté, ou faut-il chercher une source avant de les retirer ? *(bloque §7.2)*
4. **Budget d'infrastructure** : une base de 6-10 Go avec sauvegardes quotidiennes et un service Node — quelle enveloppe mensuelle est validée sur Coolify ?
5. **Rétention de `estimations_log`** : 12 mois convient-il, ou faut-il aligner sur la politique de rétention générale du site (à définir) ?

---

# Annexe A — Précisions d'ingestion et d'indexation (2e passe PO)

> Ces précisions **complètent et corrigent** les §5.1, §6.2 et §3.2. En cas de contradiction avec le corps du document, **l'annexe fait foi**.

## A.1 Dédoublonnage multi-lots — règle corrigée

Le §6.2 disait « exclure les mutations portant plus d'un local bâti ». **C'est trop brutal** : en DVF, une vente d'appartement avec cave et parking produit 3 lignes (`type_local` 2, 3, 3). Rejeter ces mutations écarterait une part majeure du marché urbain.

Règle correcte, appliquée après regroupement par `id_mutation` :

| Cas | Traitement |
|---|---|
| Plusieurs locaux **bâtis de types différents** (maison + appartement, bâti + local commercial) | **Mutation écartée** — `exclusion_reason = 'multi_type'`. La valeur foncière n'est pas répartissable, le €/m² serait faux. |
| Plusieurs lots du **même type** (2 appartements d'un même immeuble) | **Conservée** : `surface_reelle_bati` et `nombre_pieces_principales` **sommés**, une seule ligne, `nombre_lots = N`. |
| **Dépendances** (`type_local = 3` : cave, garage, parking) accompagnant un bâti | **Exclues de la somme des surfaces**, mais **ne provoquent pas le rejet** de la mutation. Tracées via `nombre_lots`. |
| `valeur_fonciere` | Répétée à l'identique sur toutes les lignes du groupe → **comptée une seule fois**. C'est l'erreur classique qui gonfle les prix d'un facteur 2 à 4. |

`dedup_key = sha256(id_mutation)`, unique par partition → idempotence de l'upsert.

## A.2 Aberrants : marquer, ne jamais supprimer

Les lignes aberrantes sont **conservées** avec `is_outlier = true` et un `exclusion_reason` explicite (`prix_hors_bornes`, `surface_hors_bornes`, `valeur_symbolique`, `iqr_commune`, `multi_type`). Motif : traçabilité, et réversibilité si un seuil évolue — un seuil mal choisi ne doit pas détruire de la donnée.

Bornes :
- `prix_m2 ∉ [300 ; 25 000]` €/m², **borne haute portée à 45 000** pour 75, 06, 74, 2A, 2B, 92
- `surface_reelle_bati ∉ [9 ; 1 000]` (appartement) ou `[20 ; 1 500]` (maison)
- `valeur_fonciere < 5 000 €` (cessions symboliques, ventes intrafamiliales)
- écrêtage statistique par `(code_insee, type_local, année)` hors `[Q1 − 1,5×IQR ; Q3 + 1,5×IQR]` dès que `n ≥ 30` dans le groupe, sinon bornes départementales

**Tous les index du chemin chaud sont partiels sur `is_outlier = false`** : les lignes écartées ne pèsent sur aucun index de requête.

## A.3 Qualité de géolocalisation — colonne `geoloc_fine`

Colonnes ajoutées à `mutations` : `geoloc_source varchar(20)` (`dvf` / `ban` / `parcelle` / `commune_centroid`) et `geoloc_fine boolean`.

Les fichiers DVF géolocalisés Etalab fournissent les coordonnées à la parcelle → `geoloc_fine = true`. Les lignes sans coordonnées (~3 à 8 %) passent par la BAN en lot (`/search/csv/`, gratuit, sans clé) ; en dernier recours, centroïde communal avec **`geoloc_fine = false`**.

**Une mutation `geoloc_fine = false` doit être exclue des niveaux au rayon (L0 à L3)** : un point posé au centre de la commune n'a aucun sens dans un rayon de 500 m. Elle reste utilisable aux niveaux administratifs.

## A.4 Extensions PostgreSQL requises

```sql
CREATE EXTENSION IF NOT EXISTS postgis;      -- géométries, ST_DWithin, GiST
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- index GiST multicolonnes (géo + scalaires)
CREATE EXTENSION IF NOT EXISTS unaccent;     -- normalisation des noms de communes
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- recherche floue de commune
```

## A.5 Index — formulation de référence

```sql
CREATE INDEX mutations_geom_gist   ON mutations USING GIST (geom)
  WHERE is_outlier = false;                                        -- indispensable à ST_DWithin
CREATE INDEX mutations_search_gist ON mutations USING GIST (geom, type_local, surface_reelle_bati)
  WHERE is_outlier = false AND geoloc_fine = true;                 -- chemin chaud L0..L3 (btree_gist)
CREATE INDEX mutations_insee_idx   ON mutations (code_insee, type_local, date_mutation DESC)
  WHERE is_outlier = false;
CREATE INDEX mutations_dep_idx     ON mutations (code_departement, type_local, date_mutation DESC)
  WHERE is_outlier = false;
CREATE UNIQUE INDEX mutations_dedup ON mutations (dedup_key, date_mutation);
```

## A.6 `ST_DWithin` et non `ST_Distance` — pourquoi c'est structurant

- `ST_DWithin(geom, :p, r)` sur le type **`geography`** exprime `r` en **mètres** et est **réécrit par le planificateur en un prédicat de boîte englobante (`&&`) exploitable par l'index GiST**, suivi d'un re-contrôle exact sur les seules lignes candidates. C'est la seule forme indexable.
- `ST_Distance(m.geom, :p) <= r` dans le `WHERE` est un **appel de fonction sur chaque ligne** : aucune classe d'opérateur ne s'y applique → **Seq Scan sur plusieurs millions de lignes**, et sur `geography` le calcul est géodésique sur ellipsoïde. Coût mesuré en secondes contre quelques millisecondes.
- **Règle** : `ST_DWithin` **uniquement dans le `WHERE`** ; `ST_Distance` **uniquement dans le `SELECT`** (renvoi de la distance des comparables retenus) et éventuellement dans l'`ORDER BY`, où il ne s'applique qu'aux lignes déjà élaguées.
- `SET LOCAL statement_timeout = '2s'` sur chaque requête de cascade : un niveau qui dérape est abandonné, on passe au suivant plutôt que de faire attendre l'utilisateur.

## A.7 Staging et chargement

`mutations_staging` : table **`UNLOGGED`**, toutes colonnes en `text`, structure calquée sur l'en-tête CSV DVF. Cible du `COPY`, tronquée à chaque département. `UNLOGGED` = pas de WAL, chargement 2 à 3× plus rapide, perte au crash sans conséquence (le fichier source est re-téléchargeable).

**Jamais d'`INSERT` ligne à ligne.** `gunzip → COPY … FROM STDIN WITH (FORMAT csv, HEADER true)` via `pg-copy-streams`, puis normalisation **intégralement en SQL set-based**.

**Une transaction par département**, jamais une transaction géante — c'est ce qui rend `--resume` possible.

**Aucun `DROP`, aucun `TRUNCATE` sur `mutations`.** L'upsert `ON CONFLICT (dedup_key, date_mutation) DO UPDATE` garantit que le service reste disponible pendant tout l'import.

## A.8 Traçabilité et idempotence — `ingestion_runs` et `dataset_versions`

`ingestion_runs` : `source`, `millesime`, `fichier_url`, `checksum_sha256`, `statut` (`running`/`success`/`failed`/`partial`), `rows_read/inserted/updated/rejected`, `rejets jsonb` (compteur par motif), `progression jsonb` (départements traités → reprise), `dataset_version`.

**Unique `(source, millesime, checksum_sha256)` → rejouer le même fichier est un no-op.** C'est le socle de l'idempotence : un cron rejoué, un redéploiement ou un retry CI ne duplique jamais rien.

`dataset_versions` : `dataset_version` unique, `published_at`, `sources jsonb` (nom, URL, licence, millésime, date de mise à jour — sérialisé tel quel dans le DTO), `is_current boolean` avec **index unique partiel `WHERE is_current`**. Sert de clé de cache globale et de source des mentions légales du §8.

## A.9 Volumétrie révisée

Fichiers DVF bruts : **8 à 10 M de lignes par an** (une par lot/local/parcelle). Après regroupement par `id_mutation` : **2,5 à 3 M de mutations/an**, dont **900 000 à 1,1 M de ventes maison/appartement exploitables**. Sur **6 ans** : ~50-60 M lignes traitées à l'ingestion, **6 à 7 M lignes conservées**. Empreinte ~2 Go de table + ~2 Go d'index → **provisionner 20 Go** (marge staging, MV, WAL).

## A.10 Garde de cohérence de marché (L3 et au-delà)

À partir du rayon de 5 km, n'admettre que les mutations situées dans des communes dont la médiane €/m² se situe **à ±35 % de celle de la commune de référence**. Sans cette garde, un rayon de 5 km autour d'une commune littorale prisée aspire le village agricole voisin, et inversement. Si la garde fait tomber `n` sous le seuil, on descend au niveau suivant.

## A.11 Ordre d'assouplissement : temporel avant géographique

La proximité est plus discriminante que la fraîcheur, et l'ajustement temporel corrige déjà chaque comparable par l'indice de sa période — allonger la fenêtre coûte en dispersion, pas en biais.

1. **Passe 1** — fenêtre 24 mois, niveaux au rayon
2. **Passe 2** — si échec, fenêtre 36 mois, niveaux au rayon, pénalité additionnelle
3. **Passe 3** — si échec, fenêtre 36 mois, niveaux administratifs
4. **Passe 4** — si échec, fenêtre 60 mois sur commune → département

## A.12 Frontière SQL / calcul — non négociable

Le SQL **filtre, classe et limite** (plafond K = 200 comparables). Il ne calcule **ni médiane, ni quartiles, ni coefficients**.

Médiane, IQR, ajustements et indice de confiance sont calculés dans le **module de valorisation pur**, à partir d'un tableau plat d'objets `{ prixM2, surface, distanceMetres, … }` — **aucun type PostGIS, aucun modèle Lucid ne franchit cette frontière**.

C'est ce qui rend l'algorithme testable sans base de données. C'est la propriété de qualité la plus importante de tout le projet.

---

# Annexe B — Décisions client postérieures à la rédaction

> Ces décisions ont été prises par le client après la rédaction du corps de la spec et **inversent deux points qui y figuraient comme « tranchés »**. Elles font foi. Cette annexe existe pour qu'aucun développeur ne « recorrige » le code vers la version initiale en croyant réparer un écart.

## B.1 — Le prix est toujours affiché, même à très faible confiance

**Le §3.8 et le §10 prévoyaient** : sous 30/100 de confiance, la valeur centrale n'est pas affichée (`display.showCentralValue = false`), seule une fourchette large est montrée.

**Décision client : le prix est affiché en toutes circonstances.**

Mise en œuvre :
- `display.showCentralValue` **reste dans le DTO** mais renvoie **toujours `true`**.
- L'indice de confiance, son libellé et `display.warnings` portent seuls le signal de fragilité.
- Le CTA expert reste renforcé aux niveaux faibles.

Contrepartie assumée : on met le nom du site sur un chiffre que l'on sait fragile. Le garde-fou déplacé est l'affichage systématique et non masquable de l'indice de confiance et de l'avertissement légal du §8.2.

Deux tests, un unitaire et un fonctionnel, verrouillent ce comportement.

## B.2 — Le repli affiche un prix plutôt qu'un écran « estimation différée »

**Le §2.3, le §2.4 et le §10 prévoyaient** : `PUBLIC_ESTIMATION_FALLBACK` à `'none'` par défaut, mode « estimation différée » sans prix quand l'API est injoignable, repli statique réservé aux previews et « jamais activé en production ».

**Décision client : `PUBLIC_ESTIMATION_FALLBACK=static` par défaut.** Quand l'API est injoignable, on calcule via `calculerEstimation()` et on affiche un prix.

Le risque juridique invoqué au §2.4 — afficher un chiffre issu d'une table de 35 villes sous une mention de source DVF serait factuellement mensonger — est traité **techniquement**, pas ignoré :
- bandeau permanent « Estimation indicative — nos données de transactions n'ont pas pu être consultées »
- **aucune mention DVF, DGFiP ni Etalab** sur la page ni dans le PDF en mode `static-fallback` (vérifié : la chaîne est absente de tout le rendu)
- bouton « Relancer le calcul »
- confiance plafonnée et libellée « indicatif »
- l'e-mail interne porte la mention du mode dégradé, pour que le lead soit retraité à la main

**Ne s'applique PAS** aux erreurs `422` (validation) ni `404 COMMUNE_NOT_FOUND` : une donnée invalide ne doit pas produire d'estimation. On renvoie l'utilisateur au champ fautif.

## B.3 — Les indicateurs non sourçables sont supprimés

Confirmation du §7.2 point 5 et du §8.4 : `delaiVenteMoyen`, `tauxNegociation` et `prixMaisonM2 = prixM2 × 0,85` sont **supprimés** de `/rapport`, pas remplacés par d'autres valeurs estimées. Seuls subsistent les indicateurs dérivables des données réelles.

## B.4 — Points laissés aux valeurs par défaut

Faute d'arbitrage explicite, les valeurs suivantes sont retenues et peuvent être révisées :
- rétention de `estimations_log` : **12 mois**
- références Alsace-Moselle et Mayotte : reprises de `src/data/prix.ts`, étiquetées `source_label = 'Estimation interne, hors DVF'`
- budget d'infrastructure Coolify : à arbitrer par le client, sans impact sur le code

## B.5 — Dégradation silencieuse à surveiller

Conséquence de B.2 relevée en revue : si `PUBLIC_API_URL` est **vide**, le front retombe sur la table de 35 villes **sans aucun signal côté exploitation**. C'est précisément la dégradation invisible que la spec voulait éliminer.

**Garde-fou requis avant mise en production** : faire échouer le build (ou la CI) si `PUBLIC_API_URL` est vide en environnement de production. Un repli doit être un incident visible, jamais un état par défaut.
