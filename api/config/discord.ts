import env from '#start/env'
import { resolveDiscordSettings, type DiscordSettings } from '#lib/discord_config'

/**
 * Notification Discord des leads — lecture unique de l'environnement.
 *
 * Même découpage que `config/mail.ts` : ce fichier lit l'environnement, le
 * module `#lib/discord_config` porte les règles (pures, donc testables sans
 * booter l'application).
 *
 * Aucune variable n'est obligatoire. `DISCORD_WEBHOOK_URL` vide — le cas par
 * défaut, et celui de tous les déploiements existants — désactive purement et
 * simplement le canal : aucun appel réseau, aucun avertissement, rien à
 * reconfigurer.
 */
const settings: DiscordSettings = resolveDiscordSettings(
  {
    DISCORD_WEBHOOK_URL: env.get('DISCORD_WEBHOOK_URL'),
    DISCORD_TIMEOUT: env.get('DISCORD_TIMEOUT'),
    DISCORD_INCLUDE_CONTACT: env.get('DISCORD_INCLUDE_CONTACT'),
    DISCORD_MENTION: env.get('DISCORD_MENTION'),
    DISCORD_USERNAME: env.get('DISCORD_USERNAME'),
  },
  { inProduction: env.get('NODE_ENV') === 'production' }
)

export default settings

/**
 * Réexport nommé pour les appelants qui lisent aussi `mailSettings` : les deux
 * canaux se citent souvent dans la même ligne de code, autant que leurs
 * réglages se nomment pareil.
 *
 * Ce module porte l'URL du webhook, qui est un SECRET (droit de poster dans le
 * salon) : il ne doit JAMAIS être journalisé tel quel — cf.
 * `describeDiscordSettings()` pour une version publiable.
 */
export { settings as discordSettings }
