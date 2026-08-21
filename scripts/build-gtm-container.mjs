#!/usr/bin/env node
/**
 * Générateur du conteneur Google Tag Manager — lot T2 de
 * `specs/plan-taggage-conversions.md`.
 *
 * ---------------------------------------------------------------------------
 * POURQUOI UN GÉNÉRATEUR, ET PAS UNE CONFIGURATION FAITE À LA MAIN DANS GTM
 * ---------------------------------------------------------------------------
 * Un conteneur GTM configuré à la souris ne vit que dans l'interface de
 * Google. Il n'est ni relisible en revue, ni comparable d'une version à
 * l'autre, ni reconstructible après une fausse manœuvre — et personne ne peut
 * répondre à « qui a changé ce déclencheur, quand, et pourquoi » autrement
 * qu'en fouillant l'historique des versions du conteneur.
 *
 * Ce fichier est donc la SOURCE DE VÉRITÉ de la configuration. Il produit
 * `gtm/container-estimer-co.json`, importable tel quel dans GTM, et ce JSON
 * est committé parce que c'est lui qu'on importe. `scripts/test-gtm-container.mjs`
 * vérifie en CI qu'il n'a pas divergé de ce générateur — même logique qu'un
 * fichier de verrouillage de dépendances.
 *
 * Les 44 variables de couche de données tiennent ici en une liste ; à la main,
 * ce sont 44 formulaires identiques à remplir, donc 44 occasions de se tromper
 * de nom ou d'oublier « Version 2 ».
 *
 * ---------------------------------------------------------------------------
 * CE QUE CE FICHIER NE PEUT PAS FAIRE
 * ---------------------------------------------------------------------------
 * Ni les actions de conversion Google Ads, ni les dimensions personnalisées
 * GA4, ni le pixel Meta n'ont de format d'import. Ils restent manuels, et leur
 * mode opératoire est dans `gtm/README.md`. Le conteneur ne fait que les
 * ALIMENTER : sans eux, les balises tirent dans le vide.
 *
 * Usage : `npm run gtm:build`
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SORTIE = path.join(__dirname, "..", "gtm", "container-estimer-co.json");

/** Identifiant public du conteneur (cf. `PUBLIC_GTM_CONTAINER_ID`). */
const CONTENEUR_PUBLIC_ID = "GTM-5TB8F4CS";

/*
 * `accountId` et `containerId` à "0" : GTM les réattribue à l'import, quel que
 * soit le conteneur cible. Les figer à une valeur réelle ne servirait qu'à
 * faire croire que ce fichier n'est importable que dans un seul conteneur.
 */
const ZERO = { accountId: "0", containerId: "0" };

/**
 * Durée de vie des cookies GA4 (`_ga`, `_ga_<ID>`), en secondes.
 *
 * ---------------------------------------------------------------------------
 * CE RÉGLAGE N'EST PAS UNE OPTIMISATION, C'EST UNE OBLIGATION
 * ---------------------------------------------------------------------------
 * GA4 pose `_ga` pour DEUX ANS par défaut. Or la politique de confidentialité
 * annonce au visiteur « 13 mois maximum » pour les traceurs
 * (`src/pages/politique-de-confidentialite.astro`, section « Durées de
 * conservation »), ce qui est aussi la recommandation de la CNIL.
 *
 * Sans cette ligne, le site déposerait un traceur d'une durée que sa propre
 * politique interdit — un écart invisible depuis l'interface de GTM, et
 * précisément ce qu'un contrôle vient regarder.
 *
 * 395 jours : la valeur conventionnelle pour « 13 mois », juste en deçà de la
 * moyenne réelle (395,4 jours). `scripts/test-gtm-container.mjs` relit la durée
 * ANNONCÉE dans la politique et échoue si le conteneur la dépasse : les deux ne
 * peuvent plus diverger en silence.
 *
 * À savoir : changer cette valeur n'agit que sur les dépôts À VENIR. Un cookie
 * déjà posé pour deux ans le reste jusqu'à sa prochaine réécriture — d'où
 * l'intérêt de la poser avant la première publication du conteneur.
 */
const DUREE_COOKIE_GA4_JOURS = 395;
const DUREE_COOKIE_GA4_SECONDES = DUREE_COOKIE_GA4_JOURS * 24 * 60 * 60;

// ===========================================================================
// 1. VARIABLES INTÉGRÉES (§6.1)
// ===========================================================================

