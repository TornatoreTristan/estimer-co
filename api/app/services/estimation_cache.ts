/**
 * Cache applicatif des estimations — spec §2.6, point 4.
 *
 * « Réponse mise en cache 24 h sur la clé `(round(lat,3), round(lon,3), type,
 * tranche_surface_10m2, dpe, options)` → un même quartier interrogé en boucle
 * ne recalcule pas. Absorbe l'essentiel d'un abus “lent”. »
 *
 * L'arrondi à 3 décimales représente ~110 m de latitude : deux adresses de la
 * même rue partagent donc leur résultat, ce qui est exactement l'intention —
 * à cette échelle, les comparables sélectionnés sont les mêmes.
 *
 * ── CORRECTION : LA SURFACE ENTRE DANS LA CLÉ **EXACTE**, PAS PAR TRANCHE ──
 * Le §2.6 proposait une tranche de 10 m². Cette agrégation est **fausse** ici,
 * et l'écart est directement visible par l'utilisateur : le §3.7 pose
 * `V = P_ref × k_total × S`, où la surface **multiplie** le résultat. Deux
 * biens de 100 et 108 m² de la même tranche recevaient donc la même `value`
 * et le même `pricePerSqm`, si bien que le rapport et le PDF affichaient
 * `value ≠ pricePerSqm × surface` — une incohérence arithmétique de 7 % que
 * n'importe quel lecteur peut refaire de tête.
 *
 * Le gain de taux de succès sacrifié est nul : `options` contient déjà
 * l'adresse exacte, le code postal et la ville, si bien que deux requêtes ne
 * partageaient jamais une clé sans porter *exactement* la même adresse — donc,
 * en pratique, la même surface.
 *
 * ── Choix : cache **en mémoire du processus**, pas en base ────────────────
 * Ce cache est une optimisation, jamais une source de vérité. Le stocker en
 * base ajouterait une écriture sur le chemin chaud et une table à purger,
 * pour absorber une charge qu'un seul processus absorbe déjà. Conséquence
 * assumée : avec plusieurs répliques, chacune a son cache, et un
 * redémarrage le vide. Aucune de ces deux propriétés n'a d'effet visible sur
 * la justesse du résultat.
 */

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export interface EstimationCacheKeyParts {
  lat: number | null
  lon: number | null
  cityCode: string | null
  propertyType: string
  surface: number
  dpe: string
  /** Options facultatives influençant le calcul (étage, extérieur, état…). */
  options: Array<string | number | boolean | null | undefined>
  /** Millésime des données : un nouvel import invalide tout le cache. */
  datasetVersion: string | null
}

/**
 * Clé de cache — **fonction pure**, testable sans horloge ni base.
 *
 * `datasetVersion` en fait partie : sans lui, un import DVF frais mettrait
 * jusqu'à 24 h à devenir visible, et deux utilisateurs verraient des prix
 * différents pour la même adresse selon l'heure de leur requête.
 */
export function buildEstimationCacheKey(parts: EstimationCacheKeyParts): string {
  const lat = parts.lat === null ? 'na' : parts.lat.toFixed(3)
  const lon = parts.lon === null ? 'na' : parts.lon.toFixed(3)
  /*
   * Surface EXACTE, au dixième de m² près — jamais une tranche.
   * Voir l'avertissement en tête de module : la surface multiplie la valeur,
   * l'agréger revenait à servir à un bien le prix d'un autre.
   */
  const surface = Math.max(0, parts.surface).toFixed(1)

  return [
    parts.datasetVersion ?? 'no-version',
    parts.cityCode ?? 'no-insee',
    lat,
    lon,
    parts.propertyType,
    surface,
    parts.dpe,
    ...parts.options.map((option) =>
      option === null || option === undefined ? '' : String(option)
    ),
  ].join('|')
}

export class EstimationCache<T> {
  #entries = new Map<string, CacheEntry<T>>()

  constructor(
    private readonly ttlSeconds: number,
    /** Borne dure : un cache non borné est une fuite mémoire différée. */
    private readonly maxEntries = 5_000
  ) {}

  /** `now` est injecté pour que les tests n'aient pas à attendre 24 h. */
  get(key: string, now: number = Date.now()): T | null {
    const entry = this.#entries.get(key)
    if (!entry) {
      return null
    }
    if (entry.expiresAt <= now) {
      this.#entries.delete(key)
      return null
    }
    return entry.value
  }

  set(key: string, value: T, now: number = Date.now()): void {
    if (this.#entries.size >= this.maxEntries) {
      // Éviction du plus ancien inséré : suffisante pour un cache de
      // protection, et sans structure supplémentaire à maintenir.
      const oldest = this.#entries.keys().next()
      if (!oldest.done) {
        this.#entries.delete(oldest.value)
      }
    }
    this.#entries.set(key, { value, expiresAt: now + this.ttlSeconds * 1_000 })
  }

  clear(): void {
    this.#entries.clear()
  }

  get size(): number {
    return this.#entries.size
  }
}
