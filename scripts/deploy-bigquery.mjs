#!/usr/bin/env node
/**
 * Déploiement de l'entrepôt BigQuery — `npm run bq:deploy`.
 *
 * Même parti pris que `build-gtm-container.mjs` : la configuration vit dans le
 * dépôt, pas dans une console. Un dataset créé à la souris n'est ni relisible
 * en revue, ni reconstructible, et personne ne peut dire qui a changé quoi.
 * Ici, `bigquery/sql/` est la source de vérité et ce script l'applique.
 *
 * IDEMPOTENT — tout est en `CREATE OR REPLACE` (vues, fonctions) ou en
 * `CREATE ... IF NOT EXISTS` (tables). Rejouable autant de fois qu'on veut,
 * sans jamais détruire de données : aucune instruction du dossier `sql/` ne
 * remplace une table.
 *
 * TOLÉRANT AUX SOURCES MANQUANTES — l'export GA4 et le transfert Google Ads se
 * branchent côté Google, pas ici. Le script détecte ce qui est réellement
 * présent, déploie ce qui peut l'être, et dit en clair ce qu'il a sauté. Le
 * contraire — tout ou rien — obligerait à attendre que les trois sources
 * soient prêtes avant de voir quoi que ce soit.
 *
 * Prérequis : `gcloud auth login` et le CLI `bq` (Google Cloud SDK).
 *
 * Variables d'environnement (toutes optionnelles, cf. la détection ci-dessous) :
 *   GCP_PROJECT              défaut `estimer-505209`
 *   BQ_LOCATION              défaut `EU`
 *   GA4_PROPERTY_ID          identifiant numérique de la propriété GA4
 *   GOOGLE_ADS_CUSTOMER_ID   identifiant client Ads, sans tirets
 *
 * Options :
 *   --dry-run    affiche le SQL résolu sans rien exécuter
 *   --only=<x>   ne déploie que les modèles dont le chemin contient <x>
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SQL = join(RACINE, 'bigquery', 'sql')

const PROJET = process.env.GCP_PROJECT || 'estimer-505209'
const LOCALISATION = process.env.BQ_LOCATION || 'EU'

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const FILTRE = (args.find((a) => a.startsWith('--only=')) || '').slice(7)

/*
 * Les six datasets. La séparation raw / staging / marts n'est pas décorative :
 * elle décide de qui a le droit de lire quoi. `marts` est le seul qu'on ouvre
 * aux lecteurs (Looker Studio, associés) ; `raw_app` portera un jour des
 * coordonnées de prospects et ne doit jamais suivre le même chemin.
 */
const DATASETS = [
  ['raw_google_ads', "Brut — export BigQuery Data Transfer Service du compte Google Ads."],
  ['raw_meta_ads', 'Brut — insights Meta Marketing API chargés par scripts/ingest-meta-ads.mjs.'],
  ['raw_app', 'Brut — données applicatives estimer.co. Réservé au lot T5.'],
  ['staging', 'Normalisation — une vue par source. Aucune règle métier.'],
  ['marts', 'Source de vérité — modèles métier. Le seul dataset à ouvrir aux lecteurs.'],
  ['ops', 'Exploitation — journal des ingestions et contrôles de fraîcheur.'],
]

/*
 * Ordre de déploiement explicite, et non tri alphabétique du dossier : une vue
 * qui référence une vue non encore créée échoue. L'ordre est une dépendance,
 * il se lit donc ici plutôt que de se deviner dans des noms de fichiers.
 *
 * `requiert` déclare la source externe sans laquelle le modèle ne peut pas
 * exister. `bouchon` désigne le repli à déployer quand elle manque.
 */
