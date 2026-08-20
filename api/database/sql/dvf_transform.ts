/**
 * Transformation DVF **set-based** — Annexe A.7.
 *
 * « Jamais d'INSERT ligne à ligne. » Le fichier est chargé par `COPY` dans
 * `mutations_staging` (UNLOGGED, tout en `text`), puis transformé
 * intégralement en SQL. Sur un département dense, la différence entre une
 * transformation set-based et une boucle applicative se compte en heures.
 *
 * Les règles appliquées ici sont **exactement** celles du module pur
 * `app/dvf/normalize.ts`. Cette duplication est assumée — le volume impose le
 * SQL, la testabilité impose le module pur — mais elle est **verrouillée par
 * un test différentiel** (`tests/unit/dvf_sql_parity.spec.ts`) qui fait
 * tourner les deux implémentations sur le même jeu de lignes et exige un
 * résultat identique. Toute divergence introduite fait échouer la CI.
 */

/* ══════════════════════════════════════════════════════════════════════════
 * Fonctions SQL utilitaires
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Conversions tolérantes depuis le staging (tout y est en `text`).
 *
 * Un champ numérique fantaisiste au milieu d'un fichier de 500 000 lignes ne
 * doit jamais faire échouer l'import : il devient `NULL` et sera compté comme
 * rejet par motif.
 */
/*
 * NOTE D'IMPLÉMENTATION — pourquoi `{0,1}` et non `?` dans les expressions
 * régulières ci-dessous.
 *
 * Ce SQL transite par Knex (`rawQuery`), dont le formateur interprète tout
 * `?` comme un marqueur de liaison. Un `?` littéral dans une regex était
 * silencieusement consommé : `dvf_num` retournait alors NULL pour TOUTE
 * valeur, et l'ingestion rejetait l'intégralité du fichier en
 * « surface_absente ». Symptôme trompeur, cause lointaine.
 *
 * `{0,1}` est strictement équivalent en POSIX et ne rencontre pas ce piège.
 */
export const DVF_HELPERS_SQL = `
CREATE OR REPLACE FUNCTION dvf_num(p text)
RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
  SELECT CASE
    WHEN p IS NOT NULL AND btrim(p) ~ '^-{0,1}[0-9]+([.,][0-9]+){0,1}$'
    THEN replace(btrim(p), ',', '.')::numeric
  END
$fn$;

CREATE OR REPLACE FUNCTION dvf_date(p text)
RETURNS date
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $fn$
BEGIN
  IF p IS NULL OR btrim(p) !~ '^\\d{4}-\\d{2}-\\d{2}$' THEN
    RETURN NULL;
  END IF;
  RETURN btrim(p)::date;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$fn$;

-- Nom de voie SANS numéro (§8.3) et mis en forme lisible.
-- DVF sépare déjà le numéro dans \`adresse_numero\` : on ne lit jamais cette
-- colonne. Le retrait d'un numéro en tête est une précaution défensive.
CREATE OR REPLACE FUNCTION dvf_voie(p text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
  SELECT nullif(
    initcap(
      regexp_replace(
        btrim(coalesce(p, '')),
        '^[0-9]+\\s*(bis|ter|quater|[a-zA-Z]){0,1}\\s+',
        '',
        'i'
      )
    ),
    ''
  )
$fn$;

-- Nature BÂTIE d'une ligne, au sens de l'Annexe A.1 — pendant SQL exact de
-- \`builtTypeKey()\` (app/dvf/normalize.ts).
--
-- 1 maison · 2 appartement · 4 local industriel/commercial sont des lignes
-- BÂTIES : elles comptent toutes dans \`nb_types\` et peuvent donc déclencher
-- le rejet \`multi_type\`. Le 3 (dépendance) n'est pas bâti : il ne grossit
-- aucune surface et ne provoque jamais de rejet.
--
-- Ne reconnaître que 1 et 2 laissait passer « logement + local commercial »
-- avec la seule surface du logement : maison 90 m² + commerce 120 m² à
-- 300 000 € devenait « maison 90 m² à 3 333 €/m² », sous le seuil
-- d'aberration donc conservée, et incluse dans la médiane.
CREATE OR REPLACE FUNCTION dvf_built_type(p_code text, p_label text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
  SELECT CASE
    WHEN btrim(coalesce(p_code, '')) <> '' THEN
      CASE btrim(p_code)
        WHEN '1' THEN 'maison'
        WHEN '2' THEN 'appartement'
        WHEN '4' THEN 'commercial'
      END
    ELSE
      CASE
        WHEN lower(btrim(coalesce(p_label, ''))) = 'maison'      THEN 'maison'
        WHEN lower(btrim(coalesce(p_label, ''))) = 'appartement' THEN 'appartement'
        WHEN lower(btrim(coalesce(p_label, ''))) LIKE 'local industriel%'
                                                                 THEN 'commercial'
      END
  END
$fn$;
`

/* ══════════════════════════════════════════════════════════════════════════
 * Construction des candidats
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Construit la table temporaire `dvf_candidates` : une ligne par mutation
 * distincte, enrichie d'un `reject_reason` (NULL = mutation conservée) et
 * d'un marquage d'aberrant.
 *
 * L'ordre des tests de rejet est identique à celui de `normalizeMutationGroup`
 * — c'est ce qui rend le test de parité significatif.
 *
 * @param sourceAnnee millésime du fichier source
 */
