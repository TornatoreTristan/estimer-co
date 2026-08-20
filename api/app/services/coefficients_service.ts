import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import type {
  CoefficientTable,
  DpeClass,
  ConditionKey,
  OutdoorKey,
  FloorKey,
} from '#services/valuation_service'

/**
 * Chargement des coefficients d'ajustement depuis `coefficients_reference`
 * — spec §3.6, règle 1.
 *
 * « Tous les paramètres numériques sont stockés en base ou en configuration,
 * **jamais en dur dans le code** : ils devront être recalibrés (Lot 5/7) et
 * chaque valeur doit porter sa source » (§3).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * COMPORTEMENT EN CAS DE COEFFICIENT MANQUANT : 1,00, JAMAIS UNE VALEUR
 * DE SECOURS ÉCRITE ICI.
 * ══════════════════════════════════════════════════════════════════════════
 * Il aurait été tentant de recopier la table du §3.6 en dur « au cas où ».
 * Ce serait exactement le défaut que la spec corrige : une valeur en dur
 * n'est ni auditable, ni recalibrable sans déploiement, et surtout elle
 * masquerait une base mal provisionnée au lieu de la révéler. Une clé absente
 * vaut donc 1,00 — l'ajustement n'a pas lieu, et rien n'est inventé.
 */

/** Durée de mise en cache mémoire. Ces valeurs changent au rythme d'un lot. */
const CACHE_TTL_MS = 5 * 60 * 1_000

interface CoefficientRow {
  cle: string
  type_bien: string
  valeur: string | number
  updated_at: Date | string | null
  date_source: Date | string | null
  source_label?: string | null
  source_url?: string | null
}

/**
 * Provenance d'un coefficient — §3.6, règle 3 et §8.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CETTE INFORMATION DOIT SORTIR DE L'API
 * ══════════════════════════════════════════════════════════════════════════
 * `coefficients_reference.source_label` et `source_url` sont `NOT NULL` (§5.1)
 * précisément pour qu'aucun coefficient ne puisse exister sans source. La base
 * porte aujourd'hui la mention honnête « Valeur provisoire de la spécification
 * produit (§3.6) — à calibrer au Lot 5 » : elle n'atteignait aucun écran,
 * `method.coefficients` n'exposant que des nombres.
 *
 * Or le §3.6 impose que la méthodologie affichée dise « coefficients de valeur
 * verte de référence, provisoires » et **jamais** « calculés à partir de nos
 * données ». Sans cette information dans le DTO, le front ne pouvait tenir
 * cette obligation qu'en la recopiant en dur — c'est-à-dire en la figeant au
 * moment où le Lot 5 la rendra fausse.
 */
export interface CoefficientSource {
  /** Clé de `coefficients_reference`, ex. `dpe.C`, `surface.alpha`. */
  key: string
  /** Libellé français prêt à afficher, ex. « Valeur verte (DPE C) ». */
  label: string
  sourceLabel: string
  sourceUrl: string | null
  dateSource: string | null
}

export interface LoadedCoefficients {
  table: CoefficientTable
  /** Date de dernière mise à jour, exposée par `GET /v1/meta/data-version`. */
  updatedAt: string | null
  /** Nombre de lignes actives — 0 signale une base non provisionnée. */
  count: number
  /**
   * Provenance indexée par `cle|type_bien`, plus une entrée `cle|all` quand la
   * ligne vaut pour les deux types. L'appelant n'expose que les clés
   * réellement appliquées : lister les 20 lignes de la table sur chaque
   * réponse serait du bruit, pas de la transparence.
   */
  sources: Map<string, CoefficientSource>
}

/** Table entièrement neutre : aucun ajustement, aucune valeur inventée. */
export function neutralCoefficientTable(): CoefficientTable {
  return {
    dpe: { appartement: {}, maison: {} },
    condition: {},
    floor: {},
    outdoor: {},
    surfaceAlpha: {},
    terrainFallbackRatio: null,
  }
}

/**
 * Construit la table à partir des lignes de `coefficients_reference`.
 * **Fonction pure** : testable sans base, ce qui permet de vérifier le
 * routage des clés (`dpe.A`, `etat.good`, `surface.alpha`…) sans fixture SQL.
 */
export function buildCoefficientTable(rows: CoefficientRow[]): CoefficientTable {
  const table = neutralCoefficientTable()

  for (const row of rows) {
    const value = Number(row.valeur)
    if (!Number.isFinite(value)) {
      continue
    }

    const [family, key] = splitKey(row.cle)
    const typeBien = row.type_bien

    switch (family) {
      case 'dpe': {
        const targets =
          typeBien === 'all' ? (['appartement', 'maison'] as const) : ([typeBien] as const)
        for (const target of targets) {
          if (target === 'appartement' || target === 'maison') {
            table.dpe[target] = { ...(table.dpe[target] ?? {}), [key as DpeClass]: value }
          }
        }
        break
      }
      case 'etat':
        table.condition[key as ConditionKey] = value
        break
      case 'etage':
        table.floor[key as FloorKey] = value
        break
      case 'exterieur':
        table.outdoor[key as OutdoorKey] = value
        break
      case 'surface':
        if (key === 'alpha' && (typeBien === 'appartement' || typeBien === 'maison')) {
          table.surfaceAlpha[typeBien] = value
        }
        break
      case 'terrain':
        if (key === 'fallback_ratio') {
          table.terrainFallbackRatio = value
        }
        break
      default:
        // Une clé inconnue n'est pas une erreur : elle peut appartenir à un
        // lot ultérieur. On l'ignore sans bruit plutôt que d'échouer.
        break
    }
  }

  return table
}

