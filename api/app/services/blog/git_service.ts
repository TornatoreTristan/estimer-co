import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const execFileAsync = promisify(execFile)

export interface GitServiceConfig {
  /** Copie de travail persistante (`BLOG_GIT_WORKDIR`). */
  workdir: string
  /**
   * URL du remote `origin`. En production, une URL HTTPS GitHub sans jeton
   * (`https://github.com/<owner>/<repo>.git`) — le jeton passe UNIQUEMENT par
   * `authHeader`, jamais dans l'URL. En test, n'importe quelle URL Git valide
   * (typiquement un dépôt local "bare", `file:///…`) : c'est ce qui permet aux
   * tests de ne jamais toucher GitHub.
   */
  remoteUrl: string
  /**
   * En-tête HTTP d'authentification, ex.
   * `AUTHORIZATION: basic <base64("x-access-token:TOKEN")>`. Passé en `-c
   * http.extraHeader=…` À CHAQUE commande réseau (fetch/ls-remote/push),
   * jamais écrit dans `.git/config` ni journalisé (spec §5, dernier
   * paragraphe). `undefined` pour un remote qui n'en a pas besoin (dépôt
   * local des tests).
   */
  authHeader?: string
  authorName: string
  authorEmail: string
  /**
   * Dossier `node_modules` à lier symboliquement dans la copie de travail
   * (spec §1.3) pour que `scripts/validate-content.mjs` y résolve `yaml` sans
   * `npm ci` du site. `undefined` désactive le lien (utile si le workdir de
   * test fournit déjà ses propres `node_modules`).
   */
  nodeModulesSource?: string
}

/** Erreur Git — le message est déjà nettoyé de tout `authHeader` avant d'être levé. */
export class GitCommandError extends Error {}

/**
 * Opérations Git nécessaires à l'automatisation du blog (specs §0, §1.3, §5),
 * en ligne de commande (`git` doit être présent dans l'image — `api/Dockerfile`).
 *
 * Toutes les commandes réseau (`fetch`, `ls-remote`, `push`) passent par
 * `#networkArgs()`, qui injecte l'en-tête d'authentification en `-c
 * http.extraHeader=…` — jamais dans l'URL du remote, jamais dans
 * `.git/config` (spec §5).
 */
export class GitService {
  constructor(private readonly config: GitServiceConfig) {}

  get workdir(): string {
    return this.config.workdir
  }

  /** Nom de branche article/auteur — dérivé UNIQUEMENT d'un slug déjà validé (`isValidSlug`). */
  static articleBranch(slug: string): string {
    return `blog-ia/${slug}`
  }

  static auteurBranch(id: string): string {
    return `blog-ia/auteur-${id}`
  }