export const BUILD_CANDIDATES_SQL = `
CREATE TEMP TABLE dvf_candidates ON COMMIT DROP AS
WITH src AS (
  SELECT
    s.line_no                                          AS ord,
    btrim(s.id_mutation)                               AS id_mutation,
    btrim(coalesce(s.nature_mutation, ''))             AS nature_mutation,
    dvf_num(s.valeur_fonciere)                         AS valeur_fonciere,
    dvf_date(s.date_mutation)                          AS date_mutation,
    lower(btrim(coalesce(s.type_local, '')))           AS type_local_norm,
    btrim(coalesce(s.code_type_local, ''))             AS code_type_local,
    dvf_num(s.surface_reelle_bati)                     AS surface_reelle_bati,
    dvf_num(s.nombre_pieces_principales)               AS nombre_pieces,
    dvf_num(s.surface_terrain)                         AS surface_terrain,
    dvf_num(s.longitude)                               AS longitude,
    dvf_num(s.latitude)                                AS latitude,
    btrim(coalesce(s.code_commune, ''))                AS code_insee,
    btrim(coalesce(s.code_departement, ''))            AS code_departement,
    btrim(coalesce(s.code_postal, ''))                 AS code_postal,
    btrim(coalesce(s.adresse_nom_voie, ''))            AS adresse_nom_voie,
    btrim(coalesce(s.id_parcelle, ''))                 AS id_parcelle,
    btrim(coalesce(s.lot1_numero, ''))                 AS lot1_numero,
    -- 'maison' | 'appartement' | 'commercial' | NULL (Annexe A.1).
    dvf_built_type(s.code_type_local, s.type_local)    AS built_type
  FROM mutations_staging s
  WHERE nullif(btrim(s.id_mutation), '') IS NOT NULL
),

-- Lignes portant un local BÂTI (logement OU local commercial, Annexe A.1),
-- débarrassées des doublons techniques stricts (même parcelle, même type,
-- même surface, même lot). Observé en données réelles : la même maison
-- répétée deux fois.
built AS (
  SELECT *
  FROM (
    SELECT
      src.*,
      row_number() OVER (
        PARTITION BY id_mutation, id_parcelle, code_type_local,
                     surface_reelle_bati, nombre_pieces, lot1_numero
        ORDER BY ord
      ) AS dup_rank
    FROM src
    WHERE built_type IS NOT NULL
  ) d
  WHERE d.dup_rank = 1
),

-- Agrégats par mutation, sur les seuls locaux bâtis.
-- Les surfaces des lots de MÊME type sont sommées (Annexe A.1).
--
-- \`nb_types\` compte les types BÂTIS, local commercial inclus : c'est ce qui
-- fait rejeter « logement + commerce » en \`multi_type\`.
-- \`type_local\` ne retient que ce qui est VALORISABLE : un local commercial
-- vendu seul donne \`type_local = NULL\` et sera rejeté plus bas en
-- \`type_local_non_retenu\`.
agg AS (
  SELECT
    b.id_mutation,
    count(*)::int                     AS nb_locaux,
    count(DISTINCT b.built_type)::int AS nb_types,
    min(b.built_type)                 AS built_type,
    min(b.built_type) FILTER (WHERE b.built_type IN ('maison', 'appartement'))
                                      AS type_local,
    sum(b.surface_reelle_bati)        AS surface_bati,
    sum(b.nombre_pieces)              AS nb_pieces
  FROM built b
  GROUP BY b.id_mutation
),

-- Dépendances (code_type_local = '3' : cave, garage, parking).
--
-- Elles portent \`type_local = 'Dépendance'\`, donc n'entrent JAMAIS dans
-- \`built\` : elles ne peuvent ni gonfler la surface habitable, ni déclencher
-- un rejet \`multi_type\`. C'est précisément le comportement voulu par
-- l'Annexe A.1 — une vente d'appartement avec cave et parking (3 lignes,
-- type_local 2/3/3) est CONSERVÉE, avec la seule surface de l'appartement.
-- On les compte tout de même, pour les tracer comme l'exige l'annexe.
deps AS (
  SELECT id_mutation, count(*)::int AS nb_dependances
  FROM src
  WHERE code_type_local = '3'
  GROUP BY id_mutation
),

-- Attributs de niveau mutation, pris sur la première ligne du groupe.
head AS (
  SELECT DISTINCT ON (id_mutation)
    id_mutation, nature_mutation, date_mutation,
    code_insee, code_departement, code_postal
  FROM src
  ORDER BY id_mutation, ord
),

-- \`valeur_fonciere\` est répétée à l'identique sur toutes les lignes du
-- groupe : elle est comptée UNE SEULE FOIS, jamais sommée. C'est l'erreur
-- classique qui gonfle les prix d'un facteur 2 à 4.
valeur AS (
  SELECT id_mutation, max(valeur_fonciere) AS valeur_fonciere
  FROM src
  WHERE valeur_fonciere IS NOT NULL AND valeur_fonciere > 0
  GROUP BY id_mutation
),

-- Coordonnées : on privilégie une ligne bâtie, pour que le point désigne le
-- local et non une parcelle de landes rattachée à la même vente.
geo AS (
  SELECT DISTINCT ON (id_mutation) id_mutation, longitude, latitude
  FROM src
  WHERE longitude IS NOT NULL AND latitude IS NOT NULL
  ORDER BY id_mutation,
           (built_type IS NOT NULL) DESC,
           ord
),

-- Nom de voie de la première ligne bâtie.
voie AS (
  SELECT DISTINCT ON (id_mutation) id_mutation, adresse_nom_voie
  FROM built
  ORDER BY id_mutation, ord
),

-- Surface de terrain : sommée sur les parcelles DISTINCTES (contrairement à
-- la valeur foncière, des parcelles distinctes s'additionnent réellement).
terrain AS (
  SELECT id_mutation, sum(surface_terrain)::bigint AS surface_terrain
  FROM (
    SELECT DISTINCT ON (
      id_mutation,
      CASE WHEN id_parcelle <> '' THEN id_parcelle ELSE 'ord:' || ord END
    )
      id_mutation, surface_terrain
    FROM src
    ORDER BY
      id_mutation,
      CASE WHEN id_parcelle <> '' THEN id_parcelle ELSE 'ord:' || ord END,
      ord
  ) d
  WHERE surface_terrain IS NOT NULL AND surface_terrain > 0
  GROUP BY id_mutation
),

assembled AS (
  SELECT
    h.id_mutation,
    h.nature_mutation,
    h.date_mutation,
    h.code_insee,
    coalesce(nullif(h.code_departement, ''), left(h.code_insee, 2)) AS code_departement,
    nullif(h.code_postal, '')                                       AS code_postal,
    v.valeur_fonciere,
    a.type_local,
    a.built_type,
    a.nb_types,
    a.nb_locaux,
    coalesce(d.nb_dependances, 0)                                   AS nb_dependances,
    a.surface_bati::numeric                                         AS surface_bati,
    a.nb_pieces::numeric                                            AS nb_pieces,
    coalesce(t.surface_terrain, 0)                                  AS surface_terrain,
    g.longitude,
    g.latitude,
    dvf_voie(w.adresse_nom_voie)                                    AS adresse_voie
  FROM head h
  LEFT JOIN agg     a ON a.id_mutation = h.id_mutation
  LEFT JOIN deps    d ON d.id_mutation = h.id_mutation
  LEFT JOIN valeur  v ON v.id_mutation = h.id_mutation
  LEFT JOIN geo     g ON g.id_mutation = h.id_mutation
  LEFT JOIN voie    w ON w.id_mutation = h.id_mutation
  LEFT JOIN terrain t ON t.id_mutation = h.id_mutation
),

classified AS (
  SELECT
    x.*,
    round(x.surface_bati)::int AS surface_bati_i,
    /*
     * Motif de rejet. L'ordre des tests reproduit exactement celui de
     * \`normalizeMutationGroup\` (module pur) — condition du test de parité.
     */
    CASE
      WHEN x.nature_mutation IS DISTINCT FROM 'Vente'       THEN 'nature_non_vente'
      WHEN x.built_type IS NULL                             THEN 'aucun_local_bati'
      WHEN x.nb_types > 1                                   THEN 'multi_type'
      -- Type bâti unique mais non valorisable : local commercial vendu seul.
      WHEN x.type_local IS NULL                             THEN 'type_local_non_retenu'
      WHEN x.surface_bati IS NULL
        OR round(x.surface_bati) <= 0                       THEN 'surface_absente'
      WHEN x.valeur_fonciere IS NULL                        THEN 'valeur_absente'
      WHEN x.date_mutation IS NULL                          THEN 'date_invalide'
      WHEN length(x.code_insee) <> 5                        THEN 'code_insee_absent'
      WHEN x.longitude IS NULL OR x.latitude IS NULL
        OR x.longitude < -63 OR x.longitude > 56
        OR x.latitude  < -22 OR x.latitude  > 52            THEN 'geolocalisation_absente'
      ELSE NULL
    END AS reject_reason
  FROM assembled x
)
SELECT
  c.id_mutation,
  encode(sha256(c.id_mutation::bytea), 'hex')::char(64) AS dedup_key,
  c.date_mutation,
  c.nature_mutation,
  c.valeur_fonciere,
  c.type_local,
  c.surface_bati_i                                      AS surface_bati,
  (CASE WHEN c.nb_pieces IS NULL OR c.nb_pieces <= 0
        THEN NULL ELSE round(c.nb_pieces)::int END)     AS nb_pieces,
  c.surface_terrain::int                                AS surface_terrain,
  c.nb_locaux,
  c.nb_dependances,
  c.code_insee,
  c.code_departement,
  c.adresse_voie,
  c.code_postal,
  c.longitude,
  c.latitude,
  c.reject_reason,
  /*
   * Annexe A.2 : les aberrants sont MARQUÉS, jamais supprimés.
   * Bornes de prix relevées à 45 000 €/m² pour 75, 06, 74, 2A, 2B et 92,
   * faute de quoi l'essentiel de ces marchés serait écarté à tort.
   */
  CASE
    WHEN c.reject_reason IS NOT NULL THEN NULL
    WHEN c.valeur_fonciere < 5000 OR c.valeur_fonciere > 15000000
      THEN 'valeur_symbolique'
    WHEN (c.type_local = 'appartement'
            AND (c.surface_bati_i < 9 OR c.surface_bati_i > 1000))
      OR (c.type_local = 'maison'
            AND (c.surface_bati_i < 20 OR c.surface_bati_i > 1500))
      THEN 'surface_hors_bornes'
    WHEN (c.valeur_fonciere / c.surface_bati_i) < 300
      OR (c.valeur_fonciere / c.surface_bati_i) >
         (CASE WHEN upper(c.code_departement) IN ('75','06','74','2A','2B','92')
               THEN 45000 ELSE 25000 END)
      THEN 'prix_hors_bornes'
    ELSE NULL
  END AS exclusion_reason
FROM classified c
`