const MODELES = [
  { fichier: '00_ops/ingestion_runs.sql' },
  { fichier: '00_ops/meta_ad_insights_daily.sql' },

  { fichier: '10_staging/udf_ga4_params.sql' },
  { fichier: '10_staging/stg_ga4__events.sql', requiert: 'ga4' },
  { fichier: '10_staging/stg_ga4__leads.sql', requiert: 'ga4' },
  { fichier: '10_staging/stg_ga4__sessions.sql', requiert: 'ga4' },
  {
    fichier: '10_staging/stg_google_ads__campaign_daily.sql',
    requiert: 'google_ads',
    bouchon: '10_staging/stg_google_ads__campaign_daily.stub.sql',
  },
  {
    fichier: '10_staging/stg_google_ads__conversion_action_daily.sql',
    requiert: 'google_ads',
    bouchon: '10_staging/stg_google_ads__conversion_action_daily.stub.sql',
  },
  { fichier: '10_staging/stg_meta_ads__campaign_daily.sql' },
  { fichier: '10_staging/stg_ads__spend_daily.sql' },

  { fichier: '20_marts/dim_campaign.sql' },
  { fichier: '20_marts/fct_leads.sql', requiert: 'ga4' },
  { fichier: '20_marts/fct_marketing_performance_daily.sql', requiert: 'ga4' },
  { fichier: '20_marts/fct_estimation_funnel_daily.sql', requiert: 'ga4' },
  { fichier: '20_marts/v_platform_reconciliation.sql', requiert: 'ga4' },
  { fichier: '20_marts/v_data_freshness.sql', requiert: 'ga4' },
]

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

/*
 * `entree` alimente stdin. C'est le SEUL moyen de passer nos requêtes à `bq` :
 * chaque fichier SQL commence par un commentaire `--`, que le parseur de flags
 * prend pour une option longue et rejette avant même d'avoir lu la requête.
 */
