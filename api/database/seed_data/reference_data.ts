/**
 * Valeurs de départ des référentiels de calcul — spec §3.6, §3.9, §5.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SUR LES SOURCES — À LIRE AVANT DE MODIFIER UNE VALEUR
 * ══════════════════════════════════════════════════════════════════════════
 * `coefficients_reference.source_label` et `source_url` sont `NOT NULL`
 * (§5.1). Il aurait été facile de satisfaire la contrainte en inscrivant une
 * URL plausible vers les Notaires de France ou l'ADEME. **Ce n'est pas ce qui
 * est fait ici**, et c'est délibéré : une source inventée est pire qu'une
 * source absente, parce qu'elle a l'apparence de la vérification.
 *
 * Le §3.6 décrit ces valeurs comme « alignées sur les ordres de grandeur
 * publiés de la valeur verte » et les qualifie explicitement de
 * **provisoires**, remplacées au Lot 5 par une calibration sur nos propres
 * données (jointure DVF × DPE ADEME). Elles sont donc enregistrées pour ce
 * qu'elles sont : des paramètres de spécification, non vérifiés contre une
 * publication précise, sous une URN interne vérifiable
 * (`urn:estimer:spec/estimation-donnees-reelles#3.6`) et avec un `note` qui
 * le dit sans détour.
 *
 * Conséquence directe sur l'affichage (§3.6, règle 3) : tant que le Lot 5
 * n'est pas livré, la méthodologie doit dire « coefficients de valeur verte
 * de référence, provisoires », **jamais** « calculés à partir de nos
 * données ».
 *
 * Ce module est un simple porteur de données : il est importé par le seeder
 * Lucid (`node ace db:seed`) et par les tests, qui ont besoin des mêmes
 * valeurs sans dépendre de l'ordre d'exécution des seeders.
 */

/** URN interne : ni une URL inventée, ni un champ vide. */
export const SPEC_URN = 'urn:estimer:spec/estimation-donnees-reelles#3.6'

/** Étiquette commune aux valeurs de spécification non encore calibrées. */
export const PROVISIONAL_LABEL =
  'Valeur provisoire de la spécification produit (§3.6), ordre de grandeur ' +
  'de la valeur verte — à calibrer au Lot 5 sur DVF × DPE ADEME'

/** Date de la spécification qui porte ces valeurs. */
export const SPEC_DATE = '2026-08-19'

export interface CoefficientSeed {
  cle: string
  typeBien: 'appartement' | 'maison' | 'all'
  valeur: number
  sourceLabel: string
  sourceUrl: string
  dateSource: string
  note: string
}

function provisional(
  cle: string,
  typeBien: CoefficientSeed['typeBien'],
  valeur: number,
  note: string
): CoefficientSeed {
  return {
    cle,
    typeBien,
    valeur,
    sourceLabel: PROVISIONAL_LABEL,
    sourceUrl: SPEC_URN,
    dateSource: SPEC_DATE,
    note,
  }
}

/**
 * Table `k_dpe` du §3.6, référence D = 1,00, différenciée appartement/maison.
 *
 * L'écart maison > appartement est cohérent avec l'intuition de marché (une
 * maison mal isolée expose directement son propriétaire à la facture de
 * chauffage, un appartement bénéficie de l'inertie de l'immeuble), mais il
 * n'est **pas** issu d'une régression sur nos données : c'est précisément
 * l'objet du Lot 5.
 */
export const DPE_COEFFICIENTS: CoefficientSeed[] = [
  provisional('dpe.A', 'appartement', 1.06, 'Table k_dpe §3.6 — provisoire'),
  provisional('dpe.B', 'appartement', 1.05, 'Table k_dpe §3.6 — provisoire'),
  provisional('dpe.C', 'appartement', 1.03, 'Table k_dpe §3.6 — provisoire'),
  provisional('dpe.D', 'appartement', 1.0, 'Référence de la table k_dpe §3.6'),
  provisional('dpe.E', 'appartement', 0.96, 'Table k_dpe §3.6 — provisoire'),
  provisional('dpe.F', 'appartement', 0.91, 'Table k_dpe §3.6 — provisoire'),
  provisional('dpe.G', 'appartement', 0.87, 'Table k_dpe §3.6 — provisoire'),

  provisional('dpe.A', 'maison', 1.12, 'Table k_dpe §3.6 — provisoire'),
  provisional('dpe.B', 'maison', 1.09, 'Table k_dpe §3.6 — provisoire'),
  provisional('dpe.C', 'maison', 1.05, 'Table k_dpe §3.6 — provisoire'),
  provisional('dpe.D', 'maison', 1.0, 'Référence de la table k_dpe §3.6'),
  provisional('dpe.E', 'maison', 0.94, 'Table k_dpe §3.6 — provisoire'),
  provisional('dpe.F', 'maison', 0.88, 'Table k_dpe §3.6 — provisoire'),
  provisional('dpe.G', 'maison', 0.84, 'Table k_dpe §3.6 — provisoire'),
]

/** `k_etat` — §3.6. `unknown` n'est pas stocké : absence ⇒ 1,00 (neutre). */
export const CONDITION_COEFFICIENTS: CoefficientSeed[] = [
  provisional('etat.to-renovate', 'all', 0.88, 'k_etat §3.6 — provisoire'),
  provisional('etat.fair', 'all', 1.0, 'k_etat §3.6 — référence'),
  provisional('etat.good', 'all', 1.03, 'k_etat §3.6 — provisoire'),
  provisional('etat.new', 'all', 1.07, 'k_etat §3.6 — provisoire'),
]