/* ══════════════════════════════════════════════════════════════════════════
 * Insertion
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Upsert des mutations conservées.
 *
 * Annexe A.7 : **aucun DROP, aucun TRUNCATE sur `mutations`**. L'upsert
 * `ON CONFLICT (dedup_key, date_mutation)` garantit que le service reste
 * interrogeable pendant tout l'import, et rend le rejeu strictement
 * idempotent : rejouer le même fichier laisse le même nombre de lignes.
 *
 * Note : on ne peut PAS distinguer insertion et mise à jour via `RETURNING
 * (xmax = 0)` — PostgreSQL refuse l'accès aux colonnes système dans le
 * `RETURNING` d'une table partitionnée (« cannot retrieve a system column in
 * this context »). Le décompte des mises à jour est donc obtenu AVANT
 * l'upsert par `COUNT_PREEXISTING_SQL`, qui s'appuie sur l'index unique et
 * reste peu coûteux.
 */
export const INSERT_MUTATIONS_SQL = `
WITH upserted AS (
  INSERT INTO mutations (
    dedup_key, id_mutation, date_mutation, nature_mutation, valeur_fonciere,
    type_local, surface_bati, nb_pieces, surface_terrain, nb_locaux, nb_dependances,
    code_insee, code_departement, adresse_voie, code_postal,
    longitude, latitude, geom,
    is_outlier, exclusion_reason, geoloc_source, geoloc_fine,
    source_annee, imported_at
  )
  SELECT
    c.dedup_key, c.id_mutation, c.date_mutation, c.nature_mutation, c.valeur_fonciere,
    c.type_local, c.surface_bati, c.nb_pieces, c.surface_terrain, c.nb_locaux, c.nb_dependances,
    c.code_insee, c.code_departement, c.adresse_voie, c.code_postal,
    c.longitude, c.latitude,
    ST_SetSRID(ST_MakePoint(c.longitude, c.latitude), 4326)::geography,
    (c.exclusion_reason IS NOT NULL), c.exclusion_reason,
    'dvf', true,
    $1, now()
  FROM dvf_candidates c
  WHERE c.reject_reason IS NULL
  ON CONFLICT (dedup_key, date_mutation) DO UPDATE SET
    nature_mutation  = EXCLUDED.nature_mutation,
    valeur_fonciere  = EXCLUDED.valeur_fonciere,
    type_local       = EXCLUDED.type_local,
    surface_bati     = EXCLUDED.surface_bati,
    nb_pieces        = EXCLUDED.nb_pieces,
    surface_terrain  = EXCLUDED.surface_terrain,
    nb_locaux        = EXCLUDED.nb_locaux,
    nb_dependances   = EXCLUDED.nb_dependances,
    code_insee       = EXCLUDED.code_insee,
    code_departement = EXCLUDED.code_departement,
    adresse_voie     = EXCLUDED.adresse_voie,
    code_postal      = EXCLUDED.code_postal,
    longitude        = EXCLUDED.longitude,
    latitude         = EXCLUDED.latitude,
    geom             = EXCLUDED.geom,
    is_outlier       = EXCLUDED.is_outlier,
    exclusion_reason = EXCLUDED.exclusion_reason,
    source_annee     = EXCLUDED.source_annee,
    imported_at      = EXCLUDED.imported_at
  RETURNING 1 AS touched
)
SELECT count(*)::bigint AS upserted FROM upserted
`