function bq(args, { entree } = {}) {
  try {
    return execFileSync('bq', [`--project_id=${PROJET}`, ...args], {
      encoding: 'utf8',
      input: entree,
      stdio: [entree === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
  } catch (erreur) {
    const sortie = `${erreur.stdout || ''}${erreur.stderr || ''}`.trim()
    const enrichie = new Error(sortie || erreur.message)
    enrichie.sortieBq = sortie
    throw enrichie
  }
}

const c = {
  gras: (s) => `\u001b[1m${s}\u001b[0m`,
  vert: (s) => `\u001b[32m${s}\u001b[0m`,
  jaune: (s) => `\u001b[33m${s}\u001b[0m`,
  rouge: (s) => `\u001b[31m${s}\u001b[0m`,
  gris: (s) => `\u001b[90m${s}\u001b[0m`,
}

// ---------------------------------------------------------------------------
// Détection des sources
// ---------------------------------------------------------------------------

/**
 * L'export GA4 crée lui-même un dataset `analytics_<propertyId>` : on ne peut
 * ni le nommer, ni le créer d'avance. On le cherche donc, plutôt que d'exiger
 * qu'on nous donne un identifiant qu'un `bq ls` sait lire.
 */
function detecterGa4() {
  const impose = process.env.GA4_PROPERTY_ID
  if (impose) return `analytics_${impose}`

  const sortie = bq(['ls', '--datasets', '--max_results=1000'])
  const trouves = sortie
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^analytics_\d+$/.test(l))

  if (trouves.length === 0) return null
  if (trouves.length > 1) {
    console.warn(
      c.jaune(
        `  ⚠ ${trouves.length} datasets GA4 trouvés (${trouves.join(', ')}). ` +
          `Renseigner GA4_PROPERTY_ID pour lever l'ambiguïté ; on prend ${trouves[0]}.`
      )
    )
  }
  return trouves[0]
}

/**
 * Même logique côté Ads : le transfert nomme ses tables `p_ads_<Objet>_<CID>`.
 * On cherche la table de statistiques campagne, qui est celle dont dépend le
 * modèle — sa seule présence garantit que le transfert a bien tourné, là où un
 * identifiant fourni à la main ne garantit rien.
 */
function detecterAds() {
  let sortie
  try {
    sortie = bq(['ls', '--max_results=1000', `${PROJET}:raw_google_ads`])
  } catch {
    return null
  }
  const trouves = [...sortie.matchAll(/p_ads_CampaignBasicStats_(\d+)/g)].map((m) => m[1])
  if (trouves.length === 0) return null

  const impose = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/\D/g, '')
  if (impose && trouves.includes(impose)) return impose
  if (trouves.length > 1) {
    console.warn(
      c.jaune(
        `  ⚠ ${trouves.length} comptes Ads dans raw_google_ads (${trouves.join(', ')}). ` +
          `Renseigner GOOGLE_ADS_CUSTOMER_ID ; on prend ${trouves[0]}.`
      )
    )
  }
  return trouves[0]
}

// ---------------------------------------------------------------------------
// Déploiement
// ---------------------------------------------------------------------------

function creerDatasets() {
  const existants = new Set(
    bq(['ls', '--datasets', '--max_results=1000'])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  )

  for (const [nom, description] of DATASETS) {
    if (existants.has(nom)) {
      console.log(`  ${c.gris('=')} ${nom} ${c.gris('(déjà présent)')}`)
      continue
    }
    if (DRY_RUN) {
      console.log(`  ${c.jaune('+')} ${nom} ${c.gris('(dry-run)')}`)
      continue
    }
    bq([
      'mk',
      '--dataset',
      `--location=${LOCALISATION}`,
      `--description=${description}`,
      '--label=projet:estimer',
      `${PROJET}:${nom}`,
    ])
    console.log(`  ${c.vert('+')} ${nom}`)
  }
}

/**
 * Supprime l'objet qu'un fichier SQL aurait créé. Le nom est lu dans le fichier
 * lui-même plutôt que déclaré dans `MODELES` : une déclaration en double finit
 * toujours par diverger du SQL, et c'est alors la mauvaise vue qu'on supprime.
 */
function supprimerCible(sql, remplacements) {
  const capture = sql.match(/CREATE\s+OR\s+REPLACE\s+(VIEW|TABLE|FUNCTION)\s+`([^`]+)`/i)
  if (!capture) return
  const [, type, cible] = capture
  // Substitution locale, sans passer par `resoudre` : celui-ci lève sur un
  // placeholder non résolu, ce qui ferait échouer un simple ménage.
  let nom = cible
  for (const [cle, valeur] of Object.entries(remplacements)) nom = nom.replaceAll(`\${${cle}}`, valeur)
  if (nom.includes('${') || nom.includes('_ABSENT')) return
  if (DRY_RUN) return
  try {
    bq(['query', '--use_legacy_sql=false', `--location=${LOCALISATION}`, '--format=none'], {
      entree: `DROP ${type.toUpperCase()} IF EXISTS \`${nom}\``,
    })
    console.log(`     ${c.gris(`↳ ${type.toLowerCase()} ${nom} supprimée (deviendrait orpheline)`)}`)
  } catch {
    /* Une vue qui n'existait pas n'est pas un problème. */
  }
}

function resoudre(sql, remplacements) {
  let resultat = sql
  for (const [cle, valeur] of Object.entries(remplacements)) {
    resultat = resultat.replaceAll(`\${${cle}}`, valeur)
  }
  const restants = [...resultat.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1])
  if (restants.length > 0) {
    throw new Error(`Placeholders non résolus : ${[...new Set(restants)].join(', ')}`)
  }
  return resultat
}

