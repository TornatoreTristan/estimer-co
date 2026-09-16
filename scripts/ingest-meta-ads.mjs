#!/usr/bin/env node
/**
 * Ingestion Meta Ads → BigQuery — `npm run bq:meta`.
 *
 * Meta est la seule des trois sources sans connecteur natif vers BigQuery.
 * Google fournit l'export GA4 et le Data Transfer Service ; Meta ne fournit
 * rien, et les connecteurs du marché (Fivetran, Airbyte Cloud, Windsor) coûtent
 * plus cher par mois que le budget média des premières campagnes. Ce script
 * fait le strict nécessaire : appeler l'API Insights, écrire dans BigQuery,
 * consigner l'exécution.
 *
 * ZÉRO DÉPENDANCE — comme le reste de `scripts/`. Authentification GCP par JWT
 * auto-signé (compte de service) ou, à défaut, par les identifiants locaux de
 * `gcloud`. Cela permet de le faire tourner aussi bien à la main qu'en tâche
 * planifiée dans un conteneur qui n'a pas le SDK Google installé.
 *
 * FENÊTRE GLISSANTE, PAS D'AJOUT — Meta ré-attribue ses conversions jusqu'à
 * 28 jours en arrière : les chiffres d'hier ne sont pas définitifs. Chaque
 * exécution recharge donc toute la fenêtre et remplace ce qu'elle couvre. Un
 * chargement en ajout produirait à la fois des doublons et des chiffres
 * périmés — et personne ne s'en apercevrait avant de comparer avec Ads Manager.
 *
 * Variables d'environnement :
 *   META_ACCESS_TOKEN        jeton d'un utilisateur système (longue durée). REQUIS
 *   META_AD_ACCOUNT_ID       identifiant du compte publicitaire, avec ou sans `act_`. REQUIS
 *   META_API_VERSION         défaut `v23.0` — cf. la note en §Versions ci-dessous
 *   META_LOOKBACK_DAYS       défaut 28
 *   GCP_PROJECT              défaut `estimer-505209`
 *   BQ_LOCATION              défaut `EU`
 *   GOOGLE_APPLICATION_CREDENTIALS  chemin d'une clé de compte de service (optionnel)
 *
 * Options :
 *   --since=AAAA-MM-JJ --until=AAAA-MM-JJ   fenêtre explicite (rattrapage)
 *   --dry-run                                appelle Meta, n'écrit pas dans BigQuery
 *
 * §Versions — Meta retire ses versions d'API au bout d'environ deux ans. Le
 * jour où ce script répond « Unsupported get request », c'est `META_API_VERSION`
 * qu'il faut monter, pas le code.
 */