const VARIABLES_INTEGREES = [
  ["PAGE_URL", "Page URL"],
  ["PAGE_PATH", "Page Path"],
  ["PAGE_HOSTNAME", "Page Hostname"],
  ["REFERRER", "Referrer"],
  ["EVENT", "Event"],
  ["CLICK_ELEMENT", "Click Element"],
  ["CLICK_CLASSES", "Click Classes"],
  ["CLICK_URL", "Click URL"],
  ["CLICK_TEXT", "Click Text"],
];

// ===========================================================================
// 2. VARIABLES DE COUCHE DE DONNÉES (§6.2)
// ===========================================================================

/*
 * Tout ce que `src/scripts/tracking.js` et les scripts de parcours poussent.
 * L'ordre est celui du dictionnaire d'événements (§4), pas l'alphabet : on
 * relit cette liste en suivant le parcours du visiteur.
 *
 * `region` figure au plan mais n'est PAS poussé aujourd'hui (le navigateur n'a
 * aucune correspondance département -> région). La variable est créée quand
 * même : elle restera vide, GTM omettra le paramètre, et le jour où le lot 2
 * de `specs/cms-seo-tracking.md` la fournira, il n'y aura rien à changer ici.
 */
const VARIABLES_DATALAYER = [
  // Conversion
  "lead_id",
  "lead_type",
  "lead_quality",
  "value",
  "currency",
  // Bien
  "property_type",
  "surface_bucket",
  "rooms",
  "dpe",
  "postal_code",
  "city",
  "departement_code",
  "region",
  "estimation_value",
  "estimation_status",
  "is_owner",
  "want_to_sell",
  // Qualité de l'estimation
  "confidence_score",
  "comparables_count",
  "latency_ms",
  "failure_type",
  "http_status",
  // Tunnel
  "entry_point",
  "has_address_prefill",
  "step_number",
  "step_key",
  "step_direction",
  "error_fields",
  "error_count",
  "address_source",
  // Engagement
  "cta_id",
  "cta_label",
  "cta_destination",
  "contact_subject",
  "partner_slug",
  "partner_name",
  "partner_category",
  "page_type",
  "link_url",
  "position",
  // Consentement
  "consent_analytics",
  "consent_ads",
  // Conversions améliorées — lot T3. Les variables existent, rien ne les
  // alimente encore : `embHash` n'est pas livré (cf. plan §9.1).
  "user_data.sha256_email_address",
  "user_data.sha256_phone_number",
];

/*
 * Paramètres transmis à GA4 sur CHAQUE événement métier, via une variable de
 * paramètres partagée. Ceux dont la variable est vide sont omis par GTM — d'où
 * une seule balise d'événement pour tout le site (§6.5).
 *
 * `user_data.*` en est exclu : ces valeurs vont aux conversions améliorées de
 * Google Ads, pas dans les rapports GA4.
 */
const PARAMS_GA4 = VARIABLES_DATALAYER.filter(
  (nom) => !nom.startsWith("user_data.")
);

// ===========================================================================
// 3. FABRIQUES D'ENTITÉS
// ===========================================================================

const param = {
  texte: (key, value) => ({ type: "TEMPLATE", key, value }),
  booleen: (key, value) => ({ type: "BOOLEAN", key, value: String(value) }),
  entier: (key, value) => ({ type: "INTEGER", key, value: String(value) }),
  liste: (key, list) => ({ type: "LIST", key, list }),
  map: (map) => ({ type: "MAP", map }),
};

/** Référence GTM d'une variable, telle qu'on l'écrit dans un champ. */
const ref = (nom) => `{{${nom}}}`;

let prochainVariableId = 1;
let prochainTriggerId = 1;
let prochainTagId = 1;
let prochainFolderId = 1;

const variables = [];
const declencheurs = [];
const balises = [];
const dossiers = [];

function dossier(name) {
  const folderId = String(prochainFolderId++);
  dossiers.push({ ...ZERO, folderId, name, fingerprint: "0" });
  return folderId;
}

function variable(name, type, parameter, parentFolderId) {
  variables.push({
    ...ZERO,
    variableId: String(prochainVariableId++),
    name,
    type,
    parameter,
    fingerprint: "0",
    ...(parentFolderId ? { parentFolderId } : {}),
  });
  return name;
}

