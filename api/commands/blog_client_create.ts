import { randomBytes } from 'node:crypto'
import { args, BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

import BlogApiClient, { BLOG_SCOPES, type BlogScope } from '#models/blog_api_client'
import { sha256Hex } from '#services/blog/hash'

/**
 * `node ace blog:client:create <nom> --scopes=articles:write,publish:request`
 *
 * Crée un client autorisé à appeler `/v1/blog/**` (spec §5) et affiche son
 * jeton EN CLAIR une seule fois — il n'est jamais récupérable ensuite,
 * seule son empreinte SHA-256 est conservée en base.
 */
export default class BlogClientCreate extends BaseCommand {
  static commandName = 'blog:client:create'
  static description =
    'Crée un client (jeton Bearer) autorisé sur /v1/blog/**, affiche le jeton une seule fois'

  static options: CommandOptions = {
    startApp: true,
    staysAlive: false,
  }

  @args.string({ description: 'Nom du client, ex. "agent-redaction-ia"' })
  declare name: string

  @flags.string({
    description: `Scopes séparés par des virgules parmi : ${BLOG_SCOPES.join(', ')}`,
  })
  declare scopes: string

  async run() {
    if (!this.name || this.name.trim().length === 0) {
      this.logger.error('Nom de client requis : node ace blog:client:create <nom> --scopes=...')
      this.exitCode = 1
      return
    }

    const requestedScopes = (this.scopes ?? '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean)

    const invalidScopes = requestedScopes.filter(
      (scope) => !BLOG_SCOPES.includes(scope as BlogScope)
    )
    if (invalidScopes.length > 0) {
      this.logger.error(
        `Scope(s) inconnu(s) : ${invalidScopes.join(', ')}. Valeurs autorisées : ${BLOG_SCOPES.join(', ')}.`
      )
      this.exitCode = 1
      return
    }

    // 32 octets aléatoires en hexadécimal : jamais journalisé au-delà de
    // cette unique impression, ni conservé en base (seule l'empreinte l'est).
    const token = randomBytes(32).toString('hex')

    const client = await BlogApiClient.create({
      name: this.name,
      tokenHash: sha256Hex(token),
      scopes: requestedScopes,
    })

    this.logger.success(`Client "${client.name}" créé (id ${client.id}).`)
    this.logger.log('')
    this.logger.log(`Jeton (à copier MAINTENANT, il ne sera plus jamais affiché) :`)
    this.logger.log(token)
    this.logger.log('')
    this.logger.log(
      `Scopes : ${requestedScopes.length > 0 ? requestedScopes.join(', ') : '(aucun)'}`
    )
  }
}