import { execFileSync } from 'node:child_process'
import { createSign, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const PROJET = process.env.GCP_PROJECT || 'estimer-505209'
const LOCALISATION = process.env.BQ_LOCATION || 'EU'
const VERSION_API = process.env.META_API_VERSION || 'v23.0'
const JETON_META = process.env.META_ACCESS_TOKEN
const COMPTE_META = (process.env.META_AD_ACCOUNT_ID || '').replace(/^act_/, '')
const RETROSPECTIVE = Number(process.env.META_LOOKBACK_DAYS || 28)

const TABLE_CIBLE = 'ad_insights_daily'
const TABLE_TAMPON = 'ad_insights_daily__staging'

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const optionDate = (nom) => (args.find((a) => a.startsWith(`--${nom}=`)) || '').split('=')[1] || null

/*
 * Le schéma est déclaré ici et non déduit par `autodetect`. L'auto-détection
 * lit les premières lignes du fichier : une journée sans conversion produirait
 * un `actions` vide, donc une colonne absente, donc une table dont le schéma
 * change d'un jour à l'autre. Toutes les vues en aval tomberaient.
 */
const SCHEMA = [
  { name: 'date', type: 'DATE', mode: 'REQUIRED' },
  { name: 'account_id', type: 'STRING' },
  { name: 'account_name', type: 'STRING' },
  { name: 'campaign_id', type: 'STRING' },
  { name: 'campaign_name', type: 'STRING' },
  { name: 'adset_id', type: 'STRING' },
  { name: 'adset_name', type: 'STRING' },
  { name: 'ad_id', type: 'STRING' },
  { name: 'ad_name', type: 'STRING' },
  { name: 'impressions', type: 'INTEGER' },
  { name: 'clicks', type: 'INTEGER' },
  { name: 'inline_link_clicks', type: 'INTEGER' },
  { name: 'reach', type: 'INTEGER' },
  { name: 'frequency', type: 'FLOAT' },
  { name: 'spend', type: 'NUMERIC' },
  { name: 'currency', type: 'STRING' },
  {
    name: 'actions',
    type: 'RECORD',
    mode: 'REPEATED',
    fields: [
      { name: 'action_type', type: 'STRING' },
      { name: 'value', type: 'FLOAT' },
    ],
  },
  {
    name: 'action_values',
    type: 'RECORD',
    mode: 'REPEATED',
    fields: [
      { name: 'action_type', type: 'STRING' },
      { name: 'value', type: 'FLOAT' },
    ],
  },
  { name: 'ingested_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
]

const COLONNES = SCHEMA.map((champ) => champ.name)

// ---------------------------------------------------------------------------
// Authentification Google
// ---------------------------------------------------------------------------

let jetonGoogleCache = null

/**
 * Deux chemins volontairement : le compte de service pour l'exécution
 * planifiée, `gcloud` pour la mise au point. Exiger une clé de service pour
 * lancer le script à la main obligerait à en faire circuler une, et une clé qui
 * circule finit dans un dépôt.
 */
async function jetonGoogle() {
  if (jetonGoogleCache && jetonGoogleCache.expire > Date.now() + 60_000) {
    return jetonGoogleCache.valeur
  }

  const chemin = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (chemin) {
    const compte = JSON.parse(readFileSync(chemin, 'utf8'))
    const maintenant = Math.floor(Date.now() / 1000)
    const b64 = (objet) => Buffer.from(JSON.stringify(objet)).toString('base64url')
    const nonSigne =
      `${b64({ alg: 'RS256', typ: 'JWT' })}.` +
      b64({
        iss: compte.client_email,
        scope: 'https://www.googleapis.com/auth/bigquery',
        aud: 'https://oauth2.googleapis.com/token',
        iat: maintenant,
        exp: maintenant + 3600,
      })
    const signature = createSign('RSA-SHA256').update(nonSigne).sign(compte.private_key, 'base64url')

    const reponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${nonSigne}.${signature}`,
      }),
    })
    if (!reponse.ok) throw new Error(`Jeton Google refusé : ${await reponse.text()}`)
    const donnees = await reponse.json()
    jetonGoogleCache = { valeur: donnees.access_token, expire: Date.now() + donnees.expires_in * 1000 }
    return jetonGoogleCache.valeur
  }

  const valeur = execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], {
    encoding: 'utf8',
  }).trim()
  jetonGoogleCache = { valeur, expire: Date.now() + 45 * 60_000 }
  return valeur
}

async function bigquery(chemin, options = {}) {
  const reponse = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJET}${chemin}`, {
    ...options,
    headers: {
      authorization: `Bearer ${await jetonGoogle()}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const texte = await reponse.text()
  if (!reponse.ok) throw new Error(`BigQuery ${reponse.status} sur ${chemin} : ${texte}`)
  return texte ? JSON.parse(texte) : {}
}

async function requete(sql, parametres = []) {
  const resultat = await bigquery('/queries', {
    method: 'POST',
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      location: LOCALISATION,
      parameterMode: parametres.length ? 'NAMED' : undefined,
      queryParameters: parametres.length ? parametres : undefined,
      timeoutMs: 120_000,
    }),
  })
  if (resultat.errors?.length) throw new Error(JSON.stringify(resultat.errors))
  return resultat
}

// ---------------------------------------------------------------------------
// Meta Marketing API
// ---------------------------------------------------------------------------

const CHAMPS_META = [
  'account_id',
  'account_name',
  'account_currency',
  'campaign_id',
  'campaign_name',
  'adset_id',
  'adset_name',
  'ad_id',
  'ad_name',
  'impressions',
  'clicks',
  'inline_link_clicks',
  'reach',
  'frequency',
  'spend',
  'actions',
  'action_values',
]

const nombre = (valeur) => (valeur === undefined || valeur === null || valeur === '' ? null : Number(valeur))

function normaliserActions(brut) {
  if (!Array.isArray(brut)) return []
  return brut
    .map((action) => ({ action_type: action.action_type, value: nombre(action.value) }))
    .filter((action) => action.action_type && action.value !== null)
}

/**
 * `time_increment=1` est ce qui fait la différence entre un entrepôt et une
 * capture d'écran : sans lui, l'API renvoie un seul total pour toute la
 * période, inutilisable dès qu'on veut une série temporelle.
 *
 * Le niveau `ad` est le plus fin disponible. On pourrait agréger côté Meta pour
 * réduire le volume, mais il faudrait alors rappeler l'API à chaque fois qu'une
 * question descend d'un cran — et les quotas de l'API sont la ressource rare
 * ici, pas le stockage BigQuery.
 */
async function lireInsights(depuis, jusqua) {
  const url = new URL(`https://graph.facebook.com/${VERSION_API}/act_${COMPTE_META}/insights`)
  url.searchParams.set('level', 'ad')
  url.searchParams.set('time_increment', '1')
  url.searchParams.set('time_range', JSON.stringify({ since: depuis, until: jusqua }))
  url.searchParams.set('fields', CHAMPS_META.join(','))
  url.searchParams.set('limit', '500')
  url.searchParams.set('access_token', JETON_META)

  const lignes = []
  let suivante = url.toString()
  let page = 0

  while (suivante) {
    page += 1
    const reponse = await fetch(suivante)
    const donnees = await reponse.json()
    if (!reponse.ok || donnees.error) {
      throw new Error(`Meta API : ${JSON.stringify(donnees.error || donnees)}`)
    }
    lignes.push(...(donnees.data || []))
    process.stdout.write(`  page ${page} — ${lignes.length} lignes cumulées\r`)

    // Meta pagine par curseur. Les 200 premières pages sont un garde-fou : une
    // pagination qui ne s'arrête pas est un bug de l'API, pas une grosse
    // journée, et il vaut mieux échouer que boucler toute la nuit.
    suivante = donnees.paging?.next || null
    if (page > 200) throw new Error('Pagination Meta anormale (>200 pages) — arrêt.')
  }
  process.stdout.write('\n')
  return lignes
}

function convertir(ligne, horodatage) {
  return {
    date: ligne.date_start,
    account_id: ligne.account_id ?? null,
    account_name: ligne.account_name ?? null,
    campaign_id: ligne.campaign_id ?? null,
    campaign_name: ligne.campaign_name ?? null,
    adset_id: ligne.adset_id ?? null,
    adset_name: ligne.adset_name ?? null,
    ad_id: ligne.ad_id ?? null,
    ad_name: ligne.ad_name ?? null,
    impressions: nombre(ligne.impressions),
    clicks: nombre(ligne.clicks),
    inline_link_clicks: nombre(ligne.inline_link_clicks),
    reach: nombre(ligne.reach),
    frequency: nombre(ligne.frequency),
    // L'API renvoie la dépense en chaîne. La garder telle quelle jusqu'à
    // BigQuery évite l'arrondi binaire d'un passage par Number : la colonne est
    // NUMERIC précisément pour que 0,01 € reste 0,01 €.
    spend: ligne.spend ?? '0',
    currency: ligne.account_currency ?? null,
    actions: normaliserActions(ligne.actions),
    action_values: normaliserActions(ligne.action_values),
    ingested_at: horodatage,
  }
}

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------

async function chargerTampon(lignes) {
  const ndjson = lignes.map((l) => JSON.stringify(l)).join('\n')
  const frontiere = `estimer-${randomUUID()}`
  const configuration = {
    configuration: {
      load: {
        destinationTable: { projectId: PROJET, datasetId: 'raw_meta_ads', tableId: TABLE_TAMPON },
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: 'WRITE_TRUNCATE',
        createDisposition: 'CREATE_IF_NEEDED',
        schema: { fields: SCHEMA },
      },
    },
    jobReference: { projectId: PROJET, location: LOCALISATION },
  }

  const corps =
    `--${frontiere}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(configuration)}\r\n` +
    `--${frontiere}\r\nContent-Type: application/octet-stream\r\n\r\n` +
    `${ndjson}\r\n--${frontiere}--\r\n`

  const reponse = await fetch(
    `https://bigquery.googleapis.com/upload/bigquery/v2/projects/${PROJET}/jobs?uploadType=multipart`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await jetonGoogle()}`,
        'content-type': `multipart/related; boundary=${frontiere}`,
      },
      body: corps,
    }
  )
  const texte = await reponse.text()
  if (!reponse.ok) throw new Error(`Chargement refusé : ${texte}`)

  let tache = JSON.parse(texte)
  const id = tache.jobReference.jobId

  // Attente active. Un chargement de quelques milliers de lignes tient en
  // quelques secondes ; la borne à 5 minutes évite qu'une tâche coincée
  // maintienne le processus en vie indéfiniment dans un planificateur.
  const limite = Date.now() + 5 * 60_000
  while (tache.status?.state !== 'DONE') {
    if (Date.now() > limite) throw new Error(`Chargement ${id} toujours en cours après 5 minutes.`)
    await new Promise((r) => setTimeout(r, 2000))
    tache = await bigquery(`/jobs/${id}?location=${LOCALISATION}`)
  }
  if (tache.status.errorResult) throw new Error(`Chargement échoué : ${JSON.stringify(tache.status.errorResult)}`)

  return Number(tache.statistics?.load?.outputRows || 0)
}

/**
 * Remplacement de la fenêtre, en transaction. Sans transaction, un incident
 * entre le DELETE et l'INSERT laisserait l'entrepôt avec un trou de 28 jours —
 * et un trou est bien pire qu'un doublon : il se lit comme une baisse de
 * performance, et on cherche la cause du côté des campagnes.
 */
async function remplacerFenetre(depuis, jusqua) {
  const colonnes = COLONNES.join(', ')
  await requete(
    `
    BEGIN TRANSACTION;
    DELETE FROM \`${PROJET}.raw_meta_ads.${TABLE_CIBLE}\`
     WHERE date BETWEEN @depuis AND @jusqua;
    INSERT INTO \`${PROJET}.raw_meta_ads.${TABLE_CIBLE}\` (${colonnes})
    SELECT ${colonnes} FROM \`${PROJET}.raw_meta_ads.${TABLE_TAMPON}\`;
    COMMIT TRANSACTION;
    `,
    [
      { name: 'depuis', parameterType: { type: 'DATE' }, parameterValue: { value: depuis } },
      { name: 'jusqua', parameterType: { type: 'DATE' }, parameterValue: { value: jusqua } },
    ]
  )
}

async function journaliser(champs) {
  const valeurs = [
    `'${champs.run_id}'`,
    `'meta_ads'`,
    `TIMESTAMP('${champs.started_at}')`,
    champs.finished_at ? `TIMESTAMP('${champs.finished_at}')` : 'NULL',
    `'${champs.status}'`,
    `DATE('${champs.window_start}')`,
    `DATE('${champs.window_end}')`,
    champs.rows_loaded === null ? 'NULL' : String(champs.rows_loaded),
    champs.error_message ? `'${champs.error_message.replaceAll("'", "''").slice(0, 2000)}'` : 'NULL',
  ]
  await requete(
    `INSERT INTO \`${PROJET}.ops.ingestion_runs\`
       (run_id, source, started_at, finished_at, status, window_start, window_end, rows_loaded, error_message)
     VALUES (${valeurs.join(', ')})`
  )
}

// ---------------------------------------------------------------------------

const jour = (decalage) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - decalage)
  return d.toISOString().slice(0, 10)
}

async function main() {
  if (!JETON_META || !COMPTE_META) {
    console.error(
      'META_ACCESS_TOKEN et META_AD_ACCOUNT_ID sont requis. Voir bigquery/README.md §4.'
    )
    process.exit(2)
  }

  // Jusqu'à hier, jamais jusqu'à aujourd'hui : une journée en cours est
  // incomplète, et l'écrire dans l'entrepôt revient à publier un chiffre qu'on
  // sait faux.
  const jusqua = optionDate('until') || jour(1)
  const depuis = optionDate('since') || jour(RETROSPECTIVE)

  const runId = randomUUID()
  const debut = new Date().toISOString()

  console.log(`\nMeta Ads → BigQuery — compte act_${COMPTE_META}`)
  console.log(`Fenêtre : ${depuis} → ${jusqua}${DRY_RUN ? '  (dry-run)' : ''}\n`)

  let lignes
  try {
    lignes = await lireInsights(depuis, jusqua)
  } catch (erreur) {
    if (!DRY_RUN) {
      await journaliser({
        run_id: runId,
        started_at: debut,
        finished_at: new Date().toISOString(),
        status: 'failure',
        window_start: depuis,
        window_end: jusqua,
        rows_loaded: null,
        error_message: erreur.message,
      }).catch(() => {})
    }
    console.error(`\nÉchec de l'appel Meta : ${erreur.message}`)
    process.exit(1)
  }

  const horodatage = new Date().toISOString()
  const converties = lignes.map((l) => convertir(l, horodatage))

  if (DRY_RUN) {
    console.log(`${converties.length} lignes récupérées. Extrait :`)
    console.log(JSON.stringify(converties.slice(0, 3), null, 2))
    console.log('\nAucune écriture (dry-run).')
    return
  }

  /*
   * Zéro ligne n'est pas une erreur : un compte à l'arrêt ne dépense rien. On
   * remplace quand même la fenêtre — sans quoi une campagne stoppée garderait
   * indéfiniment sa dernière dépense dans l'entrepôt.
   */
  try {
    const chargees = converties.length > 0 ? await chargerTampon(converties) : 0
    if (converties.length === 0) {
      await requete(
        `DELETE FROM \`${PROJET}.raw_meta_ads.${TABLE_CIBLE}\` WHERE date BETWEEN @d AND @j`,
        [
          { name: 'd', parameterType: { type: 'DATE' }, parameterValue: { value: depuis } },
          { name: 'j', parameterType: { type: 'DATE' }, parameterValue: { value: jusqua } },
        ]
      )
    } else {
      await remplacerFenetre(depuis, jusqua)
    }

    await journaliser({
      run_id: runId,
      started_at: debut,
      finished_at: new Date().toISOString(),
      status: 'success',
      window_start: depuis,
      window_end: jusqua,
      rows_loaded: chargees,
      error_message: null,
    })
    console.log(`${chargees} lignes chargées dans raw_meta_ads.${TABLE_CIBLE}.`)
  } catch (erreur) {
    await journaliser({
      run_id: runId,
      started_at: debut,
      finished_at: new Date().toISOString(),
      status: 'failure',
      window_start: depuis,
      window_end: jusqua,
      rows_loaded: null,
      error_message: erreur.message,
    }).catch(() => {})
    console.error(`\nÉchec du chargement : ${erreur.message}`)
    process.exit(1)
  }
}

main()