function declencheur(name, corps, parentFolderId) {
  const triggerId = String(prochainTriggerId++);
  declencheurs.push({
    ...ZERO,
    triggerId,
    name,
    fingerprint: "0",
    ...corps,
    ...(parentFolderId ? { parentFolderId } : {}),
  });
  return triggerId;
}

function balise(name, type, parameter, options) {
  const opts = options || {};
  balises.push({
    ...ZERO,
    tagId: String(prochainTagId++),
    name,
    type,
    parameter,
    fingerprint: "0",
    firingTriggerId: opts.declencheurs || [],
    tagFiringOption: "ONCE_PER_EVENT",
    monitoringMetadata: { type: "MAP" },
    consentSettings: opts.consentement || { consentStatus: "NOT_SET" },
    ...(opts.setupTag ? { setupTag: opts.setupTag } : {}),
    ...(opts.enPause ? { paused: true } : {}),
    ...(opts.dossier ? { parentFolderId: opts.dossier } : {}),
  });
}

/**
 * Condition d'événement personnalisé : `{{_event}}` comparé à `valeur`.
 * `type` vaut `EQUALS` (correspondance exacte) ou `MATCH_REGEX`.
 */
const filtreEvenement = (type, valeur) => ({
  type,
  parameter: [param.texte("arg0", "{{_event}}"), param.texte("arg1", valeur)],
});

/** Condition supplémentaire sur une variable, avec négation optionnelle. */
const filtreVariable = (type, variableRef, valeur, negation) => ({
  type,
  parameter: [
    param.texte("arg0", variableRef),
    param.texte("arg1", valeur),
    ...(negation ? [param.booleen("negate", true)] : []),
  ],
});

// ===========================================================================
// 4. DOSSIERS (§6.6)
// ===========================================================================

const F_SOCLE = dossier("00 — Socle");
const F_GA4 = dossier("10 — GA4");
const F_ADS = dossier("20 — Google Ads");
const F_META = dossier("30 — Meta");
const F_VARIABLES = dossier("90 — Variables");

// ===========================================================================
// 5. VARIABLES
// ===========================================================================

/*
 * LES TROIS IDENTIFIANTS DE COMPTE.
 *
 * Regroupés en constantes précisément pour cela : un identifiant recopié dans
 * huit balises est un identifiant qu'on oubliera de corriger dans la huitième.
 *
 * Aucun n'est un secret — tous les trois figurent en clair dans le HTML livré
 * dès que les balises tirent. Les versionner ici évite de les ressaisir à
 * chaque import, qui est exactement l'étape manuelle que ce générateur existe
 * pour supprimer. Ceux qui restent à `0` ne sont pas encore créés ; le test de
 * format (`scripts/test-gtm-container.mjs`) refuse en revanche toute valeur
 * dont la FORME ne correspond pas à sa plateforme — c'est lui qui attrape le
 * `AW-` collé dans l'identifiant de conversion, panne silencieuse s'il en est.
 */
const V_GA4_ID = variable(
  "CONST — GA4 Measurement ID",
  "c",
  [param.texte("value", "G-B066RRFQL5")],
  F_VARIABLES
);

/*
 * Sans le préfixe `AW-` : les balises `awct` et `sp` attendent le nombre seul,
 * et le préfixent elles-mêmes. Le coller avec `AW-` produit une balise qui
 * passe la validation de GTM et ne remonte jamais rien.
 */
const V_ADS_ID = variable(
  "CONST — Google Ads Conversion ID",
  "c",
  [param.texte("value", "18402972391")],
  F_VARIABLES
);

const V_META_ID = variable(
  "CONST — Meta Pixel ID",
  "c",
  [param.texte("value", "000000000000000")],
  F_VARIABLES
);

/** Nom GTM d'une variable de couche de données. */
const nomDlv = (cle) => `DLV — ${cle}`;

for (const cle of VARIABLES_DATALAYER) {
  variable(
    nomDlv(cle),
    "v",
    [
      param.texte("name", cle),
      param.entier("dataLayerVersion", 2),
      // Aucune valeur par défaut : une variable vide est omise par GTM, là où
      // un défaut ferait apparaître des lignes « (not set) » dans tous les
      // rapports GA4 — la plupart de ces paramètres sont conditionnels par
      // nature (un appartement n'a pas de terrain).
      param.booleen("setDefaultValue", false),
    ],
    F_VARIABLES
  );
}