/**
 * Nombre de mutations candidates DÉJÀ présentes en base.
 *
 * À exécuter juste avant l'upsert : donne `rows_updated`, dont on déduit
 * `rows_inserted = rows_kept - rows_updated`. La jointure s'appuie sur
 * l'index unique `(dedup_key, date_mutation)`.
 */
export const COUNT_PREEXISTING_SQL = `
SELECT count(*)::bigint AS total
FROM dvf_candidates c
JOIN mutations m
  ON m.dedup_key = c.dedup_key
 AND m.date_mutation = c.date_mutation
WHERE c.reject_reason IS NULL
`

/* ══════════════════════════════════════════════════════════════════════════
 * Marquage des lignes obsolètes — Annexe A.2 et A.7
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── LE PROBLÈME ───────────────────────────────────────────────────────────
 * L'ingestion ne supprime jamais (A.7) et l'upsert ne réécrit que ce que les
 * règles COURANTES retiennent. Une mutation produite par une règle corrigée
 * depuis — ou disparue du fichier source — n'est donc ni réécrite, ni
 * marquée : elle reste dans `mutations`, `is_outlier = false`, et continue
 * d'entrer dans les médianes ET dans `agg_commune_type`, donc jusque dans la
 * garde de cohérence de marché de l'Annexe A.10.
 *
 * ── LA CORRECTION ─────────────────────────────────────────────────────────
 * Dans la MÊME transaction que l'upsert, et APRÈS lui : toute ligne du
 * périmètre réimporté que l'upsert n'a pas touchée est marquée
 * `stale_reimport`. A.2 est respectée — on marque, on ne supprime pas.
 *
 * ── POURQUOI LE PÉRIMÈTRE PORTE `source_annee` ────────────────────────────
 * C'est la clause la plus importante du fichier. `mutations` accumule
 * plusieurs millésimes de fichiers DVF pour un même département. Sans le
 * filtre `source_annee`, importer le millésime 2025 du département 23
 * marquerait obsolètes **toutes** les mutations 2019 à 2024 de ce
 * département : le correctif ferait alors plus de dégâts que le bug qu'il
 * corrige. Un test dédié verrouille ce point
 * (`tests/functional/dvf_import.spec.ts`).
 *
 * ── POURQUOI `now()` PLUTÔT QU'UN HORODATAGE APPLICATIF ───────────────────
 * `now()` est le `transaction_timestamp()` : il est FIGÉ au début de la
 * transaction, quelle que soit la durée de l'import. Les lignes écrites par
 * l'upsert portent `imported_at = now()` — la même valeur, à la microseconde
 * près. `imported_at < now()` les exclut donc exactement, sans dépendre de
 * l'horloge du processus Node ni d'un éventuel décalage avec le serveur.
 *
 * ── AUTO-RÉPARATEUR ───────────────────────────────────────────────────────
 * `INSERT_MUTATIONS_SQL` fait `is_outlier = EXCLUDED.is_outlier` et
 * `exclusion_reason = EXCLUDED.exclusion_reason` : une ligne redevenue
 * légitime perd son marquage au ré-import suivant. Le marquage n'est donc
 * jamais définitif, et une erreur de règle reste réversible.
 *
 * $1 = code_departement · $2 = source_annee
 */
