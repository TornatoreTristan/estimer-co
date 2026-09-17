# ==========================================================================
# Image de production de l'API d'estimation (service Coolify `estimer-api`).
#
# Multi-stage : les dépendances de développement et les sources TypeScript ne
# se retrouvent jamais dans l'image finale.
#
#   docker build -t estimer-api ./api
#   docker run --env-file api/.env -p 3333:3333 estimer-api
# ==========================================================================

# --------------------------------------------------------------------------
# 1. Dépendances de production seules
# --------------------------------------------------------------------------
# Node 24 est un MINIMUM imposé par AdonisJS 7 (`engines.node >= 24`), pas une
# préférence : sur Node 22 le serveur refuse de démarrer.
FROM node:24-alpine AS deps-prod
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci --omit=dev` garantit une installation reproductible depuis le
# lockfile : jamais de résolution de version au moment du build.
RUN npm ci --omit=dev

# --------------------------------------------------------------------------
# 2. Build AdonisJS (nécessite les dépendances de développement)
# --------------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# `node ace build` produit ./build : JavaScript compilé + package.json.
RUN node ace build

# --------------------------------------------------------------------------
# 3. Image finale
# --------------------------------------------------------------------------
FROM node:24-alpine AS production

# `dumb-init` assure la propagation de SIGTERM au processus Node : sans lui,
# un arrêt Coolify couperait les connexions en cours au lieu de les drainer.
#
# `git` est requis par le module d'automatisation IA du blog
# (specs/blog-automatisation-ia.md §1.3) : l'API clone/fetch/push une copie de
# travail du dépôt (`BLOG_GIT_WORKDIR`) en ligne de commande, jamais via un
# binding natif.
RUN apk add --no-cache dumb-init git

ENV NODE_ENV=production
ENV PORT=3333
ENV HOST=0.0.0.0

WORKDIR /app

# Volume persistant pour `BLOG_GIT_WORKDIR` (défaut `/data/blog-repo`, cf.
# `.env.example`) : la copie de travail Git survit aux redéploiements, pour ne
# jamais recloner le dépôt entier à chaque démarrage du conteneur.
# Appartient à `node` (le process tourne sous cet utilisateur, cf. `USER`
# ci-dessous) : sans ce `chown`, `git clone` échouerait en écriture.
RUN mkdir -p /data/blog-repo && chown -R node:node /data/blog-repo
VOLUME ["/data/blog-repo"]

# L'image node fournit déjà un utilisateur non privilégié `node`.
COPY --chown=node:node --from=deps-prod /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/build ./

USER node
EXPOSE 3333

# Sonde alignée sur `GET /health` (§6.1), hors CORS et hors rate limiting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3333)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "bin/server.js"]