/*
 * LIBELLÉS DE CONVERSION GOOGLE ADS.
 *
 * Ils vivaient dans une table de correspondance indexée par `{{Event}}`, ce
 * qui supposait « un événement = une action de conversion ». L'hypothèse est
 * tombée le jour où deux actions Ads distinctes — « Contact - message » et
 * « Contact - partenariat » — ont été créées sur le MÊME événement
 * `contact_lead`, distinguées par le sujet du message. La table leur aurait
 * servi le même libellé, donc compté les candidatures de partenaires comme des
 * demandes de contact.
 *
 * Chaque balise porte donc son libellé, et les cinq tiennent côte à côte plus
 * bas — plus lisible qu'une table plus une indirection, et sans hypothèse
 * cachée sur la relation entre événements et actions.
 *
 * Les valeurs `LABEL_…` sont des gabarits : `scripts/test-gtm-container.mjs`
 * refuse qu'une balise ACTIVE en porte un. Une conversion qui tire avec un
 * libellé fantôme ne remonte rien, en silence.
 */
/**
 * Un libellé encore à l'état de gabarit met sa balise EN PAUSE, automatiquement.
 *
 * Une balise de conversion qui tire avec `LABEL_ESTIMATION` au lieu du vrai
 * libellé ne remonte rien, sans lever la moindre erreur — les campagnes
 * tournent, le budget part, et la colonne « Conversions » reste à zéro sans
 * qu'on sache pourquoi. La règle est donc mécanique plutôt que confiée à la
 * vigilance : pas de libellé, pas de balise active. Renseigner le libellé la
 * réveille, sans rien d'autre à penser.
 */
const libelleManquant = (libelle) => /^LABEL_/.test(libelle);

const LIBELLE_ESTIMATION = "LABEL_ESTIMATION";
const LIBELLE_CONTACT = "LABEL_CONTACT";
const LIBELLE_PARTENARIAT = "LABEL_PARTENARIAT";
const LIBELLE_PDF = "LABEL_PDF";
const LIBELLE_MICRO = "LABEL_MICRO";

/*
 * Données fournies par l'utilisateur — conversions améliorées (lot T3).
 *
 * Mode MANUEL et non automatique : le mode automatique demande à Google de
 * PARCOURIR LE DOM à la recherche de champs de formulaire, ce qui reviendrait
 * à lui laisser lire l'adresse e-mail en clair sur la page. Ici, le site
 * fournit des empreintes SHA-256 qu'il a calculées lui-même (cf. `embUserData`
 * dans `src/scripts/tracking.js`) : Google ne voit jamais la donnée d'origine.
 *
 * ⚠️ C'EST L'ENTITÉ DU CONTENEUR LA PLUS SUSCEPTIBLE DE DEMANDER UNE RETOUCHE
 * APRÈS L'IMPORT. Le nom exact des champs de ce type de variable n'est pas
 * documenté de façon vérifiable hors de l'interface. Si l'import la rend
 * incomplète, la reconstruire à la main prend deux minutes (mode « Manuel »,
 * puis les deux variables ci-dessous dans « E-mail » et « Téléphone ») — la
 * marche à suivre est dans `gtm/README.md`.
 */
const V_USER_DATA = variable(
  "UD — Données fournies par l'utilisateur",
  "gtud",
  [
    param.texte("mode", "MANUAL"),
    param.texte("email", ref(nomDlv("user_data.sha256_email_address"))),
    param.texte("phone_number", ref(nomDlv("user_data.sha256_phone_number"))),
  ],
  F_VARIABLES
);

/*
 * Variable de paramètres d'événement GA4 : c'est elle qui permet UNE SEULE
 * balise d'événement pour tout le site. Ajouter un paramètre au plan revient
 * à ajouter une ligne à `VARIABLES_DATALAYER`, pas à créer une balise.
 */
const V_PARAMS_GA4 = variable(
  "SETTINGS — Params communs",
  "gtes",
  [
    param.liste(
      "eventSettingsTable",
      PARAMS_GA4.map((cle) =>
        param.map([
          param.texte("parameter", cle),
          param.texte("parameterValue", ref(nomDlv(cle))),
        ])
      )
    ),
  ],
  F_VARIABLES
);

// ===========================================================================
// 6. DÉCLENCHEURS (§6.3)
// ===========================================================================

const D_INIT = declencheur("Initialisation — Toutes les pages", { type: "init" }, F_SOCLE);
const D_TOUTES_PAGES = declencheur("Toutes les pages", { type: "pageview" }, F_SOCLE);