function splitKey(cle: string): [string, string] {
  const index = cle.indexOf('.')
  if (index === -1) {
    return [cle, '']
  }
  return [cle.slice(0, index), cle.slice(index + 1)]
}

/** Clé d'indexation de `LoadedCoefficients.sources`. **Fonction pure.** */
export function coefficientSourceKey(cle: string, typeBien: string): string {
  return `${cle}|${typeBien}`
}

/* ── Libellés français des coefficients, prêts à afficher (§3.6, règle 3) ── */

const CONDITION_LABELS: Record<string, string> = {
  'to-renovate': 'à rénover',
  'fair': 'correct',
  'good': 'bon',
  'new': 'neuf',
}

const FLOOR_LABELS: Record<string, string> = {
  'ground-floor': 'rez-de-chaussée',
  'top-with-elevator': 'dernier étage avec ascenseur',
  'high-no-elevator': 'étage élevé sans ascenseur',
  'low-no-elevator': 'étage bas sans ascenseur',
}

const OUTDOOR_LABELS: Record<string, string> = {
  none: 'aucun extérieur',
  balcony: 'balcon',
  terrace: 'terrasse',
  garden: 'jardin',
}

/**
 * Libellé affichable d'une clé de coefficient. **Fonction pure.**
 *
 * Construit ici, jamais côté front : une clé technique (`etat.to-renovate`)
 * n'a rien à faire dans une méthodologie lue par un vendeur, et traduire côté
 * front obligerait à redéployer le site à chaque nouvelle clé.
 */
export function coefficientLabel(cle: string): string {
  const [family, key] = splitKey(cle)

  switch (family) {
    case 'dpe':
      return `Valeur verte (DPE ${key})`
    case 'etat':
      return `État du bien (${CONDITION_LABELS[key] ?? key})`
    case 'etage':
      return `Étage (${FLOOR_LABELS[key] ?? key})`
    case 'exterieur':
      return `Extérieur (${OUTDOOR_LABELS[key] ?? key})`
    case 'surface':
      return 'Dégressivité de la surface'
    case 'terrain':
      return 'Prix de terrain de repli'
    default:
      return cle
  }
}

export class CoefficientsService {
  static #cache: { value: LoadedCoefficients; expiresAt: number } | null = null

  /** Vide le cache mémoire — utilisé par les tests après un reseed. */
  static resetCache(): void {
    CoefficientsService.#cache = null
  }

  async load(): Promise<LoadedCoefficients> {
    const cached = CoefficientsService.#cache
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value
    }

    let rows: CoefficientRow[] = []
    try {
      const result = await db.rawQuery(
        `SELECT cle, type_bien, valeur, updated_at, date_source, source_label, source_url
           FROM coefficients_reference
          WHERE actif`
      )
      rows = result.rows ?? []
    } catch (error) {
      // Une base non migrée ne doit pas transformer une estimation en 500 :
      // elle donne une estimation sans ajustement, et le dit.
      logger.warn({ err: error }, 'Coefficients de référence illisibles, ajustements neutralisés')
    }

    const updatedAt = rows.reduce<string | null>((latest, row) => {
      const candidate = row.updated_at ?? row.date_source
      if (!candidate) {
        return latest
      }
      const iso = new Date(candidate).toISOString()
      return latest === null || iso > latest ? iso : latest
    }, null)

    const sources = new Map<string, CoefficientSource>()
    for (const row of rows) {
      if (!row.source_label) {
        // `source_label` est NOT NULL en base : une ligne sans source ne peut
        // venir que d'un environnement mal provisionné. On l'ignore plutôt
        // que d'inventer une provenance.
        continue
      }
      sources.set(coefficientSourceKey(row.cle, row.type_bien), {
        key: row.cle,
        label: coefficientLabel(row.cle),
        sourceLabel: row.source_label,
        sourceUrl: row.source_url ?? null,
        dateSource: row.date_source ? new Date(row.date_source).toISOString().slice(0, 10) : null,
      })
    }

    const value: LoadedCoefficients = {
      table: buildCoefficientTable(rows),
      updatedAt,
      count: rows.length,
      sources,
    }

    CoefficientsService.#cache = { value, expiresAt: Date.now() + CACHE_TTL_MS }
    return value
  }

  /**
   * Prix de référence départemental du repli §3.9.
   * `null` si le territoire n'a pas de référence : mieux vaut ne rien
   * afficher qu'un chiffre national déguisé en chiffre local.
   */
  async departmentReference(
    codeDepartement: string,
    typeBien: 'appartement' | 'maison'
  ): Promise<{ prixM2: number; sourceLabel: string; dateSource: string | null } | null> {
    try {
      const result = await db.rawQuery(
        `SELECT prix_m2, source_label, date_source
           FROM references_departementales
          WHERE code_departement = ? AND type_bien = ?
          LIMIT 1`,
        [codeDepartement, typeBien]
      )

      const row = result.rows?.[0]
      if (!row) {
        return null
      }

      return {
        prixM2: Number(row.prix_m2),
        sourceLabel: row.source_label,
        dateSource: row.date_source ? new Date(row.date_source).toISOString().slice(0, 10) : null,
      }
    } catch (error) {
      logger.warn({ err: error }, 'Références départementales illisibles')
      return null
    }
  }
}
