import env from '#start/env'
import { defineConfig, drivers } from '@adonisjs/core/encryption'

/**
 * The app key is used for encrypting cookies, generating signed URLs,
 * and by the "encryption" module.
 *
 * The encryption module will fail to decrypt data if the key is lost or
 * changed. Therefore it is recommended to keep the app key secure.
 *
 * Le driver `legacy` reproduit le format de chiffrement d'AdonisJS v6 : il
 * garantit que les données déjà chiffrées (cookies signés notamment) restent
 * déchiffrables après la montée en v7.
 */
export default defineConfig({
  default: 'legacy',
  list: {
    legacy: drivers.legacy({
      keys: [env.get('APP_KEY')],
    }),
  },
})
