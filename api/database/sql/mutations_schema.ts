/**
 * Définition SQL des tables de mutations — spec §5.1 + Annexe A.
 *
 * `mutations` (bâti) et `mutations_terrain` partagent la même structure
 * (§5.1) ; seule la colonne servant de dénominateur au prix au m² change :
 *   - bâti    → `prix_m2 = valeur_fonciere / surface_bati`
 *   - terrain → `prix_m2 = valeur_fonciere / surface_terrain`
 *
 * Le SQL est factorisé ici plutôt que dupliqué dans deux migrations : une
 * divergence entre les deux tables (un index oublié d'un côté) se paierait
 * en requêtes lentes très difficiles à diagnostiquer.
 */

export interface MutationsTableOptions {
  /** `true` pour la table bâtie, `false` pour la table des terrains. */
  built: boolean
}

/**
 * Fonction PL/pgSQL de création de partition annuelle, idempotente.
 *
 * Appelée par les migrations pour provisionner les millésimes connus, et par
 * `dvf:import` pour chaque année effectivement rencontrée dans le fichier —
 * de sorte qu'un millésime inattendu ne fasse jamais échouer un import.
 */
export const PARTITION_HELPER_SQL = `
CREATE OR REPLACE FUNCTION ensure_annual_partition(p_table text, p_year integer)
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_partition text;
BEGIN
  v_partition := format('%s_y%s', p_table, p_year);

  IF to_regclass(format('public.%I', v_partition)) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      v_partition,
      p_table,
      make_date(p_year, 1, 1),
      make_date(p_year + 1, 1, 1)
    );
  END IF;

  RETURN v_partition;
END;
$fn$;
`

/**
 * Instruction `CREATE TABLE … PARTITION BY RANGE (date_mutation)`.
 */
export function mutationsTableSql(table: string, options: MutationsTableOptions): string {
  // Dénominateur du prix au m². `NULLIF(…, 0)` évite une division par zéro :
  // une surface nulle donne `prix_m2 = NULL` plutôt qu'une erreur qui ferait
  // échouer tout le lot d'insertion.
  const denominator = options.built ? 'surface_bati' : 'surface_terrain'

  // La surface bâtie est obligatoire pour un bien bâti, nulle pour un terrain
  // (§5.1 : « mutations_terrain — surface_bati NULL »).
  const surfaceBatiNullability = options.built ? 'NOT NULL' : 'NULL'
  const surfaceTerrainNullability = options.built ? 'NULL' : 'NOT NULL'

  return `
    CREATE TABLE ${table} (
      id                bigserial     NOT NULL,

      -- Annexe A.1 : sha256(id_mutation). Clé d'idempotence de l'upsert.
      dedup_key         char(64)      NOT NULL,
      id_mutation       text          NOT NULL,

      -- Clé de partitionnement.
      date_mutation     date          NOT NULL,

      nature_mutation   text          NOT NULL,
      valeur_fonciere   numeric(12,2) NOT NULL,

      -- 'appartement' | 'maison' pour le bâti, 'terrain' sinon (normalisé
      -- en minuscules à l'ingestion).
      type_local        text          NOT NULL,

      -- Somme des surfaces des lots de MÊME type (Annexe A.1). Les
      -- dépendances (cave, garage, parking) en sont exclues.
      surface_bati      integer       ${surfaceBatiNullability},
      nb_pieces         smallint      NULL,
      surface_terrain   integer       ${surfaceTerrainNullability} DEFAULT 0,

      -- Nombre de lots bâtis de même type regroupés (le « N » de l'Annexe A.1).
      nb_locaux         smallint      NOT NULL DEFAULT 1,
      -- Dépendances vendues avec le bien (cave, garage, parking). Elles ne
      -- sont jamais sommées dans la surface, mais l'Annexe A.1 demande de les
      -- tracer : une différence de prix au m² peut s'expliquer par un parking.
      nb_dependances    smallint      NOT NULL DEFAULT 0,

      code_insee        char(5)       NOT NULL,
      code_departement  char(3)       NOT NULL,

      -- §8.3 : le numéro de voie n'est JAMAIS ingéré. À l'échelle d'une
      -- petite commune, numéro + date exacte + prix rendraient un vendeur
      -- identifiable.
      adresse_voie      text          NULL,
      code_postal       char(5)       NULL,

      longitude         double precision NOT NULL,
      latitude          double precision NOT NULL,
      geom              geography(Point,4326) NOT NULL,

      prix_m2           numeric(10,2)
                        GENERATED ALWAYS AS (valeur_fonciere / NULLIF(${denominator}, 0)) STORED,

      -- Annexe A.2 : les aberrants sont MARQUÉS, jamais supprimés.
      -- Un seuil mal choisi ne doit pas détruire de la donnée.
      is_outlier        boolean       NOT NULL DEFAULT false,
      exclusion_reason  text          NULL,

      -- Annexe A.3 : 'dvf' | 'ban' | 'parcelle' | 'commune_centroid'.
      geoloc_source     varchar(20)   NOT NULL DEFAULT 'dvf',
      -- false ⇒ point posé au centroïde communal : la mutation doit être
      -- EXCLUE des niveaux au rayon, où elle n'a aucun sens.
      geoloc_fine       boolean       NOT NULL DEFAULT true,

      source_annee      smallint      NOT NULL,
      imported_at       timestamptz   NOT NULL DEFAULT now(),

      -- La clé primaire d'une table partitionnée doit contenir la clé de
      -- partitionnement : contrainte de PostgreSQL, pas un choix de design.
      PRIMARY KEY (id, date_mutation)
    ) PARTITION BY RANGE (date_mutation)
  `
}

