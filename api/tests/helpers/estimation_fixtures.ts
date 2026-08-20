import { createHash } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'

import { seedReferenceData } from '#database/seed_data/seed_reference_data'
import { CoefficientsService } from '#services/coefficients_service'
import { DataVersionService } from '#services/data_version_service'
import { EstimationService } from '#services/estimation_service'

/**
 * Jeu de données minimal pour les tests d'estimation.
 *
 * Deux communes seulement, choisies pour couvrir les deux chemins qui
 * comptent :
 *  - **Guéret (23096)** — département réellement chargé en développement,
 *    couvert par DVF : chemin nominal par comparables ;
 *  - **Strasbourg (67482)** — `has_dvf = false` : repli §3.9, où la cascade ne
 *    doit **jamais** s'exécuter.
 *
 * Aucune dépendance réseau : `BAN_API_URL` pointe, en test, sur un port fermé.
 * Le géocodage échoue donc immédiatement et retombe sur le centroïde communal
 * (§3.1), ce qui rend les tests déterministes — et couvre au passage le
 * scénario « service public indisponible ».
 */

export const GUERET = {
  codeInsee: '23096',
  nom: 'Guéret',
  postalCode: '23000',
  lon: 1.87,
  lat: 46.17,
  codeDepartement: '23',
  codeRegion: '75',
  codeEpci: '200070100',
}

export const STRASBOURG = {
  codeInsee: '67482',
  nom: 'Strasbourg',
  postalCode: '67000',
  lon: 7.7521,
  lat: 48.5734,
  codeDepartement: '67',
  codeRegion: '44',
  codeEpci: '246700488',
}

/** Date `YYYY-MM-DD` située `months` mois avant aujourd'hui. */
export function monthsAgo(months: number): string {
  const now = new Date()
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, Math.min(now.getUTCDate(), 28))
  )
  return date.toISOString().slice(0, 10)
}

export async function resetEstimationFixtures(): Promise<void> {
  await db.rawQuery('DELETE FROM mutations')
  await db.rawQuery('DELETE FROM mutations_terrain')
  await db.rawQuery('DELETE FROM communes')
  await db.rawQuery('DELETE FROM geocode_cache')
  await db.rawQuery('DELETE FROM estimations_log')
  await db.rawQuery('DELETE FROM coefficients_reference')
  await db.rawQuery('DELETE FROM references_departementales')
  await db.rawQuery('DELETE FROM dataset_versions')

  // Les caches mémoire survivraient d'un test à l'autre et masqueraient les
  // changements de fixture. `DataVersionService` est mémorisé 60 s (M2) : sans
  // ce reset, un test qui vide `mutations` continuerait de lire l'inventaire
  // du test précédent.
  EstimationService.clearCache()
  CoefficientsService.resetCache()
  DataVersionService.resetCache()
}

async function insertCommune(
  commune: typeof GUERET,
  options: { hasDvf: boolean; population?: number }
): Promise<void> {
  await db.rawQuery(
    `INSERT INTO communes (
       code_insee, nom, nom_normalise, codes_postaux, code_departement, code_region,
       code_epci, population, centroid, has_dvf
     ) VALUES (
       ?, ?, ?, ARRAY[?]::text[], ?, ?, ?, ?,
       ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?
     )
     ON CONFLICT (code_insee) DO NOTHING`,
    [
      commune.codeInsee,
      commune.nom,
      commune.nom.toLowerCase(),
      commune.postalCode,
      commune.codeDepartement,
      commune.codeRegion,
      commune.codeEpci,
      options.population ?? 12_000,
      commune.lon,
      commune.lat,
      options.hasDvf,
    ]
  )
}

export async function seedCommunes(): Promise<void> {
  await insertCommune(GUERET, { hasDvf: true })
  await insertCommune(STRASBOURG, { hasDvf: false, population: 290_000 })
}

export interface MutationFixture {
  idMutation: string
  dateMutation: string
  typeLocal: 'appartement' | 'maison'
  surfaceBati: number
  valeurFonciere: number
  /** Décalage en degrés de longitude depuis le centroïde (~77 m à 46° N). */
  lonOffset?: number
  latOffset?: number
  codeInsee?: string
  codeDepartement?: string
  surfaceTerrain?: number
  geolocFine?: boolean
  isOutlier?: boolean
  adresseVoie?: string
}

