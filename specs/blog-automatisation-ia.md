# Specs — Automatisation IA de la gestion des articles de blog

Objectif : un agent IA peut pousser un article (contenu + SEO), gérer sa photo,
choisir ou créer un auteur et choisir une catégorie, sans jamais publier
directement.

## 0. Architecture retenue

Le dépôt Git reste l'unique source de vérité. L'automatisation est un module
de l'API AdonisJS (`api/`).

1. L'IA appelle `POST /v1/blog/**` avec un jeton Bearer dédié.
2. L'API tient une copie de travail du dépôt (`BLOG_GIT_WORKDIR`), repart de
   `origin/main` (ou de la branche `blog-ia/<slug>` si elle existe), écrit les
   fichiers (`.md`, `.webp`, `.json` d'auteur).
3. Avant commit, l'API exécute le vrai `node scripts/validate-content.mjs --json`
   sur la copie de travail (aucune règle dupliquée).
4. Commit, push de la branche `blog-ia/<slug>` (`--force-with-lease`), ouverture
   ou mise à jour d'une PR via `@octokit/rest`.
5. **Aucun merge automatique.** Un humain relit et merge. La CI `site.yml`
   tourne sur la PR (validation + `astro build`, donc aussi le schéma Zod). Le
   merge sur `main` déclenche le déploiement Coolify existant.

Même un brouillon passe par une PR : jamais de push direct sur `main`.

## 1. Prérequis (Lot 0)

### 1.1 Auteurs en JSON
- Un fichier par auteur : `src/content/auteurs/<id>.json` (forme `Auteur` sans
  `id`, l'id est le nom de fichier).
- `src/lib/auteurs.ts` devient un loader (lecture synchrone du dossier) qui
  construit `AUTEURS` et `AUTEUR_IDS`. `AUTEUR_PAR_DEFAUT` reste une constante.
- Aucun changement de rendu. `src/content.config.ts` inchangé.

### 1.2 `validate-content.mjs --json`
Flag `--json` : imprime `{ "errors": [...], "warnings": [...] }` sur stdout
(objets `Issue` existants), code de sortie inchangé. Le mode texte reste le
défaut (CI).

### 1.3 Exécution du script depuis l'API
- L'image Docker de l'API doit contenir `git` (`apk add git`) et un volume
  persistant pour `BLOG_GIT_WORKDIR`.
- `validate-content.mjs` importe `yaml` : l'API l'ajoute à ses dépendances et
  rend `node_modules` résolvable depuis la copie de travail (lien symbolique
  `BLOG_GIT_WORKDIR/node_modules` → `node_modules` de l'API), sans `npm ci` du site.

### 1.4 Dépendances `api/`
`@octokit/rest`, `sharp`, `yaml` (git via CLI ou `simple-git`).

## 2. User stories

- **A1** Jeton Bearer par client sur `/v1/blog/**`, haché en base, révocable.
- **A2** Rate limiting dédié par client.
- **A3** Aucun appel ne peut merger une PR ni pousser sur `main`.
- **B1** Créer un article en `brouillon` (titre, catégorie, Markdown, SEO).
- **B2** Mettre à jour un article existant via le même `slug`.
- **B3** Idempotence via `Idempotency-Key` : un retry ne crée jamais de doublon.
- **B4** Erreurs de validation structurées (422, champ par champ).
- **C1** Image fournie en base64, convertie en `.webp` et rangée.
- **C2** `imageAlt` obligatoire dès qu'une image est fournie.
- **C3** `imageCadrage` optionnel (0–100).
- **D1** Lister les auteurs.
- **D2** Créer un auteur (nom, fonction, bio, liens, photo optionnelle).
- **D3** Auteur omis → `AUTEUR_PAR_DEFAUT`.
- **E1** Lister les catégories (source : `src/lib/blog.ts`).
- **E2** Catégorie inconnue → 422 listant les valeurs valides.
- **F1** Demander le passage en `publie`.
- **F2** Refus 422 avec le rapport de la gate si contenu incomplet.
- **F3** Une publication acceptée n'aboutit qu'à une PR, jamais à un merge.
- **G1** Consulter l'état d'une opération.
- **G2** Opérations concurrentes sur un même slug sérialisées.
- **H1** Serveur MCP : un outil par endpoint, simple client HTTP de l'API.

## 3. Critères d'acceptation

### B1 — Création d'un brouillon
```gherkin
Étant donné un jeton valide avec le scope "articles:write"
Et un slug "estimation-appartement-nantes" absent de main
Quand l'IA envoie POST /v1/blog/articles avec categorie, title, contenu et une Idempotency-Key
Alors l'API répond 201 { slug, statut: "brouillon", job: { id, status: "pr_open" }, prUrl }
Et une PR est ouverte depuis "blog-ia/estimation-appartement-nantes"
Et "src/content/articles/estimation-appartement-nantes.md" existe sur cette branche
Et aucun commit n'est poussé sur main
```

### B2/B3 — Mise à jour et idempotence
```gherkin
Scénario : rejeu à l'identique
Étant donné un appel déjà traité avec Idempotency-Key "abc-123"
Quand le même appel est renvoyé avec "abc-123"
Alors l'API répond 200 avec la même réponse, sans nouvelle branche ni PR

Scénario : même clé, payload différent
Quand un appel réutilise "abc-123" avec un payload différent
Alors l'API répond 422 { error: "idempotency_key_reused" }

Scénario : mise à jour d'un brouillon
Étant donné une branche "blog-ia/X" et sa PR ouverte
Quand l'IA renvoie le slug "X" avec une nouvelle clé et un contenu modifié
Alors l'API répond 200, pousse un commit sur "blog-ia/X" et met à jour la PR existante

Scénario : article déjà sur main
Étant donné "X" présent sur main sans branche "blog-ia/X"
Quand l'IA envoie le slug "X"
Alors l'API crée "blog-ia/X" depuis main, applique les modifications et répond 200
```

### B4 — Erreurs
```gherkin
Scénario : catégorie hors enum
Alors 422 { errors: [{ field: "categorie", message: "... valeurs autorisées : ..." }] }
Et aucun fichier écrit, aucune branche créée

Scénario : brouillon incomplet
Quand statut est omis et metaDescription/extrait absents
Alors 201 et la PR est ouverte (la gate ne s'applique qu'à statut: publie)
```

### C — Image
```gherkin
Scénario : image sans alt → 422 { field: "imageAlt" }, rien d'écrit
Scénario : JPEG valide avec alt → "public/images/blog/X.webp" créé, 1600 px de large max, qualité 80,
          frontmatter "image: /images/blog/X.webp"
Scénario : signature binaire ni JPEG, ni PNG, ni WebP → 422 { field: "image" }
Scénario : image > 10 Mo décodés → 422 { field: "image" }
```

### D — Auteurs
```gherkin
Scénario : auteur omis → AUTEUR_PAR_DEFAUT
Scénario : auteur inconnu → 422 { field: "auteur", message: "auteur \"jean-dupont\" inconnu — créez-le via POST /v1/blog/auteurs" }
          (un auteur connu = présent sur main OU sur une branche blog-ia/auteur-<id> ouverte)
Scénario : POST /v1/blog/auteurs (nom, fonction, bio ≥ 50 caractères)
          → 201, "src/content/auteurs/<id>.json" sur "blog-ia/auteur-<id>", PR distincte
Scénario : id déjà existant → 409
```

### F — Publication
```gherkin
Scénario : contenu complet
Quand POST /v1/blog/articles/X/publish
Alors la validation tourne avec statut: publie
Et si OK → 200, frontmatter statut: publie + dateMiseAJour du jour, PR mise à jour, aucun merge

Scénario : contenu incomplet
Alors 422 avec le rapport de la gate, fichier inchangé (statut: brouillon)
```

### G — Concurrence et suivi
```gherkin
Scénario : opération en cours sur X → 409 { error: "operation_in_progress", jobId }
Scénario : GET /v1/blog/jobs/:id → status ∈ pending|validating|failed|pushed|pr_open|pr_merged|pr_closed
          si pr_open, l'état de la PR est relu sur GitHub pour détecter merged/closed
          si failed, le corps contient validationErrors ou errorMessage
```

### A — Sécurité
```gherkin
Scénario : jeton absent, invalide ou révoqué → 401 { error: "unauthorized" }
Scénario : scope manquant → 403
Scénario : quota dépassé → 429
```

## 4. Endpoints

Base `/v1/blog`, groupe de routes **distinct** du groupe `/v1` existant : pas
d'`originGuard` (appel serveur à serveur), auth Bearer + limiteur dédié.
`Idempotency-Key` obligatoire sur tous les `POST`.

| Méthode | Route | Scope | Payload | Succès |
|---|---|---|---|---|
| POST | `/articles` | `articles:write` | `{ slug?, categorie, title, metaTitle?, metaDescription?, extrait?, contenu, image?: { data, mimeType }, imageAlt?, imageCadrage?, auteur?, faq?, motsClesCibles?, articlesLies?, datePublication?, ordreAffichage? }` | 201 / 200 `{ slug, statut, job, prUrl }` |
| GET | `/articles/:slug` | `articles:write` | — | `{ existsOnMain, data?, openPr? }` |
| POST | `/articles/:slug/publish` | `publish:request` | `{}` | 200 `{ slug, statut: "publie", job, prUrl }` |
| GET | `/auteurs` | — | — | `{ auteurs: [{ id, nom, fonction, photo }] }` |
| POST | `/auteurs` | `auteurs:write` | `{ id?, nom, fonction, bio, photo?: { data, mimeType }, liens? }` | 201 `{ id, job, prUrl }` |
| GET | `/categories` | — | — | `{ categories: [{ slug, label }] }` |
| GET | `/jobs/:id` | — | — | `{ id, slug, action, status, prUrl?, validationErrors?, validationWarnings?, errorMessage?, updatedAt }` |

`slug` absent → dérivé du `title` (kebab-case ASCII). `statut` n'est pas
accepté sur `POST /articles` : un article créé ou mis à jour par l'IA garde son
statut actuel (`brouillon` à la création). Seul `/publish` le passe à `publie`.
Pas de suppression, pas de création de catégorie au MVP.

Codes : 401, 403, 404, 409, 422, 429. Un job n'est visible que par le client
qui l'a créé (sinon 404).

## 5. Données (PostgreSQL)

```sql
CREATE TABLE blog_api_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,          -- sha256, jamais le jeton en clair
  scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE blog_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES blog_api_clients(id),
  idempotency_key text NOT NULL,
  action text NOT NULL,        -- article_upsert | article_publish | auteur_create
  slug text NOT NULL,
  branch text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  pr_number integer,
  pr_url text,
  payload_hash text NOT NULL,
  response jsonb,              -- réponse rejouée à l'identique
  validation_errors jsonb,
  validation_warnings jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, idempotency_key)
);
CREATE INDEX blog_jobs_slug_idx ON blog_jobs (slug);
```

Verrou : `pg_try_advisory_lock(hashtext('blog:' || slug))` (échec → 409), le
même mécanisme que `dvf:import`. Un verrou global sérialise en plus l'accès à
la copie de travail (une seule copie partagée).

Création de client : commande `node ace blog:client:create <nom> --scopes=...`
qui affiche le jeton une seule fois.

Variables d'environnement :
```
GITHUB_BLOG_BOT_TOKEN=   # PAT fine-grained, dépôt estimer-co seul, contents:write + pull_requests:write
GITHUB_REPO=TornatoreTristan/estimer-co
BLOG_GIT_WORKDIR=/data/blog-repo
BLOG_GIT_AUTHOR_NAME=estimer-bot
BLOG_GIT_AUTHOR_EMAIL=
```

Le jeton GitHub n'apparaît jamais dans les logs, les messages d'erreur ou
l'URL du remote écrite dans `.git/config`.

## 6. Interface

Aucun écran web : la revue humaine se fait dans la PR GitHub. Pages CMS reste
utilisable pour les retouches.

## 7. Serveur MCP (Lot 4)

Paquet `mcp/` (Node, `@modelcontextprotocol/sdk`, transport stdio). Outils :
`create_or_update_article`, `get_article`, `publish_article`, `get_job_status`,
`list_auteurs`, `create_auteur`, `list_categories`. Il lit `ESTIMER_API_URL` et
`ESTIMER_BLOG_TOKEN`, génère l'`Idempotency-Key`, accepte un chemin de fichier
local pour l'image (lu et encodé en base64) et ne réimplémente aucune règle.

## 8. Lots

0. Auteurs JSON, `--json`, migrations, modèles, commande client, Dockerfile.
1. Articles en brouillon + image + jobs + catégories.
2. Auteurs.
3. Publication.
4. Serveur MCP + documentation (`api/README.md` §Blog IA).

## 9. Hors périmètre

Création de catégories, suppression, merge automatique, preview par branche,
publication programmée, génération du contenu lui-même, notifications
Discord, multilingue, webhook GitHub (remplacé par la relecture de l'état de
la PR sur `GET /jobs/:id`).