/*
 * Déclencheur unique de la balise d'événement GA4.
 *
 * L'ANCRAGE `^` ET LES `$` NE SONT PAS DÉCORATIFS : sans eux, les événements
 * internes de GTM (`gtm.js`, `gtm.dom`, `gtm.load`, `gtm.click`) passeraient
 * le filtre et rempliraient la propriété d'événements qui ne veulent rien dire.
 */
const REGEX_EVENEMENTS_METIER =
  "^(estimation_|generate_lead$|contact_lead$|report_|partner_click_out$|cta_click$|sticky_cta_dismiss$|consent_update$)";

const D_TOUS_EVENEMENTS = declencheur(
  "CE — Tous événements métier",
  {
    type: "customEvent",
    customEventFilter: [filtreEvenement("MATCH_REGEX", REGEX_EVENEMENTS_METIER)],
  },
  F_GA4
);

const D_GENERATE_LEAD = declencheur(
  "CE — generate_lead",
  {
    type: "customEvent",
    customEventFilter: [filtreEvenement("EQUALS", "generate_lead")],
  },
  F_SOCLE
);

const D_REPORT_VIEW = declencheur(
  "CE — report_view",
  {
    type: "customEvent",
    customEventFilter: [filtreEvenement("EQUALS", "report_view")],
  },
  F_SOCLE
);

/*
 * Deux déclencheurs pour un même événement, séparés par le sujet du message.
 * Une candidature de partenaire est un lead B2B : la compter avec les demandes
 * d'estimation apprendrait aux enchères à acheter du trafic de professionnels
 * avec le budget destiné aux propriétaires vendeurs (cf. `embContactValue`).
 */
const D_CONTACT_HORS_PARTENARIAT = declencheur(
  "CE — contact_lead (hors partenariat)",
  {
    type: "customEvent",
    customEventFilter: [filtreEvenement("EQUALS", "contact_lead")],
    filter: [
      filtreVariable("EQUALS", ref(nomDlv("contact_subject")), "partenariat", true),
    ],
  },
  F_SOCLE
);

const D_CONTACT_PARTENARIAT = declencheur(
  "CE — contact_lead (partenariat)",
  {
    type: "customEvent",
    customEventFilter: [filtreEvenement("EQUALS", "contact_lead")],
    filter: [filtreVariable("EQUALS", ref(nomDlv("contact_subject")), "partenariat")],
  },
  F_SOCLE
);

const D_PDF = declencheur(
  "CE — report_pdf_download",
  {
    type: "customEvent",
    customEventFilter: [filtreEvenement("EQUALS", "report_pdf_download")],
  },
  F_SOCLE
);

/*
 * Micro-conversion : « a rempli l'adresse, le type de bien, et arrive aux
 * caractéristiques ». Au démarrage, une campagne qui reçoit moins d'une
 * trentaine de conversions par mois ne sort jamais de sa phase
 * d'apprentissage ; ce signal à fort volume nourrit les enchères le temps que
 * les vrais leads s'accumulent. `step_direction = forward` exclut les
 * allers-retours dans le formulaire, qui compteraient plusieurs fois le même
 * visiteur.
 */
const D_MICRO_ETAPE_3 = declencheur(
  "CE — micro : étape 3 atteinte",
  {
    type: "customEvent",
    customEventFilter: [filtreEvenement("EQUALS", "estimation_step_view")],
    filter: [
      filtreVariable("EQUALS", ref(nomDlv("step_number")), "3"),
      filtreVariable("EQUALS", ref(nomDlv("step_direction")), "forward"),
    ],
  },
  F_SOCLE
);

// ===========================================================================
// 7. RÉGLAGES DE CONSENTEMENT (§6.4)
// ===========================================================================

/*
 * Les balises Google lisent le Consent Mode nativement : rien à déclarer.
 *
 * Les balises tierces, NON. Le Consent Mode est un mécanisme Google — une
 * balise HTML personnalisée s'exécute sans lui demander son avis si on ne
 * coche rien, et le pixel se chargerait alors chez un visiteur qui a refusé.
 * C'est le manquement à l'article 82 que ce bloc empêche.
 */
const CONSENTEMENT_NATIF = { consentStatus: "NOT_SET" };