export async function insertMutations(
  commune: typeof GUERET,
  mutations: MutationFixture[]
): Promise<void> {
  for (const mutation of mutations) {
    const lon = commune.lon + (mutation.lonOffset ?? 0)
    const lat = commune.lat + (mutation.latOffset ?? 0)

    await db.rawQuery(
      `INSERT INTO mutations (
         dedup_key, id_mutation, date_mutation, nature_mutation, valeur_fonciere,
         type_local, surface_bati, nb_pieces, surface_terrain, code_insee, code_departement,
         adresse_voie, code_postal, longitude, latitude, geom,
         is_outlier, geoloc_source, geoloc_fine, source_annee
       ) VALUES (
         ?, ?, ?, 'Vente', ?, ?, ?, 3, ?, ?, ?, ?, ?, ?, ?,
         ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography,
         ?, 'dvf', ?, ?
       )`,
      [
        createHash('sha256').update(mutation.idMutation).digest('hex'),
        mutation.idMutation,
        mutation.dateMutation,
        mutation.valeurFonciere,
        mutation.typeLocal,
        mutation.surfaceBati,
        mutation.surfaceTerrain ?? 0,
        mutation.codeInsee ?? commune.codeInsee,
        mutation.codeDepartement ?? commune.codeDepartement,
        mutation.adresseVoie ?? 'Rue de la Paix',
        commune.postalCode,
        lon,
        lat,
        lon,
        lat,
        mutation.isOutlier ?? false,
        mutation.geolocFine ?? true,
        Number(mutation.dateMutation.slice(0, 4)),
      ]
    )
  }
}

/**
 * 24 appartements comparables autour du centroïde de Guéret, à ~1 200 €/m².
 *
 * Volontairement au-delà du seuil de 15 du niveau L1 (§3.2) : un test qui
 * frôlerait le seuil casserait au moindre ajustement d'écrêtage, sans rien
 * dire d'utile.
 */
export async function seedGueretApartments(): Promise<void> {
  const mutations: MutationFixture[] = Array.from({ length: 24 }, (_, index) => {
    const surface = 60 + (index % 8)
    const pricePerSqm = 1_150 + (index % 5) * 40

    return {
      idMutation: `2025-guer-${index}`,
      // Étalées sur 18 mois : la fenêtre L1 (24 mois) les couvre toutes.
      dateMutation: monthsAgo(2 + (index % 17)),
      typeLocal: 'appartement' as const,
      surfaceBati: surface,
      valeurFonciere: surface * pricePerSqm,
      // Jusqu'à ~0,0024° ≈ 185 m : tout tient dans le rayon de 500 m.
      lonOffset: (index % 6) * 0.0004,
      latOffset: (index % 4) * 0.0003,
    }
  })

  await insertMutations(GUERET, mutations)
}

/**
 * 24 maisons comparables autour du centroïde de Guéret, à ~1 250 €/m², avec
 * un terrain d'environ 700 m².
 *
 * Le terrain médian des comparables est la référence de `V_terrain` (§3.6) :
 * un bien « dans la norme du secteur » ne doit rien gagner ni rien perdre.
 * Sans terrain sur les comparables, cette référence vaudrait 0 et le moindre
 * jardin serait valorisé en totalité.
 */
export async function seedGueretHouses(): Promise<void> {
  const mutations: MutationFixture[] = Array.from({ length: 24 }, (_, index) => {
    const surface = 95 + (index % 8) * 2
    const pricePerSqm = 1_200 + (index % 5) * 40

    return {
      idMutation: `2025-maison-${index}`,
      dateMutation: monthsAgo(2 + (index % 17)),
      typeLocal: 'maison' as const,
      surfaceBati: surface,
      valeurFonciere: surface * pricePerSqm,
      surfaceTerrain: 650 + (index % 5) * 25,
      lonOffset: (index % 6) * 0.0004,
      latOffset: (index % 4) * 0.0003,
    }
  })

  await insertMutations(GUERET, mutations)
}