/** `k_etage` — appartement uniquement (§3.6). */
export const FLOOR_COEFFICIENTS: CoefficientSeed[] = [
  provisional('etage.ground-floor', 'appartement', 0.95, 'RDC — k_etage §3.6'),
  provisional('etage.top-with-elevator', 'appartement', 1.05, 'Dernier étage avec ascenseur'),
  provisional('etage.high-no-elevator', 'appartement', 0.93, 'Étage ≥ 3 sans ascenseur'),
  provisional('etage.low-no-elevator', 'appartement', 0.98, 'Étage 1-2 sans ascenseur'),
]

/** `k_exterieur` — non cumulables, on retient le meilleur (§3.6). */
export const OUTDOOR_COEFFICIENTS: CoefficientSeed[] = [
  provisional('exterieur.none', 'all', 1.0, 'Aucun extérieur — référence'),
  provisional('exterieur.balcony', 'all', 1.02, 'k_exterieur §3.6 — provisoire'),
  provisional('exterieur.terrace', 'all', 1.04, 'k_exterieur §3.6 — provisoire'),
  provisional(
    'exterieur.garden',
    'appartement',
    1.06,
    'Jardin privatif en appartement. Non appliqué à la maison : déjà présent dans le comparable (§3.6).'
  ),
]

/**
 * `α` de la dégressivité `k_surface = (S_med / S) ^ α` (§3.6).
 *
 * Neutre (=1) quand le bien est à la médiane de son échantillon : c'est ce
 * qui évite le double comptage avec le filtre de surface ±30 % de la cascade.
 */
export const SURFACE_COEFFICIENTS: CoefficientSeed[] = [
  provisional('surface.alpha', 'appartement', 0.12, 'Exposant α §3.6 — à recalibrer au Lot 7'),
  provisional('surface.alpha', 'maison', 0.18, 'Exposant α §3.6 — à recalibrer au Lot 7'),
]

/**
 * Repli du prix du terrain quand aucune mutation de terrain n'est disponible
 * dans le périmètre : **8 % de `P_ref`** (§3.6). La spec la signale
 * elle-même comme « valeur de repli, à sourcer/calibrer ».
 */
export const LAND_COEFFICIENTS: CoefficientSeed[] = [
  provisional(
    'terrain.fallback_ratio',
    'all',
    0.08,
    'Repli §3.6 en l’absence de mutations de terrain comparables — explicitement « à sourcer/calibrer »'
  ),
]

export const ALL_COEFFICIENTS: CoefficientSeed[] = [
  ...DPE_COEFFICIENTS,
  ...CONDITION_COEFFICIENTS,
  ...FLOOR_COEFFICIENTS,
  ...OUTDOOR_COEFFICIENTS,
  ...SURFACE_COEFFICIENTS,
  ...LAND_COEFFICIENTS,
]

/* ══════════════════════════════════════════════════════════════════════════
 * Références départementales — §3.9
 * ════════════════════════════════════════════════════════════════════════ */

export interface DepartmentReferenceSeed {
  codeDepartement: string
  typeBien: 'appartement' | 'maison'
  prixM2: number
  sourceLabel: string
  sourceUrl: string | null
  dateSource: string
  note: string
}

/**
 * §3.9 laissait le choix entre « des références départementales sourcées
 * (observatoires notariaux locaux) » et, « à défaut, `src/data/prix.ts`
 * migré en base et explicitement étiqueté `source_label = 'Estimation
 * interne, hors DVF'` ».
 *
 * La question ouverte n° 1 du §11 (« dispose-t-on d'un accès à des références
 * notariales locales ? ») n'a pas de réponse au moment de ce lot : on
 * applique donc **le défaut prévu par la spec**, avec son étiquette exacte.
 * Ces quatre départements sont ceux du repli Livre foncier / Mayotte.
 *
 * Valeurs reprises telles quelles de `src/data/prix.ts` (front, données 2025) :
 * colonne `maisons` et colonne `apparts`.
 */
export const DEPARTMENT_REFERENCES: DepartmentReferenceSeed[] = [
  ref('57', 'maison', 1520, 'Moselle'),
  ref('57', 'appartement', 1950, 'Moselle'),
  ref('67', 'maison', 2320, 'Bas-Rhin'),
  ref('67', 'appartement', 2980, 'Bas-Rhin'),
  ref('68', 'maison', 1780, 'Haut-Rhin'),
  ref('68', 'appartement', 2280, 'Haut-Rhin'),
  ref('976', 'maison', 1780, 'Mayotte'),
  ref('976', 'appartement', 2280, 'Mayotte'),
]

function ref(
  codeDepartement: string,
  typeBien: 'appartement' | 'maison',
  prixM2: number,
  nom: string
): DepartmentReferenceSeed {
  return {
    codeDepartement,
    typeBien,
    prixM2,
    // Étiquette imposée mot pour mot par le §3.9.
    sourceLabel: 'Estimation interne, hors DVF',
    sourceUrl: null,
    dateSource: '2025-01-01',
    note:
      `${nom} — territoire absent de DVF (Livre foncier / Mayotte, §1.3). ` +
      'Valeur reprise de src/data/prix.ts (front, millésime 2025), non issue ' +
      "d'un observatoire notarial. À remplacer dès qu'une source locale est obtenue.",
  }
}