/**
 * Index — formulation de référence de l'Annexe A.5.
 *
 * Tous les index du chemin chaud sont **partiels sur `is_outlier = false`** :
 * les lignes écartées restent consultables pour audit mais ne pèsent sur
 * aucun index de requête.
 */
export function mutationsIndexesSql(table: string, options: MutationsTableOptions): string[] {
  const statements = [
    // Le plus important : rend `ST_DWithin` indexable (Annexe A.6).
    `CREATE INDEX ${table}_geom_gist ON ${table} USING GIST (geom)
       WHERE is_outlier = false`,

    // Chemin chaud des niveaux au rayon. Exige btree_gist pour mêler une
    // géométrie et des colonnes scalaires dans le même index.
    // `geoloc_fine = true` : un point au centroïde communal n'a rien à faire
    // dans une recherche par rayon (Annexe A.3).
    `CREATE INDEX ${table}_search_gist ON ${table}
       USING GIST (geom, type_local, ${options.built ? 'surface_bati' : 'surface_terrain'})
       WHERE is_outlier = false AND geoloc_fine = true`,

    // Niveaux administratifs de la cascade (§3.2, L5 à L7).
    `CREATE INDEX ${table}_insee_idx ON ${table} (code_insee, type_local, date_mutation DESC)
       WHERE is_outlier = false`,
    `CREATE INDEX ${table}_dep_idx ON ${table} (code_departement, type_local, date_mutation DESC)
       WHERE is_outlier = false`,

    // Filtre de surface (§3.2).
    `CREATE INDEX ${table}_type_surface_idx ON ${table}
       (type_local, ${options.built ? 'surface_bati' : 'surface_terrain'})
       WHERE is_outlier = false`,

    // Idempotence de l'ingestion (Annexe A.1 et A.7). Volontairement NON
    // partiel : c'est la cible du `ON CONFLICT`, il doit couvrir toutes les
    // lignes, y compris celles marquées aberrantes.
    `CREATE UNIQUE INDEX ${table}_dedup ON ${table} (dedup_key, date_mutation)`,
  ]

  return statements.map((statement) => statement.replace(/\s+/g, ' ').trim())
}
