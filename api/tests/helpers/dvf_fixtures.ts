import { DVF_CSV_COLUMNS, type DvfRawRow } from '#dvf/csv_columns'

/**
 * Fabrique de lignes DVF pour les tests.
 *
 * Les valeurs par défaut reproduisent une ligne réelle du fichier
 * `2025/departements/23.csv.gz` (Creuse), pour que les tests portent sur des
 * données de la même forme que la production.
 */
export function dvfRow(overrides: Partial<DvfRawRow> = {}): DvfRawRow {
  const base: Partial<DvfRawRow> = {
    id_mutation: '2025-000001',
    date_mutation: '2025-01-08',
    numero_disposition: '000001',
    nature_mutation: 'Vente',
    valeur_fonciere: '119500',
    adresse_numero: '1',
    adresse_suffixe: '',
    adresse_nom_voie: 'SIBILOT',
    adresse_code_voie: 'B109',
    code_postal: '23800',
    code_commune: '23103',
    nom_commune: 'Lafat',
    code_departement: '23',
    id_parcelle: '231030000A0095',
    nombre_lots: '0',
    code_type_local: '1',
    type_local: 'Maison',
    surface_reelle_bati: '66',
    nombre_pieces_principales: '3',
    code_nature_culture: 'S',
    nature_culture: 'sols',
    surface_terrain: '60',
    longitude: '1.588795',
    latitude: '46.349388',
  }

  const row = {} as DvfRawRow
  for (const column of DVF_CSV_COLUMNS) {
    row[column] = ''
  }

  return Object.assign(row, base, overrides)
}

/** Sérialise des lignes en CSV DVF complet (en-tête compris). */
export function toCsv(rows: DvfRawRow[]): string {
  const header = DVF_CSV_COLUMNS.join(',')
  const body = rows.map((row) =>
    DVF_CSV_COLUMNS.map((column) => escapeCsv(row[column] ?? '')).join(',')
  )
  return [header, ...body].join('\n') + '\n'
}

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
