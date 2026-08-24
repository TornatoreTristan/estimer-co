import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'

/**
 * `node ace purge:logs` — spec §6.2, §8.3, §5.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CETTE COMMANDE EXISTE
 * ══════════════════════════════════════════════════════════════════════════
 * Trois endroits du code — la migration `estimations_log`, la migration
 * `geocode_cache` et le §8.3 — affirmaient qu'une « purge automatique par
 * tâche planifiée » assurait la rétention. **Aucune tâche n'existait.**
 *
 * L'écart n'était pas cosmétique : `geocode_cache` stocke des **adresses**,
 * donc des données à caractère personnel dès qu'elles sont reliables à une
 * personne (§8.3). Les entrées expirées restaient en base indéfiniment ;
 * `GeocodingService` les ignore à la lecture (`expires_at > now()`), si bien
 * que la conservation était à la fois **inutile au service** et **contraire à
 * la durée annoncée au registre des traitements**. C'est le pire des deux
 * mondes : on garde une donnée personnelle qui ne sert plus à rien.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PLANIFICATION
 * ══════════════════════════════════════════════════════════════════════════
 * Une fois par jour suffit largement (les volumes concernés se comptent en
 * milliers de lignes). Exemple de cron, à déclarer côté Coolify sur le
 * conteneur de l'API :
 *
 *   # Purge RGPD quotidienne — 03h15 UTC
 *   15 3 * * *  cd /app && node ace purge:logs
 *
 * La commande est **idempotente** : la rejouer ne supprime rien de plus.
 * Elle ne prend aucun verrou et n'interfère pas avec un import en cours.
 */
export default class PurgeLogs extends BaseCommand {
  static commandName = 'purge:logs'
  static description =
    'Purge les données à durée de conservation limitée : journal d’estimations (12 mois), cache de géocodage expiré (§8.3) et preuves de consentement partenaire (3 ans)'

  static options: CommandOptions = { startApp: true, staysAlive: false }

  @flags.number({
    description: 'Rétention du journal d’estimations, en mois. Défaut : 12 (§5.1)',
  })
  declare retentionMonths: number

  @flags.boolean({
    description: 'Simulation : compte les lignes concernées sans rien supprimer',
  })
  declare dryRun: boolean

  async run() {
    /*
     * 12 mois est la valeur de la spec (§5.1 : « estimations_log — anonymisé,
     * rétention 12 mois »). Le drapeau existe pour pouvoir purger plus court
     * en préproduction, jamais plus long : une rétention allongée en
     * production devrait passer par une mise à jour du registre.
     */
    const months =
      Number.isFinite(this.retentionMonths) && this.retentionMonths > 0
        ? Math.floor(this.retentionMonths)
        : 12

    this.logger.info(
      `Purge — journal d’estimations > ${months} mois, cache de géocodage expiré, ` +
        'preuves de consentement > 3 ans' +
        (this.dryRun ? ' — MODE SIMULATION (aucune suppression)' : '')
    )

    const logs = await this.#purge(
      'estimations_log',
      `created_at < now() - make_interval(months => ${months})`,
      `journal d’estimations de plus de ${months} mois`
    )

    /*
     * `expires_at < now()` : ce sont exactement les entrées que
     * `GeocodingService` refuse déjà de lire. Les supprimer ne dégrade donc
     * aucun taux de succès de cache — elle ne libère que de la donnée
     * personnelle devenue inutile.
     */
    const geocode = await this.#purge(
      'geocode_cache',
      'expires_at < now()',
      'entrées de cache de géocodage expirées (adresses, §8.3)'
    )

    /*
     * Preuves de consentement partenaire — 3 ans, durée annoncée par la
     * politique de confidentialité (section « Durées de conservation »).
     *
     * C'est la seule table de la purge qui contient des coordonnées en clair,
     * et donc la seule dont l'oubli constituerait une conservation excessive
     * plutôt qu'un simple encombrement. La rétention n'est PAS pilotable par
     * `--retention-months` : elle est adossée à un texte publié, pas à un
     * réglage d'exploitation.
     *
     * Le retrait du consentement ne raccourcit pas ce délai. Une ligne retirée
     * reste la preuve que l'accord a existé jusqu'à cette date-là — c'est ce
     * qui permet de justifier les mises en relation déjà faites, y compris
     * face à quelqu'un qui affirmerait n'avoir jamais consenti.
     */
    const consentements = await this.#purge(
      'partner_consents',
      "created_at < now() - interval '3 years'",
      'preuves de consentement partenaire de plus de 3 ans'
    )

    this.logger.info('─'.repeat(60))
    this.logger.success(
      this.dryRun
        ? `SIMULATION : ${logs} + ${geocode} + ${consentements} ligne(s) seraient supprimées.`
        : `Purge terminée : ${logs} ligne(s) de journal, ${geocode} entrée(s) de géocodage, ` +
            `${consentements} preuve(s) de consentement.`
    )
  }

  /**
   * Compte puis, hors simulation, supprime. Le comptage précède toujours la
   * suppression : c'est ce qui rend `--dry-run` strictement représentatif.
   */
  async #purge(table: string, predicate: string, label: string): Promise<number> {
    try {
      const counted = await db.rawQuery(
        `SELECT count(*)::bigint AS total FROM ${table} WHERE ${predicate}`
      )
      const total = Number(counted.rows?.[0]?.total ?? 0)

      if (total === 0) {
        this.logger.info(`  · ${label} : rien à purger.`)
        return 0
      }

      if (this.dryRun) {
        this.logger.info(`  · ${label} : ${total} ligne(s) concernée(s).`)
        return total
      }

      await db.rawQuery(`DELETE FROM ${table} WHERE ${predicate}`)
      this.logger.success(`  · ${label} : ${total} ligne(s) supprimée(s).`)
      return total
    } catch (error) {
      /*
       * Une table absente (base non migrée) ne doit pas faire échouer la
       * purge de l'autre : ce sont deux obligations indépendantes, et un cron
       * qui sort en erreur cesse souvent d'être surveillé.
       */
      this.logger.error(`  · ${label} : échec — ${(error as Error).message}`)
      this.exitCode = 1
      return 0
    }
  }
}
