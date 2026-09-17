import app from '@adonisjs/core/services/app'
import env from '#start/env'

/** Configuration résolue du module blog — voir `loadBlogConfigFromEnv`. */
export interface BlogConfig {
  workdir: string
  remoteUrl: string
  authHeader?: string
  authorName: string
  authorEmail: string
  nodeModulesSource?: string
  github: { token: string; owner: string; repo: string; baseUrl?: string }
}

export class BlogNotConfiguredError extends Error {}

/**
 * Construit la configuration réelle depuis l'environnement (spec §5).
 * Lève `BlogNotConfiguredError` si une variable requise manque — appelé
 * seulement au moment d'utiliser le module (voir `start/env.ts` : ces
 * variables sont optionnelles au démarrage, pour ne jamais bloquer le reste
 * de l'API).
 */
export function loadBlogConfigFromEnv(): BlogConfig {
  const token = env.get('GITHUB_BLOG_BOT_TOKEN')
  const repoSlug = env.get('GITHUB_REPO')
  const workdir = env.get('BLOG_GIT_WORKDIR')
  const authorName = env.get('BLOG_GIT_AUTHOR_NAME')
  const authorEmail = env.get('BLOG_GIT_AUTHOR_EMAIL')

  if (!token || !repoSlug || !workdir || !authorName || !authorEmail) {
    throw new BlogNotConfiguredError(
      'Module blog non configuré : GITHUB_BLOG_BOT_TOKEN, GITHUB_REPO, BLOG_GIT_WORKDIR, ' +
        'BLOG_GIT_AUTHOR_NAME et BLOG_GIT_AUTHOR_EMAIL sont requis.'
    )
  }

  const [owner, repo] = repoSlug.split('/')
  if (!owner || !repo) {
    throw new BlogNotConfiguredError(
      `GITHUB_REPO invalide : "${repoSlug}" (attendu "proprietaire/depot").`
    )
  }

  // Jeton GitHub encodé en Basic Auth "x-access-token:<token>" — jamais dans
  // l'URL du remote ni dans .git/config (spec §5). Voir `GitService`.
  const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`

  return {
    workdir,
    remoteUrl: env.get('BLOG_GIT_REMOTE_URL') || `https://github.com/${owner}/${repo}.git`,
    authHeader,
    authorName,
    authorEmail,
    nodeModulesSource: app.makePath('node_modules'),
    github: {
      token,
      owner,
      repo,
      baseUrl: env.get('GITHUB_API_BASE_URL') || undefined,
    },
  }
}