  async #run(args: string[], opts?: { cwd?: string }): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: opts?.cwd ?? this.config.workdir,
        // GIT_TERMINAL_PROMPT=0 : un jeton expiré/absent doit échouer
        // immédiatement, jamais attendre une saisie interactive impossible.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 32 * 1024 * 1024,
      })
      return stdout
    } catch (error) {
      throw new GitCommandError(this.#sanitize(this.#describe(error)))
    }
  }

  #describe(error: unknown): string {
    if (error && typeof error === 'object' && 'stderr' in error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim()
      if (stderr) return stderr
    }
    return error instanceof Error ? error.message : String(error)
  }

  /** Retire toute trace de l'en-tête d'authentification d'un message d'erreur. */
  #sanitize(message: string): string {
    if (!this.config.authHeader) return message
    return message.split(this.config.authHeader).join('[redacted]')
  }

  #networkArgs(): string[] {
    return this.config.authHeader ? ['-c', `http.extraHeader=${this.config.authHeader}`] : []
  }

  /** Clone si nécessaire, configure l'identité de commit, lie `node_modules` (spec §1.3). */
  async ensureWorkdir(): Promise<void> {
    if (!existsSync(join(this.config.workdir, '.git'))) {
      mkdirSync(dirname(this.config.workdir), { recursive: true })
      await this.#run(
        [...this.#networkArgs(), 'clone', this.config.remoteUrl, this.config.workdir],
        {
          cwd: dirname(this.config.workdir),
        }
      )
      await this.#run(['config', 'user.name', this.config.authorName])
      await this.#run(['config', 'user.email', this.config.authorEmail])
    }
    this.#ensureNodeModulesSymlink()
  }

  #ensureNodeModulesSymlink(): void {
    if (!this.config.nodeModulesSource) return
    const target = join(this.config.workdir, 'node_modules')
    if (existsSync(target)) return
    symlinkSync(this.config.nodeModulesSource, target, 'dir')
  }

  async fetchAll(): Promise<void> {
    await this.#run([...this.#networkArgs(), 'fetch', 'origin', '--prune'])
  }

  /** `true` si `origin/<branch>` existe APRÈS un `fetchAll()` récent. */
  async remoteBranchExists(branch: string): Promise<boolean> {
    try {
      await this.#run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
      return true
    } catch {
      return false
    }
  }

  /**
   * Prépare `branch` dans la copie de travail, prête à recevoir des écritures
   * (B2/B3) :
   *  - si `origin/<branch>` existe déjà (PR déjà ouverte) → la branche locale
   *    est réinitialisée dessus (reprend l'état exact de la PR en cours) ;
   *  - sinon → la branche est créée depuis `origin/main` (nouvel article, ou
   *    article déjà sur main sans branche IA).
   *
   * Retourne `isNew: true` quand la branche est créée depuis `main` (utile
   * pour distinguer 201 création / 200 mise à jour au niveau du contrôleur,
   * en complément de l'existence du fichier lui-même).
   */
  async prepareBranch(branch: string): Promise<{ isNew: boolean }> {
    await this.fetchAll()
    // Repart toujours d'un état propre : une opération précédente peut avoir
    // laissé des modifications non commitées (F2 : gate refusée sur une
    // publication) ou un fichier orphelin (image d'un essai précédent).
    await this.resetWorkingTree()
    const existsRemote = await this.remoteBranchExists(branch)
    await this.#run(['checkout', '-B', branch, existsRemote ? `origin/${branch}` : 'origin/main'])
    return { isNew: !existsRemote }
  }

  /**
   * Réinitialise la copie de travail à `HEAD` : annule tout non commité,
   * supprime tout fichier non suivi — À L'EXCEPTION de `node_modules`
   * (`-e node_modules`) : ce lien symbolique n'est PAS versionné (spec §1.3),
   * `git clean` le supprimerait sinon à chaque changement de branche.
   */
  async resetWorkingTree(): Promise<void> {
    await this.#run(['reset', '--hard', 'HEAD'])
    await this.#run(['clean', '-fd', '-e', 'node_modules'])
  }

  /** Lit un fichier à une référence donnée (`origin/main`, `origin/blog-ia/x`…) sans checkout. `null` si absent. */
  async readFileAtRef(ref: string, relPath: string): Promise<string | null> {
    try {
      return await this.#run(['show', `${ref}:${relPath}`])
    } catch {
      return null
    }
  }

  writeTextFile(relPath: string, content: string): void {
    const fullPath = join(this.config.workdir, relPath)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, content, 'utf8')
  }

  writeBinaryFile(relPath: string, content: Buffer): void {
    const fullPath = join(this.config.workdir, relPath)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, content)
  }

  readTextFile(relPath: string): string | null {
    const fullPath = join(this.config.workdir, relPath)
    if (!existsSync(fullPath)) return null
    return readFileSync(fullPath, 'utf8')
  }

  fileExists(relPath: string): boolean {
    return existsSync(join(this.config.workdir, relPath))
  }

  /** `git add -A && git commit`. Renvoie `false` si rien à committer (idempotence B2). */
  async commit(message: string): Promise<boolean> {
    await this.#run(['add', '-A'])
    try {
      await this.#run(['commit', '-m', message])
      return true
    } catch (error) {
      if (error instanceof GitCommandError && /nothing to commit/i.test(error.message)) {
        return false
      }
      throw error
    }
  }

  /** `--force-with-lease` (spec §0) : jamais d'écrasement d'un push concurrent inconnu. */
  async push(branch: string): Promise<void> {
    await this.#run([
      ...this.#networkArgs(),
      'push',
      '--force-with-lease',
      'origin',
      `${branch}:${branch}`,
    ])
  }
}