function markStaleSql(table: string): string {
  return `
UPDATE ${table}
   SET is_outlier       = true,
       exclusion_reason = 'stale_reimport'
 WHERE code_departement = $1
   AND source_annee     = $2
   AND imported_at      < now()
   AND exclusion_reason IS DISTINCT FROM 'stale_reimport'
`
}

/** Marquage des mutations bâties obsolètes. $1 = département, $2 = millésime. */
export const MARK_STALE_SQL = markStaleSql('mutations')

/** Même traitement pour les ventes de terrain nu (§5.1). */
export const MARK_STALE_TERRAIN_SQL = markStaleSql('mutations_terrain')

/** Décompte des rejets par motif, alimente `dvf_imports.rejected_counts`. */
export const REJECTED_COUNTS_SQL = `
SELECT reject_reason AS reason, count(*)::bigint AS total
FROM dvf_candidates
WHERE reject_reason IS NOT NULL
GROUP BY reject_reason
`

/** Années distinctes présentes, pour provisionner les partitions annuelles. */
export const CANDIDATE_YEARS_SQL = `
SELECT DISTINCT extract(year FROM date_mutation)::int AS year
FROM dvf_candidates
WHERE reject_reason IS NULL AND date_mutation IS NOT NULL
ORDER BY 1
`

/** Statistiques de synthèse d'un département traité. */
export const CANDIDATE_SUMMARY_SQL = `
SELECT
  count(*)::bigint                                        AS mutations_seen,
  count(*) FILTER (WHERE reject_reason IS NULL)::bigint    AS kept,
  count(*) FILTER (WHERE reject_reason IS NOT NULL)::bigint AS rejected,
  count(*) FILTER (WHERE reject_reason IS NULL
                     AND exclusion_reason IS NOT NULL)::bigint AS outliers
FROM dvf_candidates
`

