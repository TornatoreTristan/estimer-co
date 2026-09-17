import { GitService } from '#services/blog/git_service'
import { GithubPrService, type PrService } from '#services/blog/pr_service'
import { loadBlogConfigFromEnv } from '#services/blog/config'

export interface BlogServiceBundle {
  git: GitService
  pr: PrService
}

/**
 * Point d'injection de test (spec : « Git et GitHub doivent être derrière des
 * interfaces injectables pour que les tests n'appellent jamais le vrai
 * GitHub ni ne poussent quoi que ce soit »).
 *
 * En dehors des tests, `getBlogServices()` construit toujours les mêmes
 * implémentations réelles depuis l'environnement — ce module n'est PAS un
 * conteneur IoC général, seulement le seul point où un test remplace
 * `GitService`/`PrService` par un dépôt local "bare" et un faux service de PR.
 */
let overrides: Partial<BlogServiceBundle> | null = null

/**
 * Mémoïsation du bundle RÉEL (hors tests, revue QA, mineur 6) : chaque
 * `GitService` porte un `workdir` fixe — le recréer à chaque requête n'offre
 * aucun isolement supplémentaire (le dossier sur disque, lui, est déjà
 * partagé, cf. `blogWorkdirMutex`) et fait juste relire l'environnement et
 * réallouer un objet pour rien à chaque appel de contrôleur.
 *
 * Volontairement un module-level `let`, jamais consulté quand `overrides`
 * fournit tout ce qu'il faut (branche `setBlogServicesForTesting` ci-dessous,
 * empruntée par tous les tests) : la construction réelle — et donc cette
 * mémoïsation — ne s'exécute jamais pendant la suite de tests.
 */
let realBundle: BlogServiceBundle | null = null

export function setBlogServicesForTesting(bundle: Partial<BlogServiceBundle> | null): void {
  overrides = bundle
}

export function getBlogServices(): BlogServiceBundle {
  if (overrides?.git && overrides?.pr) {
    return { git: overrides.git, pr: overrides.pr }
  }

  if (!realBundle) {
    const config = loadBlogConfigFromEnv()
    realBundle = {
      git: new GitService({
        workdir: config.workdir,
        remoteUrl: config.remoteUrl,
        authHeader: config.authHeader,
        authorName: config.authorName,
        authorEmail: config.authorEmail,
        nodeModulesSource: config.nodeModulesSource,
      }),
      pr: new GithubPrService(config.github),
    }
  }

  return {
    git: overrides?.git ?? realBundle.git,
    pr: overrides?.pr ?? realBundle.pr,
  }
}