function main() {
  console.log(c.gras(`\nEntrepôt BigQuery — ${PROJET} (${LOCALISATION})\n`))

  console.log(c.gras('1. Datasets'))
  creerDatasets()

  console.log(c.gras('\n2. Sources externes'))
  const datasetGa4 = detecterGa4()
  const cidAds = detecterAds()

  console.log(
    datasetGa4
      ? `  ${c.vert('✓')} GA4        ${datasetGa4}`
      : `  ${c.jaune('✗')} GA4        export BigQuery non branché — voir bigquery/README.md §2`
  )
  console.log(
    cidAds
      ? `  ${c.vert('✓')} Google Ads compte ${cidAds}`
      : `  ${c.jaune('✗')} Google Ads transfert non branché — bouchon déployé, voir bigquery/README.md §3`
  )
  console.log(`  ${c.vert('✓')} Meta       table alimentée par scripts/ingest-meta-ads.mjs`)

  const disponibles = new Set(['meta'])
  if (datasetGa4) disponibles.add('ga4')
  if (cidAds) disponibles.add('google_ads')

  const remplacements = {
    PROJECT: PROJET,
    GA4_DATASET: datasetGa4 || 'GA4_ABSENT',
    ADS_CUSTOMER_ID: cidAds || 'ADS_ABSENT',
  }

  console.log(c.gras('\n3. Modèles'))
  const deployes = []
  const sautes = []
  const echecs = []

  for (const modele of MODELES) {
    if (FILTRE && !modele.fichier.includes(FILTRE)) continue

    let fichier = modele.fichier
    let bouchonUtilise = false

    if (modele.requiert && !disponibles.has(modele.requiert)) {
      if (!modele.bouchon) {
        sautes.push(modele.fichier)
        console.log(`  ${c.jaune('⊘')} ${modele.fichier} ${c.gris(`(source ${modele.requiert} absente)`)}`)
        /*
         * Sauter ne suffit pas : si le modèle avait été déployé quand la source
         * existait, la vue survivrait en pointant vers un dataset disparu. Elle
         * ne planterait qu'à la lecture, et probablement dans un tableau de
         * bord, devant quelqu'un. On la supprime.
         */
        supprimerCible(readFileSync(join(SQL, modele.fichier), 'utf8'), remplacements)
        continue
      }
      fichier = modele.bouchon
      bouchonUtilise = true
    }

    const chemin = join(SQL, fichier)
    if (!existsSync(chemin)) {
      echecs.push([fichier, 'fichier introuvable'])
      console.log(`  ${c.rouge('✗')} ${fichier} — fichier introuvable`)
      continue
    }

    let sql
    try {
      sql = resoudre(readFileSync(chemin, 'utf8'), remplacements)
    } catch (erreur) {
      echecs.push([fichier, erreur.message])
      console.log(`  ${c.rouge('✗')} ${fichier} — ${erreur.message}`)
      continue
    }

    if (DRY_RUN) {
      console.log(`\n${c.gris('--- ' + fichier + ' ---')}\n${sql}`)
      deployes.push(fichier)
      continue
    }

    try {
      bq(['query', '--use_legacy_sql=false', `--location=${LOCALISATION}`, '--format=none'], { entree: sql })
      const marque = bouchonUtilise ? c.jaune('◐') : c.vert('✓')
      const note = bouchonUtilise ? c.jaune(' [BOUCHON — aucune donnée]') : ''
      console.log(`  ${marque} ${modele.fichier}${note}`)
      deployes.push(fichier)
    } catch (erreur) {
      echecs.push([fichier, erreur.message])
      console.log(`  ${c.rouge('✗')} ${fichier}`)
      console.log(c.gris(erreur.message.split('\n').slice(0, 6).map((l) => `      ${l}`).join('\n')))
    }
  }

  console.log(c.gras('\n4. Bilan'))
  console.log(`  ${deployes.length} déployés, ${sautes.length} sautés, ${echecs.length} en échec`)

  if (sautes.length > 0) {
    console.log(
      c.jaune(
        `\n  Les modèles sautés le resteront tant que leur source n'existe pas.\n` +
          `  Rejouer ce script après avoir branché la source suffit : rien n'est perdu.`
      )
    )
  }

  if (echecs.length > 0) {
    console.log(c.rouge('\n  Échecs :'))
    for (const [fichier, message] of echecs) {
      console.log(c.rouge(`   · ${fichier} : ${message.split('\n')[0]}`))
    }
    process.exitCode = 1
    return
  }

  console.log(c.vert('\n  Entrepôt à jour.\n'))
}

main()