/* ══════════════════════════════════════════════════════════════════════════
 * Mutations de TERRAIN — §5.1 et §3.6
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Le Lot 1 avait créé `mutations_terrain` (structure, partitions et index)
 * sans jamais l'alimenter. Deux conséquences directes, toutes deux
 * silencieuses :
 *   - `propertyType: 'terrain'` — proposé par le wizard, validé, profilé —
 *     échouait à 100 % partout en France, avec le message trompeur « pas
 *     assez de transactions comparables sur ce secteur » ;
 *   - `landPricePerSqm()` retournait toujours `null`, donc le repli
 *     forfaitaire de 8 % du §3.6 était systématique et la branche « médiane
 *     sourcée » n'était jamais exercée.
 *
 * ── QU'EST-CE QU'UNE MUTATION DE TERRAIN ICI ──────────────────────────────
 * Une vente **sans aucun local**. Une maison vendue avec son jardin est déjà
 * dans `mutations`, avec sa `surface_terrain` : la réingérer ici compterait la
 * valeur foncière deux fois et ferait passer un prix de maison pour un prix de
 * terrain. Un garage vendu seul (`code_type_local = 3`) n'est pas davantage un
 * terrain : son €/m² de parcelle n'a aucun sens.
 *
 * ── POURQUOI SEULEMENT LES PARCELLES `code_nature_culture` VIDE OU 'S' ─────
 * DVF distingue les natures de culture : `S` (sols), `T` (terres), `P` (prés),
 * `B` (bois), `L` (landes)… Une terre agricole se vend 0,50 à 2 €/m², un
 * terrain à bâtir 30 à 300 €/m². Mêler les deux produirait une médiane
 * communale d'environ 1 €/m², qui servirait ensuite à valoriser le jardin
 * d'une maison (§3.6) — c'est-à-dire à le valoriser à zéro, et bien en dessous
 * du repli forfaitaire de 8 % qu'elle remplacerait.
 *
 * C'est un choix d'ingestion, pas une règle de la spec : il est isolé ici,
 * commenté, et révisable en une ligne. Il est volontairement CONSERVATEUR —
 * il restreint l'échantillon plutôt que de le fausser.
 *
 * ── LE PIÈGE DES LOTS MIXTES (corrigé ici) ────────────────────────────────
 * La première version ne SOMMAIT que les parcelles `'' | 'S'`, mais gardait
 * `valeur_fonciere`, qui couvre **toute** la vente. Sur un lot mixte, le
 * numérateur portait donc l'ensemble et le dénominateur une fraction :
 *
 *     800 m² 'S' + 20 000 m² 'T', vendus 120 000 €
 *       → surface_terrain = 800, exclusion_reason = NULL, prix_m2 = 150,00 €/m²
 *
 * Non marquée, dans les bornes (1 à 25 000 €/m²), donc **incluse dans la
 * médiane** — celle qui sert à `propertyType: 'terrain'` ET à la valorisation
 * du jardin du §3.6. Sur un marché rural, le lot « terrain à bâtir + terres »
 * est courant : le biais était systématique et haussier.
 *
 * Deux règles remplacent l'amputation silencieuse du dénominateur :
 *
 *   1. `surface_terrain` somme désormais **toutes** les parcelles. Numérateur
 *      et dénominateur portent enfin sur le même périmètre.
 *   2. Une vente dont TOUTES les parcelles ne sont pas en `'' | 'S'` est
 *      conservée mais MARQUÉE `terrain_mixte` (A.2 : marquer, jamais
 *      supprimer). Elle reste auditable et redeviendra exploitable si la
 *      règle évolue, mais elle ne pèse plus sur aucune médiane.
 *
 * ── ET LA VENTE 100 % AGRICOLE ────────────────────────────────────────────
 * Elle était rejetée en `surface_absente` — un motif faux, qui polluait le
 * compteur de rejets destiné au pilotage qualité : on ne pouvait plus
 * distinguer « le fichier n'a pas de surface » de « cette vente n'est pas du
 * terrain à bâtir ». Elle porte désormais son vrai motif,
 * `nature_culture_non_retenue`, exact pendant de `type_local_non_retenu` côté
 * bâti (local commercial vendu seul).
 */