/* ══════════════════════════════════════════════════════════════════════════
 * Terrains nus — `mutations_terrain` (§5.1)
 * ════════════════════════════════════════════════════════════════════════ */

export interface TerrainFixture {
  idMutation: string
  dateMutation: string
  surfaceTerrain: number
  valeurFonciere: number
  lonOffset?: number
  latOffset?: number
  codeInsee?: string
  codeDepartement?: string
  geolocFine?: boolean
  isOutlier?: boolean
}

export async function insertTerrains(
  commune: typeof GUERET,
  terrains: TerrainFixture[]
): Promise<void> {
  for (const terrain of terrains) {
    const lon = commune.lon + (terrain.lonOffset ?? 0)
    const lat = commune.lat + (terrain.latOffset ?? 0)

    await db.rawQuery(
      `INSERT INTO mutations_terrain (
         dedup_key, id_mutation, date_mutation, nature_mutation, valeur_fonciere,
         type_local, surface_bati, nb_pieces, surface_terrain, code_insee, code_departement,
         adresse_voie, code_postal, longitude, latitude, geom,
         is_outlier, geoloc_source, geoloc_fine, source_annee
       ) VALUES (
         ?, ?, ?, 'Vente', ?, 'terrain', NULL, NULL, ?, ?, ?, ?, ?, ?, ?,
         ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography,
         ?, 'dvf', ?, ?
       )`,
      [
        createHash('sha256').update(terrain.idMutation).digest('hex'),
        terrain.idMutation,
        terrain.dateMutation,
        terrain.valeurFonciere,
        terrain.surfaceTerrain,
        terrain.codeInsee ?? commune.codeInsee,
        terrain.codeDepartement ?? commune.codeDepartement,
        'Rue des Terrains',
        commune.postalCode,
        lon,
        lat,
        lon,
        lat,
        terrain.isOutlier ?? false,
        terrain.geolocFine ?? true,
        Number(terrain.dateMutation.slice(0, 4)),
      ]
    )
  }
}

/**
 * 14 terrains à bâtir autour du centroïde de Guéret, à ~50 €/m².
 *
 * Le seuil du niveau L1 pour un terrain est de 8 comparables (§3.2 : « seuils
 * divisés par 2 », plancher absolu de 5). On en pose largement plus, pour que
 * le test ne casse pas au moindre ajustement d'écrêtage.
 */
export async function seedGueretTerrains(): Promise<void> {
  const terrains: TerrainFixture[] = Array.from({ length: 14 }, (_, index) => {
    const surface = 800 + (index % 7) * 30
    const pricePerSqm = 46 + (index % 5) * 3

    return {
      idMutation: `2025-terr-${index}`,
      dateMutation: monthsAgo(2 + (index % 17)),
      surfaceTerrain: surface,
      valeurFonciere: surface * pricePerSqm,
      lonOffset: (index % 6) * 0.0004,
      latOffset: (index % 4) * 0.0003,
    }
  })

  await insertTerrains(GUERET, terrains)
}

/** Provisionne coefficients et références départementales (§3.6, §3.9). */
export async function seedReferences(): Promise<void> {
  await seedReferenceData(db)
  CoefficientsService.resetCache()
}

/** Millésime courant, sans lequel `X-Data-Version` n'est jamais posé. */
export async function seedDatasetVersion(version = 'dvf-2025-10'): Promise<void> {
  await db.rawQuery(
    `INSERT INTO dataset_versions (dataset_version, published_at, sources, is_current)
     VALUES (?, '2025-10-01T00:00:00Z', '[]'::jsonb, true)
     ON CONFLICT (dataset_version) DO UPDATE SET is_current = true`,
    [version]
  )
}

/** Payload valide minimal — aucune PII, conformément au §6.1. */
export function estimationPayload(overrides: Record<string, unknown> = {}) {
  return {
    address: '12 rue de la Paix',
    postalCode: GUERET.postalCode,
    city: GUERET.nom,
    propertyType: 'appartement',
    surface: 65,
    rooms: 3,
    dpe: 'C',
    ...overrides,
  }
}
