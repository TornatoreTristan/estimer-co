import Mutation from '#models/mutation'

/**
 * Mutation de terrain — spec §5.1.
 *
 * Même structure que `mutations`, `type_local = 'terrain'`, `surface_bati`
 * NULL et `prix_m2` calculé sur `surface_terrain`. Alimente le calcul de
 * `V_terrain` du §3.6 (Lot 2).
 */
export default class MutationTerrain extends Mutation {
  static table = 'mutations_terrain'
}