export const BUILD_TERRAIN_CANDIDATES_SQL = `
CREATE TEMP TABLE dvf_candidates_terrain ON COMMIT DROP AS
WITH src AS (
  SELECT
    s.line_no                                          AS ord,
    btrim(s.id_mutation)                               AS id_mutation,
    btrim(coalesce(s.nature_mutation, ''))             AS nature_mutation,
    dvf_num(s.valeur_fonciere)                         AS valeur_fonciere,
    dvf_date(s.date_mutation)                          AS date_mutation,
    btrim(coalesce(s.code_type_local, ''))             AS code_type_local,
    dvf_built_type(s.code_type_local, s.type_local)    AS built_type,
    dvf_num(s.surface_terrain)                         AS surface_terrain,
    upper(btrim(coalesce(s.code_nature_culture, '')))  AS code_nature_culture,
    dvf_num(s.longitude)                               AS longitude,
    dvf_num(s.latitude)                                AS latitude,
    btrim(coalesce(s.code_commune, ''))                AS code_insee,
    btrim(coalesce(s.code_departement, ''))            AS code_departement,
    btrim(coalesce(s.code_postal, ''))                 AS code_postal,
    btrim(coalesce(s.adresse_nom_voie, ''))            AS adresse_nom_voie,
    btrim(coalesce(s.id_parcelle, ''))                 AS id_parcelle
  FROM mutations_staging s
  WHERE nullif(btrim(s.id_mutation), '') IS NOT NULL
),

-- Une mutation qui porte le moindre local — bâti (1/2/4) OU dépendance (3) —
-- n'est PAS une vente de terrain.
locaux AS (
  SELECT id_mutation,
         bool_or(built_type IS NOT NULL OR code_type_local = '3') AS has_local
  FROM src
  GROUP BY id_mutation
),

head AS (
  SELECT DISTINCT ON (id_mutation)
    id_mutation, nature_mutation, date_mutation,
    code_insee, code_departement, code_postal, adresse_nom_voie
  FROM src
  ORDER BY id_mutation, ord
),

-- Répétée à l'identique sur toutes les lignes : comptée UNE SEULE FOIS.
valeur AS (
  SELECT id_mutation, max(valeur_fonciere) AS valeur_fonciere
  FROM src
  WHERE valeur_fonciere IS NOT NULL AND valeur_fonciere > 0
  GROUP BY id_mutation
),

geo AS (
  SELECT DISTINCT ON (id_mutation) id_mutation, longitude, latitude
  FROM src
  WHERE longitude IS NOT NULL AND latitude IS NOT NULL
  ORDER BY id_mutation, ord
),

-- Parcelles DISTINCTES : contrairement à la valeur foncière, deux parcelles
-- d'une même vente s'additionnent réellement.
parcelles AS (
  SELECT DISTINCT ON (
    id_mutation,
    CASE WHEN id_parcelle <> '' THEN id_parcelle ELSE 'ord:' || ord END
  )
    id_mutation, surface_terrain, code_nature_culture
  FROM src
  ORDER BY
    id_mutation,
    CASE WHEN id_parcelle <> '' THEN id_parcelle ELSE 'ord:' || ord END,
    ord
),

-- \`surface_terrain\` somme TOUTES les parcelles : c'est le seul périmètre
-- cohérent avec \`valeur_fonciere\`, qui couvre toute la vente. Le tri entre
-- lot homogène, lot mixte et vente non bâtissable se fait plus bas, sur
-- \`nb_parcelles_sol\` — en marquant, jamais en amputant le dénominateur.
terrain AS (
  SELECT
    id_mutation,
    sum(surface_terrain)::bigint AS surface_terrain,
    count(*)::int                AS nb_parcelles,
    count(*) FILTER (WHERE code_nature_culture IN ('', 'S'))::int AS nb_parcelles_sol
  FROM parcelles
  WHERE surface_terrain IS NOT NULL
    AND surface_terrain > 0
  GROUP BY id_mutation
),

assembled AS (
  SELECT
    h.id_mutation,
    h.nature_mutation,
    h.date_mutation,
    h.code_insee,
    coalesce(nullif(h.code_departement, ''), left(h.code_insee, 2)) AS code_departement,
    nullif(h.code_postal, '')                                       AS code_postal,
    dvf_voie(h.adresse_nom_voie)                                    AS adresse_voie,
    v.valeur_fonciere,
    l.has_local,
    coalesce(t.surface_terrain, 0)::bigint                          AS surface_terrain,
    coalesce(t.nb_parcelles, 0)                                     AS nb_parcelles,
    coalesce(t.nb_parcelles_sol, 0)                                 AS nb_parcelles_sol,
    g.longitude,
    g.latitude
  FROM head h
  LEFT JOIN locaux  l ON l.id_mutation = h.id_mutation
  LEFT JOIN valeur  v ON v.id_mutation = h.id_mutation
  LEFT JOIN geo     g ON g.id_mutation = h.id_mutation
  LEFT JOIN terrain t ON t.id_mutation = h.id_mutation
  -- Seules les ventes SANS aucun local entrent ici : les autres appartiennent
  -- à \`dvf_candidates\` et ne doivent pas être comptées deux fois.
  WHERE coalesce(l.has_local, false) = false
),

classified AS (
  SELECT
    x.*,
    CASE
      WHEN x.nature_mutation IS DISTINCT FROM 'Vente'   THEN 'nature_non_vente'
      WHEN x.surface_terrain <= 0                       THEN 'surface_absente'
      -- Aucune parcelle en nature « sols » : terres, prés, bois, landes…
      -- Ce n'est pas du terrain à bâtir, et ce n'est PAS une surface absente.
      -- Motif exact, pour que le compteur de rejets reste un outil de
      -- pilotage qualité et non un fourre-tout.
      WHEN x.nb_parcelles_sol = 0                       THEN 'nature_culture_non_retenue'
      WHEN x.valeur_fonciere IS NULL                    THEN 'valeur_absente'
      WHEN x.date_mutation IS NULL                      THEN 'date_invalide'
      WHEN length(x.code_insee) <> 5                    THEN 'code_insee_absent'
      WHEN x.longitude IS NULL OR x.latitude IS NULL
        OR x.longitude < -63 OR x.longitude > 56
        OR x.latitude  < -22 OR x.latitude  > 52        THEN 'geolocalisation_absente'
      ELSE NULL
    END AS reject_reason
  FROM assembled x
)
SELECT
  c.id_mutation,
  encode(sha256(c.id_mutation::bytea), 'hex')::char(64) AS dedup_key,
  c.date_mutation,
  c.nature_mutation,
  c.valeur_fonciere,
  c.surface_terrain::int                                AS surface_terrain,
  c.nb_parcelles,
  c.code_insee,
  c.code_departement,
  c.adresse_voie,
  c.code_postal,
  c.longitude,
  c.latitude,
  c.reject_reason,
  /*
   * Annexe A.2 : on MARQUE, on ne supprime pas.
   *
   * Les bornes du bâti (300 à 25 000 €/m², 9 à 1 000 m²) ne veulent rien dire
   * ici : un terrain se vend quelques euros le m² et peut dépasser l'hectare.
   * On reprend donc EXACTEMENT les bornes déjà retenues côté lecture par
   * \`PROFILES.terrain.cleanOptions\` (comparables_repository.ts) — une seule
   * intention, deux points d'application.
   */
  CASE
    WHEN c.reject_reason IS NOT NULL THEN NULL
    /*
     * Lot mixte : au moins une parcelle en nature « sols », mais pas toutes.
     * \`valeur_fonciere\` couvre l'ensemble de la vente ; aucun découpage
     * fiable n'est possible entre la partie constructible et le reste. Le
     * prix au m² qu'on en tirerait serait faux dans un sens ou dans l'autre.
     * Testé EN PREMIER : c'est le diagnostic le plus informatif, et il doit
     * primer sur un « prix hors bornes » qui n'en serait que la conséquence.
     */
    WHEN c.nb_parcelles_sol < c.nb_parcelles            THEN 'terrain_mixte'
    WHEN c.valeur_fonciere < 5000                       THEN 'valeur_symbolique'
    WHEN c.surface_terrain < 1 OR c.surface_terrain > 100000
                                                        THEN 'surface_hors_bornes'
    WHEN (c.valeur_fonciere / c.surface_terrain) < 1
      OR (c.valeur_fonciere / c.surface_terrain) > 25000 THEN 'prix_hors_bornes'
    ELSE NULL
  END AS exclusion_reason
FROM classified c
`

