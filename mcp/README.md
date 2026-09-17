# `estimer-blog-mcp` — serveur MCP du blog estimer.co

Serveur MCP (transport **stdio**) qui expose l'automatisation IA du blog
(specs [`specs/blog-automatisation-ia.md`](../specs/blog-automatisation-ia.md)
§7) sous forme d'outils utilisables par un agent (Claude Code, Claude
Desktop, ou tout client MCP). C'est un **simple client HTTP** de l'API
AdonisJS (`api/`, groupe de routes `/v1/blog/**`, documentée dans
[`api/README.md`](../api/README.md#blog-ia--automatisation-v1blog)) : aucune
règle métier (validation de contenu, gate de publication, enum de
catégories…) n'est reproduite ici. Toute écriture n'aboutit qu'à une Pull
Request sur GitHub, relue par un humain — jamais à une publication directe.

## Installation et build

```bash
cd mcp
npm install
npm run build      # compile src/ → dist/
```

```bash
npm run typecheck  # tsc --noEmit
npm test           # compile + node:test, faux serveur HTTP local
```

## Configuration

Deux variables d'environnement, obligatoires :

| Variable | Description |
|---|---|
| `ESTIMER_API_URL` | Racine de l'API AdonisJS, **sans** le suffixe `/v1/blog` (ex. `https://api.estimer.co`, ou `http://localhost:3333` en développement). |
| `ESTIMER_BLOG_TOKEN` | Jeton Bearer d'un client `/v1/blog/**`, créé via `node ace blog:client:create` (voir `api/README.md`). |

Le serveur refuse de démarrer si l'une des deux est absente, avec un message
d'erreur explicite sur stderr — **le jeton n'y apparaît jamais**, ni dans
aucun autre journal ou résultat d'outil : seules son absence ou les erreurs
renvoyées par l'API (qui ne contiennent jamais le jeton non plus) sont
rapportées.

## Utilisation dans Claude Code

```bash
claude mcp add estimer-blog \
  --env ESTIMER_API_URL=https://api.estimer.co \
  --env ESTIMER_BLOG_TOKEN=$(cat ~/.secrets/estimer-blog-token) \
  -- node /chemin/absolu/vers/estimer.co/mcp/dist/src/index.js
```

Ou directement dans `.mcp.json` (à la racine d'un projet, ou dans la config
utilisateur de Claude Code) — **ne jamais écrire le jeton en dur**, toujours
via une variable d'environnement du shell qui lance Claude Code :

```json
{
  "mcpServers": {
    "estimer-blog": {
      "command": "node",
      "args": ["/chemin/absolu/vers/estimer.co/mcp/dist/src/index.js"],
      "env": {
        "ESTIMER_API_URL": "https://api.estimer.co",
        "ESTIMER_BLOG_TOKEN": "${ESTIMER_BLOG_TOKEN}"
      }
    }
  }
}
```

## Utilisation dans Claude Desktop

Même principe dans `claude_desktop_config.json` (menu Claude Desktop >
Paramètres > Développeur > Modifier la configuration) :

```json
{
  "mcpServers": {
    "estimer-blog": {
      "command": "node",
      "args": ["/chemin/absolu/vers/estimer.co/mcp/dist/src/index.js"],
      "env": {
        "ESTIMER_API_URL": "https://api.estimer.co",
        "ESTIMER_BLOG_TOKEN": "REMPLACER_PAR_LA_VALEUR_REELLE_DU_JETON"
      }
    }
  }
}
```

Claude Desktop ne lit pas les variables d'environnement du shell de l'utilisateur
au lancement : contrairement à Claude Code, la valeur doit donc être renseignée
directement dans ce fichier de configuration local (jamais commité, jamais
partagé) plutôt qu'en dur dans un script versionné.

## Outils exposés

| Outil | Entrée | Correspond à |
|---|---|---|
| `list_categories` | *(aucune)* | `GET /v1/blog/categories` |
| `list_auteurs` | *(aucune)* | `GET /v1/blog/auteurs` |
| `create_auteur` | `nom`, `fonction`, `bio` (≥ 50 caractères), `id?`, `liens?`, `imagePath?` \| `imageBase64?`+`imageMimeType?`, `idempotencyKey?` | `POST /v1/blog/auteurs` |
| `create_or_update_article` | `categorie`, `title`, `contenu`, `slug?`, `metaTitle?`, `metaDescription?`, `extrait?`, `imageAlt?`, `imageCadrage?`, `auteur?`, `faq?`, `motsClesCibles?`, `articlesLies?`, `datePublication?`, `ordreAffichage?`, `imagePath?` \| `imageBase64?`+`imageMimeType?`, `idempotencyKey?` | `POST /v1/blog/articles` |
| `get_article` | `slug` | `GET /v1/blog/articles/:slug` |
| `publish_article` | `slug`, `idempotencyKey?` | `POST /v1/blog/articles/:slug/publish` |
| `get_job_status` | `jobId` | `GET /v1/blog/jobs/:id` |

Points communs à tous les outils d'écriture (`create_or_update_article`,
`create_auteur`, `publish_article`) :

- **Jamais de publication directe** : chaque appel ouvre ou met à jour une
  Pull Request GitHub, relue par un humain. Un article créé ou mis à jour
  reste en statut `brouillon` tant que `publish_article` n'a pas été appelé
  et accepté.
- **`Idempotency-Key`** : générée automatiquement (UUID) si `idempotencyKey`
  est omis. Fournir une clé explicite permet un **rejeu** volontaire (même
  clé → même réponse, aucun doublon ni nouvelle PR) ; réutiliser la même clé
  avec un contenu différent est refusé par l'API (`422
  idempotency_key_reused`).
- **Image** : soit `imagePath` (chemin local lu et encodé en base64 par le
  serveur MCP, type déduit de la signature binaire du fichier ou, à défaut,
  de son extension), soit `imageBase64` + `imageMimeType` fournis
  directement. Les deux sont exclusifs. `imageAlt` est **obligatoire** dès
  qu'une image est fournie (accessibilité) — l'API la refuse sinon, sans rien
  écrire.
- **Erreurs** : toute réponse HTTP d'erreur de l'API (`401`, `403`, `404`,
  `409`, `422`, `429`) revient comme résultat d'outil `isError: true`, avec le
  détail exploitable (champ par champ pour une `422` de validation, `jobId`
  pour un `409 operation_in_progress`, scopes manquants pour un `403`…) —
  jamais comme exception non gérée. En cas de `422`, corrigez les champs
  indiqués et renvoyez l'appel.
- Avant `create_or_update_article`, appelez `list_categories` (la
  `categorie` doit être un slug valide) et, si vous renseignez `auteur`,
  `list_auteurs` (sinon créez-le d'abord via `create_auteur`).

## Architecture du code

```
mcp/src/
├── config.ts           # lecture/validation de ESTIMER_API_URL et ESTIMER_BLOG_TOKEN
├── blog_api_client.ts  # client HTTP générique (en-têtes, JSON, BlogApiError/BlogApiNetworkError)
├── idempotency.ts       # génère ou accepte une Idempotency-Key
├── image.ts             # lecture + encodage base64 d'une image locale
├── format_error.ts      # traduit une erreur API en texte exploitable par le modèle
├── types.ts              # types TypeScript du contrat REST (aucune logique)
├── tools.ts              # définition et enregistrement des 7 outils MCP (zod)
├── server.ts             # construction du McpServer + transport stdio
└── index.ts               # point d'entrée du binaire
```

`tests/` couvre chaque module avec `node:test` et un faux serveur HTTP local
(`tests/helpers/fake_api_server.ts`, `node:http` pur) : en-têtes envoyés
(`Authorization`, `Idempotency-Key`), encodage d'image par signature binaire,
mapping des réponses `422`/`409`/`401`/`403`/`429` vers un résultat d'outil en
erreur, absence du jeton dans toute sortie produite.
