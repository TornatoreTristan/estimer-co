import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Coefficients d'ajustement du bien — spec §5.1, §3.6, §8.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE CENTRALE : UN COEFFICIENT SANS SOURCE NE PEUT PAS EXISTER.
 * ══════════════════════════════════════════════════════════════════════════
 * `source_label` et `source_url` sont `NOT NULL` **par décision de spec**
 * (§5.1 et §8.4), pas par confort de modélisation. Le produit affiche « prix
 * le plus juste » : chaque pourcentage appliqué à une valeur doit pouvoir
 * être justifié devant un vendeur qui conteste. La base est le dernier
 * rempart : si la contrainte n'était pas là, un coefficient inventé finirait
 * tôt ou tard par y entrer.
 *
 * Conséquence pratique : le seeder ne fabrique JAMAIS d'URL. Quand la source
 * précise n'a pas pu être vérifiée, il écrit une valeur explicitement
 * provisoire (`urn:estimer:spec/...`) et le `note` le dit — c'est vérifiable
 * et honnête, contrairement à un lien plausible mais faux.
 *
 * Les valeurs sont **provisoires** jusqu'au Lot 5 (calibration sur DVF × DPE
 * ADEME, par strate de densité INSEE) : d'où `densite_min` / `densite_max`,
 * déjà prévues alors qu'elles restent nulles au Lot 2.
 */
export default class extends BaseSchema {
  protected tableName = 'coefficients_reference'

  async up() {
    this.schema.raw(`
      CREATE TABLE ${this.tableName} (
        id            bigserial PRIMARY KEY,

        -- 'dpe.A' … 'dpe.G', 'etat.to-renovate', 'etage.ground-floor',
        -- 'exterieur.balcony', 'surface.alpha', 'terrain.fallback_ratio'…
        cle           text          NOT NULL,

        -- 'appartement' | 'maison' | 'all' (coefficient non différencié).
        type_bien     text          NOT NULL DEFAULT 'all',

        valeur        numeric(6,4)  NOT NULL,

        -- §5.1 : « source_label et source_url sont NOT NULL : un coefficient
        -- sans source ne peut pas exister ».
        source_label  text          NOT NULL,
        source_url    text          NOT NULL,
        date_source   date          NOT NULL,

        -- Strate de densité INSEE (1 à 7). Nulles au Lot 2 : la calibration
        -- par strate arrive au Lot 5. La colonne existe déjà pour que ce lot
        -- n'ait pas à migrer une table déjà en production.
        densite_min   smallint      NULL,
        densite_max   smallint      NULL,

        actif         boolean       NOT NULL DEFAULT true,
        note          text          NULL,
        updated_at    timestamptz   NOT NULL DEFAULT now(),

        CONSTRAINT coefficients_reference_source_label_chk
          CHECK (length(btrim(source_label)) > 0),
        CONSTRAINT coefficients_reference_source_url_chk
          CHECK (length(btrim(source_url)) > 0),
        CONSTRAINT coefficients_reference_densite_chk
          CHECK (densite_min IS NULL OR densite_max IS NULL OR densite_min <= densite_max)
      )
    `)

    /*
     * Unicité §5.1 : `(cle, type_bien, densite_min, densite_max) WHERE actif`.
     * Deux coefficients actifs pour la même clé rendraient le calcul
     * dépendant de l'ordre de lecture — c'est-à-dire non reproductible.
     *
     * `coalesce(-1)` : en SQL, `NULL = NULL` est inconnu, un index unique ne
     * bloquerait donc pas deux lignes nationales (densité nulle) portant la
     * même clé. La substitution rend la contrainte réellement effective.
     */
    this.schema.raw(`
      CREATE UNIQUE INDEX coefficients_reference_cle_uniq
        ON ${this.tableName} (cle, type_bien, coalesce(densite_min, -1), coalesce(densite_max, -1))
        WHERE actif
    `)

    this.schema.raw(
      `CREATE INDEX coefficients_reference_actif_idx ON ${this.tableName} (cle) WHERE actif`
    )
  }

  async down() {
    this.schema.raw(`DROP TABLE IF EXISTS ${this.tableName}`)
  }
}
