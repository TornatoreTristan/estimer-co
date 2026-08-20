import { BaseSchema } from '@adonisjs/lucid/schema'
import { DVF_CSV_COLUMNS } from '#dvf/csv_columns'

/**
 * Table de staging de l'ingestion DVF — Annexe A.7.
 *
 * Trois propriétés délibérées :
 *
 *  1. **UNLOGGED** : aucune écriture dans le WAL, chargement 2 à 3× plus
 *     rapide. Le contenu est perdu en cas de crash, sans la moindre
 *     conséquence : le fichier source est re-téléchargeable et la table est
 *     tronquée à chaque département de toute façon.
 *
 *  2. **Toutes les colonnes en `text`** : le `COPY` ne doit jamais échouer
 *     sur une valeur mal typée. Un champ numérique vide ou fantaisiste dans
 *     le CSV source deviendrait une erreur bloquante au milieu d'un fichier
 *     de 500 000 lignes ; ici il est simplement rejeté, compté par motif, à
 *     l'étape de transformation SQL.
 *
 *  3. **Aucun index** : la table n'est jamais interrogée par clé, seulement
 *     balayée intégralement une fois. Un index ne ferait que ralentir le COPY.
 *
 * La structure est calquée sur l'en-tête réel du CSV DVF géolocalisé Etalab
 * (40 colonnes), vérifié sur `2025/departements/23.csv.gz`.
 */
export default class extends BaseSchema {
  protected tableName = 'mutations_staging'

  async up() {
    const columns = DVF_CSV_COLUMNS.map((column) => `  ${column} text`).join(',\n')

    /*
     * `line_no` donne un ordre STABLE aux lignes du fichier.
     *
     * Ce n'est pas cosmétique : la transformation doit désigner « la première
     * ligne du groupe » de façon déterministe (choix des coordonnées, du nom
     * de voie). Sans ordre explicite, PostgreSQL est libre de renvoyer les
     * lignes dans n'importe quel ordre et deux imports du même fichier
     * pourraient produire des points légèrement différents.
     */
    this.schema.raw(`
      CREATE UNLOGGED TABLE ${this.tableName} (
        line_no bigserial,
${columns}
      )
    `)
  }

  async down() {
    this.schema.raw(`DROP TABLE IF EXISTS ${this.tableName}`)
  }
}
