/**
 * Verrou global en mémoire sérialisant l'accès à `BLOG_GIT_WORKDIR` (specs
 * §5 : « une seule copie partagée »). Deux requêtes qui écrivent en même
 * temps dans le même répertoire de travail Git se marcheraient dessus (index,
 * HEAD, fichiers non commités) — ce verrou garantit qu'une seule opération
 * Git tourne à la fois pour tout le process.
 *
 * Complémentaire du verrou PostgreSQL par slug (`BlogAdvisoryLock`), pas un
 * remplacement : l'advisory lock protège la RESSOURCE MÉTIER (un article),
 * potentiellement partagée entre plusieurs instances de l'API ; ce mutex
 * protège la RESSOURCE TECHNIQUE (le dossier), locale à ce process.
 */
export class WorkdirMutex {
  #queue: Promise<void> = Promise.resolve()

  /** Exécute `task` une fois que toute opération précédente est terminée. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#queue
    let release: () => void = () => {}
    this.#queue = new Promise((resolve) => {
      release = resolve
    })

    await previous
    try {
      return await task()
    } finally {
      release()
    }
  }
}

/** Instance partagée par tout le process — un seul `BLOG_GIT_WORKDIR` à la fois. */
export const blogWorkdirMutex = new WorkdirMutex()