/** Upsert des mutations de terrain conservées. Mêmes garanties que le bâti. */
export const INSERT_TERRAIN_SQL = `
WITH upserted AS (
  INSERT INTO mutations_terrain (
    dedup_key, id_mutation, date_mutation, nature_mutation, valeur_fonciere,
    type_local, surface_bati, nb_pieces, surface_terrain, nb_locaux, nb_dependances,
    code_insee, code_departement, adresse_voie, code_postal,
    longitude, latitude, geom,
    is_outlier, exclusion_reason, geoloc_source, geoloc_fine,
    source_annee, imported_at
  )
  SELECT
    c.dedup_key, c.id_mutation, c.date_mutation, c.nature_mutation, c.valeur_fonciere,
    -- §5.1 : « mutations_terrain — même structure, type_local = 'terrain',
    -- surface_bati NULL, prix_m2 calculé sur surface_terrain ».
    'terrain', NULL, NULL, c.surface_terrain, c.nb_parcelles, 0,
    c.code_insee, c.code_departement, c.adresse_voie, c.code_postal,
    c.longitude, c.latitude,
    ST_SetSRID(ST_MakePoint(c.longitude, c.latitude), 4326)::geography,
    (c.exclusion_reason IS NOT NULL), c.exclusion_reason,
    'dvf', true,
    $1, now()
  FROM dvf_candidates_terrain c
  WHERE c.reject_reason IS NULL
  ON CONFLICT (dedup_key, date_mutation) DO UPDATE SET
    nature_mutation  = EXCLUDED.nature_mutation,
    valeur_fonciere  = EXCLUDED.valeur_fonciere,
    surface_terrain  = EXCLUDED.surface_terrain,
    nb_locaux        = EXCLUDED.nb_locaux,
    code_insee       = EXCLUDED.code_insee,
    code_departement = EXCLUDED.code_departement,
    adresse_voie     = EXCLUDED.adresse_voie,
    code_postal      = EXCLUDED.code_postal,
    longitude        = EXCLUDED.longitude,
    latitude         = EXCLUDED.latitude,
    geom             = EXCLUDED.geom,
    is_outlier       = EXCLUDED.is_outlier,
    exclusion_reason = EXCLUDED.exclusion_reason,
    source_annee     = EXCLUDED.source_annee,
    imported_at      = EXCLUDED.imported_at
  RETURNING 1 AS touched
)
SELECT count(*)::bigint AS upserted FROM upserted
`

/** Mutations de terrain candidates déjà présentes (⇒ `rows_updated`). */
export const COUNT_PREEXISTING_TERRAIN_SQL = `
SELECT count(*)::bigint AS total
FROM dvf_candidates_terrain c
JOIN mutations_terrain m
  ON m.dedup_key = c.dedup_key
 AND m.date_mutation = c.date_mutation
WHERE c.reject_reason IS NULL
`

/** Années à provisionner en partitions pour `mutations_terrain`. */
export const TERRAIN_YEARS_SQL = `
SELECT DISTINCT extract(year FROM date_mutation)::int AS year
FROM dvf_candidates_terrain
WHERE reject_reason IS NULL AND date_mutation IS NOT NULL
ORDER BY 1
`

/**
 * Décompte des rejets de TERRAIN par motif.
 *
 * Le pendant de `REJECTED_COUNTS_SQL` pour `mutations_terrain`, qui n'existait
 * pas : seul un total agrégé était rapporté. Or c'est précisément ici que le
 * pilotage qualité se joue — distinguer « le fichier n'a pas de surface » de
 * « cette vente n'est pas du terrain à bâtir » (`nature_culture_non_retenue`)
 * décide de la conduite à tenir, et un total ne le dit pas.
 */
export const TERRAIN_REJECTED_COUNTS_SQL = `
SELECT reject_reason AS reason, count(*)::bigint AS total
FROM dvf_candidates_terrain
WHERE reject_reason IS NOT NULL
GROUP BY reject_reason
`

/** Synthèse des terrains d'un département traité. */
export const TERRAIN_SUMMARY_SQL = `
SELECT
  count(*)::bigint                                         AS mutations_seen,
  count(*) FILTER (WHERE reject_reason IS NULL)::bigint     AS kept,
  count(*) FILTER (WHERE reject_reason IS NOT NULL)::bigint AS rejected,
  count(*) FILTER (WHERE reject_reason IS NULL
                     AND exclusion_reason IS NOT NULL)::bigint AS outliers
FROM dvf_candidates_terrain
`
