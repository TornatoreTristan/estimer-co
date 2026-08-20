/**
 * En-tête du CSV DVF géolocalisé (Etalab).
 *
 * Vérifié le 2026-08-19 sur
 * `https://files.data.gouv.fr/geo-dvf/latest/csv/2025/departements/23.csv.gz`
 * (40 colonnes, dans cet ordre exact).
 *
 * L'ordre est significatif : c'est celui attendu par le `COPY … FROM STDIN
 * WITH (FORMAT csv, HEADER true)` vers `mutations_staging`. Si Etalab ajoute
 * ou déplace une colonne, `assertCsvHeaderMatches()` fait échouer l'import
 * avec un message explicite plutôt que de charger des données décalées d'une
 * colonne — ce qui produirait des prix silencieusement faux.
 */
export const DVF_CSV_COLUMNS = [
  'id_mutation',
  'date_mutation',
  'numero_disposition',
  'nature_mutation',
  'valeur_fonciere',
  'adresse_numero',
  'adresse_suffixe',
  'adresse_nom_voie',
  'adresse_code_voie',
  'code_postal',
  'code_commune',
  'nom_commune',
  'code_departement',
  'ancien_code_commune',
  'ancien_nom_commune',
  'id_parcelle',
  'ancien_id_parcelle',
  'numero_volume',
  'lot1_numero',
  'lot1_surface_carrez',
  'lot2_numero',
  'lot2_surface_carrez',
  'lot3_numero',
  'lot3_surface_carrez',
  'lot4_numero',
  'lot4_surface_carrez',
  'lot5_numero',
  'lot5_surface_carrez',
  'nombre_lots',
  'code_type_local',
  'type_local',
  'surface_reelle_bati',
  'nombre_pieces_principales',
  'code_nature_culture',
  'nature_culture',
  'code_nature_culture_speciale',
  'nature_culture_speciale',
  'surface_terrain',
  'longitude',
  'latitude',
] as const

export type DvfCsvColumn = (typeof DVF_CSV_COLUMNS)[number]

/** Une ligne brute du CSV, telle que lue (toutes valeurs en chaîne). */
export type DvfRawRow = Record<DvfCsvColumn, string>

/**
 * Erreur levée quand l'en-tête du fichier source ne correspond plus à celui
 * attendu.
 */
export class DvfSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DvfSchemaError'
  }
}

/**
 * Vérifie que l'en-tête lu correspond exactement au schéma attendu.
 *
 * Fonction pure, testable sans réseau. Volontairement stricte : mieux vaut un
 * import qui refuse de démarrer qu'un import qui réussit en produisant des
 * valeurs décalées.
 */
export function assertCsvHeaderMatches(headerLine: string): void {
  const actual = headerLine
    // Retrait du BOM UTF-8 (U+FEFF) éventuellement présent en tête de fichier.
    .replace(/^\uFEFF/, '')
    .trim()
    .split(',')
    .map((column) => column.trim())

  const expected = [...DVF_CSV_COLUMNS]

  if (actual.length !== expected.length) {
    throw new DvfSchemaError(
      `Le fichier DVF ne contient pas le nombre de colonnes attendu ` +
        `(${expected.length} attendues, ${actual.length} lues). ` +
        `Le format publié par Etalab a probablement changé : vérifiez ` +
        `DVF_CSV_COLUMNS avant de relancer l'import.`
    )
  }

  const mismatch = expected.findIndex((column, index) => column !== actual[index])
  if (mismatch !== -1) {
    throw new DvfSchemaError(
      `Colonne DVF inattendue en position ${mismatch + 1} : ` +
        `« ${actual[mismatch]} » au lieu de « ${expected[mismatch]} ». ` +
        `Le format publié par Etalab a changé.`
    )
  }
}
