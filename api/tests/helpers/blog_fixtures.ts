import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { GitService } from '#services/blog/git_service'
import type { PrInfo, PrService } from '#services/blog/pr_service'
import BlogApiClient, { type BlogScope } from '#models/blog_api_client'
import { sha256Hex } from '#services/blog/hash'

const execFileAsync = promisify(execFile)

/**
 * Racine du dépôt site (au-dessus de `api/`) : `scripts/validate-content.mjs`
 * et `src/lib/blog.ts` y sont copiés TELS QUELS dans le dépôt "bare" de test
 * (spec : « aucune règle dupliquée » — les tests exercent le VRAI script, pas
 * une réécriture).
 */
const SITE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

export interface BlogGitFixture {
  /** Dépôt "bare" local, utilisé comme `remoteUrl` — jamais un vrai GitHub. */
  bareDir: string
  /** Copie de travail de l'API, jamais partagée entre deux tests. */
  workdir: string
  git: GitService
  cleanup: () => void
}

/**
 * Construit un dépôt Git local minimal mais RÉEL — un commit initial sur
 * `main` avec `scripts/validate-content.mjs`, `src/lib/blog.ts` et les
 * dossiers de contenu vides — puis le clone "bare" pour servir de remote.
 *
 * Aucun test n'appelle jamais GitHub ni ne pousse quoi que ce soit hors de ce
 * dossier temporaire (supprimé par `cleanup()`).
 */
export async function createBlogGitFixture(): Promise<BlogGitFixture> {
  const seedDir = mkdtempSync(join(tmpdir(), 'estimer-blog-seed-'))
  const bareDir = mkdtempSync(join(tmpdir(), 'estimer-blog-bare-'))
  const workdir = join(mkdtempSync(join(tmpdir(), 'estimer-blog-workdir-')), 'repo')

  for (const dir of [
    'scripts',
    'src/lib',
    'src/content/articles',
    'src/content/auteurs',
    'src/content/regions',
    'src/content/departements',
    'src/content/partenaires',
    'src/content/pages',
  ]) {
    mkdirSync(join(seedDir, dir), { recursive: true })
  }

  cpSync(
    join(SITE_ROOT, 'scripts/validate-content.mjs'),
    join(seedDir, 'scripts/validate-content.mjs')
  )
  cpSync(join(SITE_ROOT, 'src/lib/blog.ts'), join(seedDir, 'src/lib/blog.ts'))

  await git(['init', '-q', '-b', 'main'], seedDir)
  await git(['config', 'user.name', 'seed'], seedDir)
  await git(['config', 'user.email', 'seed@estimer.test'], seedDir)
  await git(['add', '-A'], seedDir)
  await git(['commit', '-q', '-m', 'Seed initial'], seedDir)

  // `--bare` : un dépôt SANS copie de travail, exactement ce qu'un serveur
  // Git héberge — c'est ce qui en fait un remote crédible pour `GitService`.
  await git(['clone', '-q', '--bare', seedDir, bareDir], tmpdir())

  rmSync(seedDir, { recursive: true, force: true })

  const gitService = new GitService({
    workdir,
    remoteUrl: bareDir,
    authorName: 'estimer-bot-test',
    authorEmail: 'estimer-bot@estimer.test',
    nodeModulesSource: join(SITE_ROOT, 'api/node_modules'),
  })

  return {
    bareDir,
    workdir,
    git: gitService,
    cleanup: () => {
      rmSync(bareDir, { recursive: true, force: true })
      rmSync(workdir, { recursive: true, force: true })
    },
  }
}

/** Lit un fichier depuis `main` du dépôt "bare", sans passer par `workdir` — vérifie ce qui a RÉELLEMENT été poussé. */
export async function readFileFromBare(
  bareDir: string,
  ref: string,
  relPath: string
): Promise<string | null> {
  try {
    return await git(['show', `${ref}:${relPath}`], bareDir)
  } catch {
    return null
  }
}

/**
 * `git status --porcelain` sur la copie de travail de test — vide si et
 * seulement si elle est propre (rien de non commité, aucun fichier orphelin).
 * Utilisé pour vérifier qu'un échec de validation restaure bien la copie de
 * travail partagée (revue QA, majeur 3).
 */
export async function gitStatusPorcelain(workdir: string): Promise<string> {
  return git(['status', '--porcelain'], workdir)
}

export async function listBranchesInBare(bareDir: string): Promise<string[]> {
  const output = await git(['branch', '--format=%(refname:short)'], bareDir)
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Crée un `blog_api_clients` de test et renvoie le jeton EN CLAIR (jamais persisté). */
export async function createBlogApiClient(
  scopes: BlogScope[] = [],
  opts: { revoked?: boolean } = {}
): Promise<{ client: BlogApiClient; token: string }> {
  const token = randomUUID()
  const client = await BlogApiClient.create({
    name: `test-${randomUUID()}`,
    tokenHash: sha256Hex(token),
    scopes,
    revokedAt: opts.revoked ? DateTime.now() : null,
  })
  return { client, token }
}

/**
 * Faux service de PR (spec : « un faux service PR », jamais le vrai
 * GitHub) : mémorise l'état en mémoire, ne fait aucun appel réseau, et
 * N'EXPOSE AUCUNE méthode de merge (F3/A3 : aucun appel ne peut merger une PR).
 */
export class InMemoryPrService implements PrService {
  #prs = new Map<number, PrInfo & { branch: string }>()
  #nextNumber = 1

  async findOpenPr(branch: string): Promise<PrInfo | null> {
    for (const pr of this.#prs.values()) {
      if (pr.branch === branch && pr.state === 'open') return pr
    }
    return null
  }

  async createPr(params: {
    branch: string
    base: string
    title: string
    body: string
  }): Promise<PrInfo> {
    const number = this.#nextNumber++
    const pr: PrInfo & { branch: string } = {
      number,
      url: `https://example.test/pulls/${number}`,
      state: 'open',
      merged: false,
      branch: params.branch,
    }
    this.#prs.set(number, pr)
    return pr
  }

  async updatePr(number: number, params: { title?: string; body?: string }): Promise<PrInfo> {
    void params
    const pr = this.#prs.get(number)
    if (!pr) throw new Error(`PR #${number} inconnue (fixture de test).`)
    return pr
  }

  async getPr(number: number): Promise<PrInfo> {
    const pr = this.#prs.get(number)
    if (!pr) throw new Error(`PR #${number} inconnue (fixture de test).`)
    return pr
  }

  /** Utilisé par les tests G2 pour simuler un merge externe détecté par `GET /jobs/:id`. */
  markMerged(number: number): void {
    const pr = this.#prs.get(number)
    if (pr) {
      pr.state = 'closed'
      pr.merged = true
    }
  }
}