const CONSENTEMENT_PUBLICITE = {
  consentStatus: "NEEDED",
  consentType: {
    type: "LIST",
    list: [
      { type: "TEMPLATE", value: "ad_storage" },
      { type: "TEMPLATE", value: "ad_user_data" },
      { type: "TEMPLATE", value: "ad_personalization" },
    ],
  },
};

// ===========================================================================
// 8. BALISES (§6.5)
// ===========================================================================

balise(
  "GA4 — Configuration",
  "googtag",
  [
    param.texte("tagId", ref(V_GA4_ID)),
    param.liste("configSettingsTable", [
      param.map([
        param.texte("parameter", "cookie_expires"),
        param.texte("parameterValue", String(DUREE_COOKIE_GA4_SECONDES)),
      ]),
    ]),
  ],
  { declencheurs: [D_INIT], dossier: F_GA4, consentement: CONSENTEMENT_NATIF }
);

/*
 * UNE SEULE balise d'événement GA4, et non une par événement : le nom vient de
 * `{{Event}}`, les paramètres de la variable partagée. Quinze balises seraient
 * quinze copies du même objet, à corriger quinze fois.
 */
balise(
  "GA4 — Événement générique",
  "gaawe",
  [
    param.texte("eventName", ref("Event")),
    param.texte("measurementIdOverride", ref(V_GA4_ID)),
    param.texte("eventSettingsVariable", ref(V_PARAMS_GA4)),
    param.booleen("sendEcommerceData", false),
  ],
  { declencheurs: [D_TOUS_EVENEMENTS], dossier: F_GA4, consentement: CONSENTEMENT_NATIF }
);

/*
 * Balise Google de Google Ads (`AW-…`).
 *
 * Les cinq balises de conversion `awct` fonctionnent sans elle : elles portent
 * l'identifiant et le libellé, et c'est un montage supporté de longue date.
 * Elle est ajoutée pour deux raisons concrètes :
 *
 *   - c'est le socle attendu par Google aujourd'hui, et son absence fait
 *     souvent rester le diagnostic Ads en « balise inactive » — un voyant rouge
 *     permanent derrière lequel une vraie panne finit par passer inaperçue ;
 *   - elle fiabilise la pose des cookies propriétaires de Google Ads, dont
 *     dépendent l'attribution et les conversions améliorées.
 *
 * Une balise par identifiant : GA4 (`G-…`) et Ads (`AW-…`) ne se cumulent pas
 * dans un même `googtag`. Aucune des deux ne compte de conversion — ce sont des
 * balises de configuration, pas de mesure.
 */
// `AW-` + la constante : c'est la balise Google qui veut le préfixe, alors que
// les balises de conversion veulent le nombre seul. Un seul endroit porte la
// valeur, chacun la préfixe comme il en a besoin.
balise("Ads — Configuration", "googtag", [param.texte("tagId", "AW-" + ref(V_ADS_ID))], {
  declencheurs: [D_INIT],
  dossier: F_ADS,
  consentement: CONSENTEMENT_NATIF,
});

/*
 * Conversion Linker.
 *
 * Redondant avec la balise Google ci-dessus, qui assure désormais la même
 * capture du `gclid`. On le garde comme repli : il se déclenche sur toutes les
 * pages, là où la balise Google dépend de l'initialisation, et il coûte
 * quelques octets. Le supprimer serait un nettoyage à part entière, à faire
 * une fois le diagnostic Ads au vert — pas au moment de la première mise en
 * service, où l'on veut le maximum de filets.
 */
balise("Ads — Conversion Linker", "gclidw", [param.booleen("enableCrossDomain", false)], {
  declencheurs: [D_TOUTES_PAGES],
  dossier: F_ADS,
  consentement: CONSENTEMENT_NATIF,
});

/**
 * Balise de conversion Google Ads.
 *
 * `orderId` porte le `lead_id` : c'est le dédoublonnage de dernier recours,
 * celui qui tient quand le verrou local de `/rapport/` saute (Safari en
 * navigation privée). Associé au comptage « une seule » réglé côté Ads, il
 * garantit qu'un rechargement de la page de rapport ne facture pas deux
 * conversions.
 */
