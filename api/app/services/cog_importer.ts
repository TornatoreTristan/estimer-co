import db from '@adonisjs/lucid/services/db'
import { DEPARTMENTS_WITHOUT_DVF } from '#dvf/importer'

/**
 * Import du référentiel communal INSEE — spec §5.1, Lot 1.
 *
 * Source retenue : **API Découpage administratif** (`geo.api.gouv.fr`), qui
 * expose en une seule requête tout ce dont on a besoin — code INSEE, nom,
 * codes postaux, département, région, EPCI, population et centroïde — là où
 * le COG brut de l'INSEE demanderait de croiser quatre fichiers.
 * Vérifié le 2026-08-19 : 34 969 communes, toutes avec centroïde.
 *
 * La **grille de densité INSEE** (`densite_grille`, 1 à 7) n'est pas fournie
 * par cette API : elle est laissée à `NULL` et alimentée séparément. Le Lot 2
 * en a besoin pour la strate du niveau L9 (§3.2) — voir le rapport de lot.
 */

/** Forme d'une commune telle que renvoyée par `geo.api.gouv.fr`. */
export interface RawCommune {
  code: string
  nom: string
  codesPostaux?: string[]
  codeDepartement?: string
  codeRegion?: string
  codeEpci?: string
  population?: number
  centre?: { type: string; coordinates: [number, number] }
}

export interface CogImportResult {
  read: number
  upserted: number
  /** Communes écartées faute de données exploitables (centroïde absent…). */
  skipped: number
  /** Communes hors du périmètre géographique de la spec (§2.7). */
  outOfScope: number
  withoutDvf: number
}

/** Abstraction de la source, pour tester sans réseau. */
export interface CommunesSource {
  fetchAll(): Promise<RawCommune[]>
}

export class HttpCommunesSource implements CommunesSource {
  constructor(
    private readonly url = 'https://geo.api.gouv.fr/communes',
    private readonly timeoutMs = 120_000
  ) {}

  async fetchAll(): Promise<RawCommune[]> {
    const url = new URL(this.url)
    url.searchParams.set(
      'fields',
      'nom,code,codesPostaux,codeEpci,codeDepartement,codeRegion,population,centre'
    )
    url.searchParams.set('format', 'json')

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!response.ok) {
      throw new Error(`Référentiel communal indisponible (HTTP ${response.status}).`)
    }

    return (await response.json()) as RawCommune[]
  }
}

/**
 * Normalise un nom de commune pour la recherche floue : minuscules, sans
 * accent. Fonction pure.
 *
 * C'est ce qui remplace définitivement le matching `includes()` de l'ancien
 * algorithme, où « Metz » matchait « Metz-en-Couture ».
 */
