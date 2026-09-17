import pg from 'pg'
import env from '#start/env'

/**
 * Verrou PostgreSQL par slug (specs §5) : « `pg_try_advisory_lock(hashtext('blog:'
 * || slug))` (échec → 409), le même mécanisme que `dvf:import` ».
 *
 * Comme `DvfImporter` (`app/dvf/importer.ts`), une connexion `pg.Client`
 * DÉDIÉE — hors du pool applicatif — est indispensable : `pg_try_advisory_lock`
 * est attaché à la SESSION qui l'a pris, et doit être libéré depuis cette
 * même session. Passer par le pool de Lucid rendrait le "unlock" aléatoire :
 * une connexion différente du pool ne détient pas le verrou et ne peut pas le
 * lever.
 */
export class BlogAdvisoryLock {
  #client: pg.Client | null = null
  #key: string | null = null

  /**
   * Tente d'obtenir le verrou pour `key` (ex. `"blog:mon-slug"`). Ne bloque
   * jamais (`pg_try_advisory_lock`) : renvoie `false` immédiatement si une
   * autre session le détient déjà (G2 : 409 `operation_in_progress`).
   */
  async tryAcquire(key: string): Promise<boolean> {
    const client = new pg.Client({
      host: env.get('DB_HOST'),
      port: env.get('DB_PORT'),
      user: env.get('DB_USER'),
      password: env.get('DB_PASSWORD'),
      database: env.get('DB_DATABASE'),
    })
    await client.connect()

    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [key]
    )

    if (result.rows[0]?.locked !== true) {
      await client.end()
      return false
    }

    this.#client = client
    this.#key = key
    return true
  }

  /** Libère le verrou et ferme la connexion dédiée. Sans effet si rien n'est détenu. */
  async release(): Promise<void> {
    if (!this.#client) return
    try {
      await this.#client.query('SELECT pg_advisory_unlock(hashtext($1))', [this.#key])
    } finally {
      await this.#client.end()
      this.#client = null
      this.#key = null
    }
  }
}