function conversionAds(nom, declencheurId, valeur, libelle, options) {
  const opts = options || {};

  balise(
    nom,
    "awct",
    [
      param.texte("conversionId", ref(V_ADS_ID)),
      param.texte("conversionLabel", libelle),
      param.texte("conversionValue", valeur),
      param.texte("currencyCode", "EUR"),
      param.texte("orderId", ref(nomDlv("lead_id"))),
      param.booleen("enableConversionLinker", true),
      /*
       * Conversions améliorées activées UNIQUEMENT là où le site fournit
       * réellement des empreintes de contact — c'est-à-dire sur les deux
       * conversions qui naissent d'un formulaire.
       *
       * Les activer sur le téléchargement de PDF ou la micro-conversion
       * d'étape 3 enverrait des champs vides et laisserait un diagnostic en
       * erreur permanent dans Google Ads : un voyant rouge qu'on finit par ne
       * plus regarder, et derrière lequel une vraie panne passerait inaperçue.
       */
      param.booleen("enableEnhancedConversions", Boolean(opts.conversionsAmeliorees)),
      ...(opts.conversionsAmeliorees
        ? [param.texte("userDataVariable", ref(V_USER_DATA))]
        : []),
    ],
    {
      declencheurs: [declencheurId],
      dossier: F_ADS,
      consentement: CONSENTEMENT_NATIF,
      // Reportée par décision, OU pas encore utilisable faute de libellé.
      enPause: Boolean(opts.enPause) || libelleManquant(libelle),
    }
  );
}

conversionAds(
  "Ads — Conversion : estimation",
  D_GENERATE_LEAD,
  ref(nomDlv("value")),
  LIBELLE_ESTIMATION,
  { conversionsAmeliorees: true }
);

conversionAds(
  "Ads — Conversion : contact",
  D_CONTACT_HORS_PARTENARIAT,
  ref(nomDlv("value")),
  LIBELLE_CONTACT,
  { conversionsAmeliorees: true }
);

/*
 * Action Ads DISTINCTE de « Contact - message », bien que déclenchée par le
 * même événement `contact_lead` : c'est le sujet du message qui les sépare.
 * D'où un libellé propre — et la raison pour laquelle la table de
 * correspondance par événement a été retirée (voir plus haut).
 *
 * Valeur à 0 : lead B2B, autre budget. Lui en donner une apprendrait aux
 * enchères à acheter du trafic de professionnels avec l'argent destiné aux
 * propriétaires vendeurs. L'action est réglée en « secondaire » côté Ads, donc
 * hors de la colonne « Conversions ».
 */
conversionAds(
  "Ads — Conversion : partenariat",
  D_CONTACT_PARTENARIAT,
  "0",
  LIBELLE_PARTENARIAT
);

/*
 * EN PAUSE — les actions correspondantes n'existent pas encore côté Google Ads
 * (décision du 21/08/2026 : on démarre avec les trois conversions issues d'un
 * formulaire).
 *
 * En pause plutôt que supprimées : la configuration reste lisible et sa remise
 * en service ne demandera qu'un drapeau, un libellé, et un ré-import. Les
 * laisser ACTIVES aurait été le pire choix — elles tireraient avec un libellé
 * fantôme, ne remonteraient rien, et rempliraient le diagnostic Ads d'erreurs
 * derrière lesquelles une vraie panne se serait cachée.
 *
 * Rappel de ce qu'on se prive en attendant : la micro-conversion d'étape 3 est
 * le signal à fort volume qui aide les enchères à sortir de leur phase
 * d'apprentissage tant que les vrais leads sont rares (plan §6.3).
 */
conversionAds("Ads — Conversion : PDF", D_PDF, "0", LIBELLE_PDF, { enPause: true });
conversionAds("Ads — Conversion : micro étape 3", D_MICRO_ETAPE_3, "0", LIBELLE_MICRO, {
  enPause: true,
});

balise(
  "Ads — Remarketing",
  "sp",
  [
    param.texte("conversionId", ref(V_ADS_ID)),
    param.booleen("enableDynamicRemarketing", false),
  ],
  { declencheurs: [D_TOUTES_PAGES], dossier: F_ADS, consentement: CONSENTEMENT_NATIF }
);

// --------------------------------------------------------------------------
// Meta
// --------------------------------------------------------------------------

const PIXEL_META_BASE = `<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', ${JSON.stringify(ref(V_META_ID))});
fbq('track', 'PageView');
</script>`;

/*
 * Pas d'iframe `<noscript>`, pour la même raison qu'elle est absente du
 * conteneur GTM lui-même (cf. `src/components/Analytics.astro`) : sans
 * JavaScript, le bandeau ne peut pas s'afficher, donc aucun consentement ne
 * peut être recueilli — ce serait le seul traceur du site à partir sans qu'un
 * refus soit possible.
 */
