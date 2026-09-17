import { Octokit } from '@octokit/rest'

export interface PrInfo {
  number: number
  url: string
  state: 'open' | 'closed'
  /** `true` si la PR fermée l'a été par un merge (G2 : `pr_merged` vs `pr_closed`). */
  merged: boolean
}

/**
 * Ouverture/mise à jour de Pull Request — interface injectable (spec : « Git
 * et GitHub doivent être derrière des interfaces injectables pour que les
 * tests n'appellent jamais le vrai GitHub »). AUCUNE implémentation de cette
 * interface ne doit exposer de méthode de merge : F3/A3 (« aucun appel ne
 * peut merger une PR ») est garanti par absence de capacité, pas par un choix
 * au moment de l'appel.
 */
export interface PrService {
  /** PR ouverte pour `branch`, ou `null`. Utilisé pour mettre à jour plutôt que dupliquer. */
  findOpenPr(branch: string): Promise<PrInfo | null>
  createPr(params: { branch: string; base: string; title: string; body: string }): Promise<PrInfo>
  updatePr(number: number, params: { title?: string; body?: string }): Promise<PrInfo>
  /** État à jour, relu sur GitHub (G2 : `GET /jobs/:id` détecte un merge/fermeture externe). */
  getPr(number: number): Promise<PrInfo>
}

export interface GithubPrServiceConfig {
  token: string
  owner: string
  repo: string
  /** Point de bascule test uniquement (défaut `https://api.github.com`). */
  baseUrl?: string
}

/**
 * Implémentation réelle via `@octokit/rest`. Le jeton ne transite QUE dans
 * l'en-tête `Authorization` géré par Octokit — jamais journalisé ici (aucun
 * `console.log`/`logger` de la config ou d'une erreur brute dans cette
 * classe).
 */
export class GithubPrService implements PrService {
  #octokit: Octokit
  #owner: string
  #repo: string

  constructor(config: GithubPrServiceConfig) {
    this.#octokit = new Octokit({ auth: config.token, baseUrl: config.baseUrl })
    this.#owner = config.owner
    this.#repo = config.repo
  }

  async findOpenPr(branch: string): Promise<PrInfo | null> {
    const { data } = await this.#octokit.rest.pulls.list({
      owner: this.#owner,
      repo: this.#repo,
      state: 'open',
      head: `${this.#owner}:${branch}`,
    })
    const pr = data[0]
    if (!pr) return null
    return { number: pr.number, url: pr.html_url, state: 'open', merged: false }
  }

  async createPr(params: {
    branch: string
    base: string
    title: string
    body: string
  }): Promise<PrInfo> {
    const { data } = await this.#octokit.rest.pulls.create({
      owner: this.#owner,
      repo: this.#repo,
      head: params.branch,
      base: params.base,
      title: params.title,
      body: params.body,
    })
    return { number: data.number, url: data.html_url, state: 'open', merged: false }
  }

  async updatePr(number: number, params: { title?: string; body?: string }): Promise<PrInfo> {
    const { data } = await this.#octokit.rest.pulls.update({
      owner: this.#owner,
      repo: this.#repo,
      pull_number: number,
      ...params,
    })
    return {
      number: data.number,
      url: data.html_url,
      state: data.state === 'closed' ? 'closed' : 'open',
      merged: Boolean(data.merged_at),
    }
  }

  async getPr(number: number): Promise<PrInfo> {
    const { data } = await this.#octokit.rest.pulls.get({
      owner: this.#owner,
      repo: this.#repo,
      pull_number: number,
    })
    return {
      number: data.number,
      url: data.html_url,
      state: data.state === 'closed' ? 'closed' : 'open',
      merged: Boolean(data.merged_at),
    }
  }
}