export function normalizeCommuneName(nom: string): string {
  return nom.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

/**
 * Détermine la couverture DVF d'une commune — §1.3.
 *
 * Bas-Rhin (67), Haut-Rhin (68) et Moselle (57) relèvent du Livre foncier ;
 * Mayotte (976) est également absente de DVF. Fonction pure.
 */
export function hasDvfCoverage(codeDepartement: string): boolean {
  return !DEPARTMENTS_WITHOUT_DVF.includes(codeDepartement)
}

/**
 * Périmètre géographique de la spec — §2.7.
 *
 * « France entière, ~34 900 communes, DOM inclus (971 Guadeloupe,
 * 972 Martinique, 973 Guyane, 974 La Réunion) », plus 976 (Mayotte), retenue
 * pour porter `has_dvf = false` (§1.3).
 *
 * Sont donc écartées les collectivités d'outre-mer hors périmètre : 975
 * (Saint-Pierre-et-Miquelon), 977/978 (Saint-Barthélemy, Saint-Martin) et
 * 984 à 989 (TAAF, Wallis-et-Futuna, Polynésie, Nouvelle-Calédonie…).
 *
 * Ce n'est pas un détail cosmétique : ces territoires portent un code de
 * région à 3 caractères (« 988 »), incompatible avec `communes.code_region
 * char(2)` défini au §5.1. Sans ce filtre, l'import échoue en cours de route
 * sur un dépassement de longueur — précisément le symptôme observé.
 */
export function isInScope(commune: RawCommune): boolean {
  const departement = commune.codeDepartement ?? commune.code.slice(0, 2)
  return /^(\d{2}|2A|2B|97[1-46])$/.test(departement)
}

/** Retient les communes exploitables (code INSEE et centroïde présents). */
export function isImportable(commune: RawCommune): boolean {
  return (
    typeof commune.code === 'string' &&
    commune.code.length === 5 &&
    typeof commune.nom === 'string' &&
    commune.nom.length > 0 &&
    Array.isArray(commune.centre?.coordinates) &&
    commune.centre.coordinates.length === 2 &&
    Number.isFinite(commune.centre.coordinates[0]) &&
    Number.isFinite(commune.centre.coordinates[1])
  )
}

export class CogImporter {
  constructor(private readonly source: CommunesSource = new HttpCommunesSource()) {}

  async run(options: { dryRun?: boolean; batchSize?: number } = {}): Promise<CogImportResult> {
    const communes = await this.source.fetchAll()
    const batchSize = options.batchSize ?? 500

    const result: CogImportResult = {
      read: communes.length,
      upserted: 0,
      skipped: 0,
      outOfScope: 0,
      withoutDvf: 0,
    }

    const importable = communes.filter((commune) => {
      if (!isInScope(commune)) {
        result.outOfScope += 1
        return false
      }
      if (!isImportable(commune)) {
        result.skipped += 1
        return false
      }
      return true
    })

    if (options.dryRun) {
      result.withoutDvf = importable.filter(
        (commune) => !hasDvfCoverage(commune.codeDepartement ?? commune.code.slice(0, 2))
      ).length
      return result
    }

    for (let offset = 0; offset < importable.length; offset += batchSize) {
      const batch = importable.slice(offset, offset + batchSize)
      result.upserted += await this.#upsertBatch(batch)
    }

    /*
     * Positionnement explicite de `has_dvf` en une seule instruction, APRÈS
     * l'insertion. Le faire en SQL plutôt qu'en JavaScript garantit que la
     * règle s'applique aussi aux lignes déjà présentes, y compris si la liste
     * des départements non couverts venait à changer.
     */
    const flagged = await db.rawQuery(
      `UPDATE communes
          SET has_dvf = (code_departement <> ALL (:missing::text[]))
        WHERE has_dvf <> (code_departement <> ALL (:missing::text[]))`,
      { missing: DEPARTMENTS_WITHOUT_DVF }
    )

    const withoutDvf = await db.from('communes').where('has_dvf', false).count('* as total').first()

    result.withoutDvf = Number(withoutDvf?.total ?? 0)

    void flagged
    return result
  }

  /**
   * Upsert d'un lot de communes en UNE requête.
   *
   * `unnest` de tableaux parallèles : une seule instruction quel que soit le
   * nombre de lignes, là où un `INSERT` par commune ferait 35 000
   * aller-retours réseau.
   */
  async #upsertBatch(batch: RawCommune[]): Promise<number> {
    const codes = batch.map((commune) => commune.code)
    const noms = batch.map((commune) => commune.nom)
    const nomsNormalises = batch.map((commune) => normalizeCommuneName(commune.nom))
    const codesPostaux = batch.map(
      (commune) => `{${(commune.codesPostaux ?? []).map((cp) => `"${cp}"`).join(',')}}`
    )
    const departements = batch.map((commune) => commune.codeDepartement ?? commune.code.slice(0, 2))
    const regions = batch.map((commune) => commune.codeRegion ?? '')
    const epcis = batch.map((commune) => commune.codeEpci ?? null)
    const populations = batch.map((commune) => commune.population ?? null)
    const lons = batch.map((commune) => commune.centre!.coordinates[0])
    const lats = batch.map((commune) => commune.centre!.coordinates[1])

    await db.rawQuery(
      `INSERT INTO communes (
         code_insee, nom, nom_normalise, codes_postaux, code_departement,
         code_region, code_epci, population, centroid, has_dvf, updated_at
       )
       SELECT
         t.code, t.nom, t.nom_normalise, t.codes_postaux::text[], t.departement,
         t.region, t.epci, t.population,
         ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)::geography,
         (t.departement <> ALL (:missing::text[])),
         now()
       FROM unnest(
         :codes::text[], :noms::text[], :nomsNormalises::text[], :codesPostaux::text[],
         :departements::text[], :regions::text[], :epcis::text[],
         :populations::integer[], :lons::double precision[], :lats::double precision[]
       ) AS t(code, nom, nom_normalise, codes_postaux, departement, region, epci,
              population, lon, lat)
       ON CONFLICT (code_insee) DO UPDATE SET
         nom              = EXCLUDED.nom,
         nom_normalise    = EXCLUDED.nom_normalise,
         codes_postaux    = EXCLUDED.codes_postaux,
         code_departement = EXCLUDED.code_departement,
         code_region      = EXCLUDED.code_region,
         code_epci        = EXCLUDED.code_epci,
         population       = EXCLUDED.population,
         centroid         = EXCLUDED.centroid,
         has_dvf          = EXCLUDED.has_dvf,
         updated_at       = now()`,
      {
        codes,
        noms,
        nomsNormalises,
        codesPostaux,
        departements,
        regions,
        epcis,
        populations,
        lons,
        lats,
        missing: DEPARTMENTS_WITHOUT_DVF,
      }
    )

    return batch.length
  }
}