balise("Meta — Pixel de base", "html", [
  param.texte("html", PIXEL_META_BASE),
  param.booleen("supportDocumentWrite", false),
], {
  declencheurs: [D_TOUTES_PAGES],
  dossier: F_META,
  consentement: CONSENTEMENT_PUBLICITE,
});

/**
 * Événement Meta.
 *
 * `eventID` porte le `lead_id` : c'est lui qui permettra la déduplication le
 * jour où la Conversions API (envoi serveur, lot T4) doublera le pixel. Sans
 * lui, chaque conversion serait comptée deux fois par Meta — et l'oublier
 * maintenant obligerait à reprendre l'historique plus tard.
 */
function evenementMeta(nom, evenementFbq, declencheurId, avecValeur) {
  const donnees = avecValeur
    ? `{value: ${JSON.stringify(ref(nomDlv("value")))}, currency: 'EUR'}`
    : `{content_name: 'rapport'}`;

  balise(
    nom,
    "html",
    [
      param.texte(
        "html",
        `<script>
fbq('track', ${JSON.stringify(evenementFbq)}, ${donnees}, {eventID: ${JSON.stringify(
          ref(nomDlv("lead_id"))
        )}});
</script>`
      ),
      param.booleen("supportDocumentWrite", false),
    ],
    {
      declencheurs: [declencheurId],
      dossier: F_META,
      consentement: CONSENTEMENT_PUBLICITE,
      // Séquencement : `fbq` n'existe pas tant que le pixel de base n'a pas
      // tourné. Sur une arrivée directe sur `/rapport/`, l'événement de
      // conversion et le chargement du pixel se disputent la même
      // milliseconde ; sans cette dépendance déclarée, la conversion part
      // parfois dans le vide, et seulement parfois — le pire des défauts.
      setupTag: [{ tagName: "Meta — Pixel de base", stopOnSetupFailure: true }],
    }
  );
}

evenementMeta("Meta — Lead", "Lead", D_GENERATE_LEAD, true);
evenementMeta("Meta — Contact", "Contact", D_CONTACT_HORS_PARTENARIAT, true);
evenementMeta("Meta — ViewContent", "ViewContent", D_REPORT_VIEW, false);

// ===========================================================================
// 9. ASSEMBLAGE
// ===========================================================================

const conteneur = {
  exportFormatVersion: 2,
  // Pas d'horodatage : il changerait à chaque exécution et rendrait le
  // fichier généré incomparable d'un commit à l'autre. Le journal de bord de
  // cette configuration, c'est git.
  exportTime: "",
  containerVersion: {
    path: "accounts/0/containers/0/versions/0",
    ...ZERO,
    containerVersionId: "0",
    name: "Plan de taggage — conversions",
    description:
      "Généré par scripts/build-gtm-container.mjs. Source de vérité : specs/plan-taggage-conversions.md. Ne pas modifier à la main dans l'interface GTM sans reporter le changement dans le générateur.",
    container: {
      path: "accounts/0/containers/0",
      ...ZERO,
      name: "estimer.co",
      publicId: CONTENEUR_PUBLIC_ID,
      usageContext: ["WEB"],
      fingerprint: "0",
    },
    builtInVariable: VARIABLES_INTEGREES.map(([type, name]) => ({
      ...ZERO,
      type,
      name,
    })),
    variable: variables,
    trigger: declencheurs,
    tag: balises,
    folder: dossiers,
    fingerprint: "0",
  },
};

/** Sérialisation canonique : c'est elle que la CI compare au fichier committé. */
export const JSON_CONTENEUR = JSON.stringify(conteneur, null, 2) + "\n";

/*
 * L'écriture n'a lieu QUE si ce fichier est exécuté directement.
 * `scripts/test-gtm-container.mjs` l'importe pour comparer sa sortie au JSON
 * committé : s'il écrivait à l'import, le test réparerait silencieusement la
 * divergence qu'il est censé signaler, et ne pourrait jamais échouer.
 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(SORTIE, JSON_CONTENEUR, "utf8");
  console.log(
    `gtm/container-estimer-co.json écrit : ${variables.length} variables, ` +
      `${declencheurs.length} déclencheurs, ${balises.length} balises, ` +
      `${dossiers.length} dossiers.`
  );
}

export { conteneur, SORTIE };
