# Plan de taggage et de conversions — estimer.co

> Cadrage complet du dispositif de mesure, en prévision de l'ouverture des
> campagnes **Google Ads** et **Meta Ads**. Objet : disposer, dans le conteneur
> **GTM-5TB8F4CS**, de tous les événements et de toutes les conversions
> nécessaires au pilotage des campagnes — sans rien mesurer que la politique de
> confidentialité n'annonce déjà, et sans rien envoyer avant consentement.
>
> Ce document est la **source de vérité** du taggage. Toute balise créée dans
> GTM sans figurer ici est un écart à corriger ou à documenter ici.

---

## 1. Ce qui existe déjà, et ce qui manque

### Acquis (rien à refaire)

| Brique | État | Fichier |
|---|---|---|
| Conteneur GTM | `GTM-5TB8F4CS`, chargé dès l'arrivée | `src/components/Analytics.astro` |
| Consent Mode v2, implémentation **Advanced** | Tous les signaux à `denied` par défaut, `wait_for_update: 500` | `Analytics.astro:57` |
| `ads_data_redaction` + `url_passthrough` | Actifs | `Analytics.astro:72-78` |
| Bandeau CNIL (refus au même poids qu'accepter, pas de cookie wall, retrait facile) | En place, 3 catégories : `necessary` / `analytics` / `ads` | `src/components/ConsentBanner.astro` |
| Remontée du consentement dans le dataLayer | Événement `consent_update` | `ConsentBanner.astro:157` |
| Socle de mesure (lot T0, livré) | `embTrack` + helpers + délégation des clics | `src/scripts/tracking.js`, `src/components/Tracking.astro` |
| Interrupteur général unique | `PUBLIC_GTM_CONTAINER_ID` vide ⇒ zéro script Google, zéro bandeau | `src/lib/analytics.ts` |
| Politique de confidentialité alignée | Annonce déjà GA4, Google Ads, Meta Ads, et la transmission serveur d'événements de conversion | `src/pages/politique-de-confidentialite.astro:406,462` |

| Instrumentation du parcours (lot T1, livré) | Tunnel, `generate_lead`, `contact_lead`, modèle de valeur | `estimation-ui.js`, `rapport-report.js`, `contact.js` |

### Manquant

**Le site parle, personne n'écoute encore.** Le dataLayer porte désormais tous
les événements du §4, mais rien n'est configuré côté plateformes :

- aucune balise GA4 (ni configuration, ni événement) ;
- aucune conversion Google Ads ;
- aucun pixel Meta ;
- aucune dimension personnalisée déclarée dans GA4 (§9.4) — sans elles, les
  paramètres sont collectés mais restent invisibles dans les rapports.

C'est l'objet du lot T2 (§11), et c'est ce qui reste entre l'état actuel et
l'ouverture des campagnes.

---

## 2. Les huit décisions structurantes

Chacune conditionne le reste du document. Les revisiter, c'est revisiter le plan.

### 2.1 Le dataLayer est le seul contrat entre le site et GTM

Aucune balise ne devra dépendre d'un sélecteur CSS, d'un texte de bouton ou
d'une structure HTML. Toutes les données de conversion sont **poussées
explicitement** par le code, sous des noms stables. Un refactoring de la page
d'estimation ne doit jamais casser silencieusement une conversion Ads — ce qui
est exactement ce qui arrive avec des déclencheurs « Clic – tous les éléments +
Classes CSS contient `btn--primary` ».

### 2.2 Noms d'événements en anglais, `snake_case`

À rebours du reste du code (français), et pour une raison précise : les noms
GA4 **réservés et recommandés** sont anglais (`page_view`, `generate_lead`,
`view_item`). Utiliser `demande_estimation` au lieu de `generate_lead` prive la
propriété des rapports intégrés et du mapping automatique vers les
plateformes publicitaires. Un dictionnaire mi-français mi-anglais serait pire
que l'un ou l'autre.

**Conséquence** : `consentement_maj` a été renommé `consent_update`
(`ConsentBanner.astro:158`), ses deux clés en `consent_analytics` /
`consent_ads`. Aucune balise ne le consommait encore ; le coût était d'une
ligne, et c'était maintenant ou jamais.

### 2.3 La conversion principale se déclenche sur `/rapport/`, pas sur le clic « Envoyer »

**C'est le point technique le plus important du plan.**

`finalizeSubmit()` (`src/scripts/estimation-ui.js:979`) enchaîne, de façon
synchrone : envoi du lead (non bloquant) → persistance → `window.location.href
= "/rapport/"`. Un `dataLayer.push` inséré juste avant cette ligne serait une
**course** : GTM peut n'avoir pas encore instancié ses balises quand la
navigation démarre. On perdrait une part non mesurable des conversions — et
c'est le pire des défauts, parce qu'il est invisible et qu'il fausse le CPA de
toutes les campagnes.

La conversion est donc émise **au chargement de `/rapport/`**, qui est la vraie
page de confirmation du parcours, en relisant `localStorage.lastEstimation`.
C'est le motif classique « page de remerciement », et il est ici gratuit
puisque la redirection existe déjà.

Contrepartie à gérer : `/rapport/` est réatteignable (rechargement, retour
arrière via bfcache — cf. `estimation-ui.js:1108`, bouton « Réessayer » de
`rapport-report.js:874`) et affiche même un `lastEstimation` ancien à un
visiteur de retour. D'où le garde-fou du §2.4.

### 2.4 Un `lead_id` client, émis au moment de la soumission

Un UUID v4 est généré dans `handleSubmit()`, écrit dans le payload persisté, et
sert de :

- clé d'idempotence du tag de conversion (`transaction_id` Google Ads,
  `eventID` Meta) : une conversion, un identifiant, quelle que soit la
  plateforme et quel que soit le canal (navigateur ou serveur) ;
- verrou anti-double-comptage : `/rapport/` marque `emb.lead.<id>.tracked` dans
  `localStorage` et ne réémet jamais pour le même identifiant.

L'API ne renvoie pas d'identifiant exploitable ici : sa `reference`
(`api/app/controllers/leads_controller.ts:68`) arrive de façon asynchrone,
**après** la redirection. Elle ne peut donc pas jouer ce rôle.

### 2.5 Conversions Google Ads en balise directe, pas en import GA4

Deux voies existent pour remonter une conversion à Google Ads : importer un
événement GA4, ou poser une balise « Suivi des conversions Google Ads » dans
GTM. On retient la **balise directe** :

- latence bien plus faible (l'import GA4 ajoute plusieurs heures, ce qui
  dégrade l'apprentissage des enchères automatiques) ;
- les **conversions améliorées** (§7.3) s'y configurent directement ;
- la fenêtre d'attribution et le mode de comptage se règlent conversion par
  conversion.

**Règle absolue qui en découle** : ne **jamais** importer en plus le même
événement depuis GA4. Le double comptage est le premier défaut de tout compte
Ads mal câblé, et il fait diviser par deux le CPA affiché.

### 2.6 Aucune donnée personnelle en clair dans le dataLayer

Interdits, sans exception : `address` (la voie), `name`, `email`, `phone`,
`message`. Autorisés parce que non identifiants et utiles au pilotage :
`postalCode`, `city`, `departement_code`, `region`.

Pour les conversions améliorées, l'e-mail et le téléphone sont **hachés en
SHA-256 côté client** (Web Crypto, normalisation Google : minuscules, `trim`,
téléphone en E.164) avant d'être poussés. Google accepte le pré-haché. On évite
ainsi qu'une donnée de contact en clair transite par un dataLayer lisible par
toute extension installée dans le navigateur du visiteur.

### 2.7 Le consentement pilote, GTM n'y déroge pas

Chaque balise porte des **réglages de consentement supplémentaires** explicites
(§6.4). Les balises Google (GA4, Ads) respectent nativement le Consent Mode ;
les balises tierces (Meta) doivent être **bloquées** tant que `ad_storage`,
`ad_user_data` et `ad_personalization` ne sont pas `granted` — le Consent Mode
ne les protège pas tout seul.

### 2.8 On mesure d'abord, on optimise à la valeur ensuite

Les campagnes démarrent en **tCPA** (ou maximiser les conversions), pas en
tROAS. La valeur monétaire est envoyée dès le premier jour **en observation**
(§5), pour constituer l'historique. La bascule vers des enchères à la valeur
n'intervient qu'une fois ~30 conversions/mois atteintes et le modèle de valeur
arbitré par le métier. Changer l'échelle de valeur en cours de campagne
réinitialise l'apprentissage : autant ne le faire qu'une fois.

---

## 3. Le parcours et ses points de mesure

```
                 ┌──────────────────────────────────────────────┐
   Annonce  ───► │ /  (accueil)                                 │
                 │   · formulaire adresse du hero               │ cta_click
                 │   · CTA header / sticky / sections           │ cta_click
                 └───────────────────┬──────────────────────────┘
                                     │
                 ┌───────────────────▼──────────────────────────┐
                 │ /estimation  — tunnel 5 étapes               │ estimation_start
                 │   1 Adresse ──────────────────────────────►  │ estimation_address_selected
                 │   2 Type de bien                             │ estimation_step_view ×5
                 │   3 Caractéristiques & DPE                   │ estimation_step_error
                 │   4 Situation (propriétaire / vendre ?)      │
                 │   5 Coordonnées ──────► « Obtenir »          │ estimation_submit
                 └───────────────────┬──────────────────────────┘
                                     │  POST /v1/estimations         estimation_api_result
                                     │  POST /v1/leads               estimation_failed
                                     ▼  redirection
                 ┌──────────────────────────────────────────────┐
                 │ /rapport/                                    │ ★ generate_lead  (CONVERSION)
                 │   · rapport affiché                          │ report_view
                 │   · téléchargement PDF                       │ report_pdf_download
                 │   · « Contacter un expert »                  │ cta_click
                 └──────────────────────────────────────────────┘

   Parcours parallèles :
     /contact       formulaire ──────────────────────────────►  ★ contact_lead (CONVERSION)
     /partenaires   lien sortant ─────────────────────────────►  partner_click_out
     /carte         exploration ─────────────────────────────►  cta_click
```

**Trois conversions distinctes**, à ne pas confondre dans Ads :

| # | Conversion | Où | Nature |
|---|---|---|---|
| 1 | Demande d'estimation | `/rapport/` | **Principale** — c'est le lead vendeur |
| 2 | Message de contact (hors partenariat) | `/contact` | Principale secondaire |
| 3 | Candidature partenaire | `/contact`, sujet = `partenariat` | Observation (B2B, autre budget) |

---

## 4. Dictionnaire des événements dataLayer

Convention de lecture : **`—`** = paramètre absent (jamais poussé vide ; GTM
ignore les paramètres `undefined`, ce qui garde les rapports propres).

### 4.1 Socle

| Événement | Déclenchement | Paramètres |
|---|---|---|
| `consent_update` | Choix du visiteur (premier choix, choix mémorisé retrouvé, ou modification) | `consent_analytics` (`granted`/`denied`), `consent_ads` |
| *(page_view)* | **Non poussé** — assuré par la balise de configuration GA4 | — |

### 4.2 Tunnel d'estimation

| Événement | Déclenchement | Paramètres |
|---|---|---|
| `estimation_start` | Première étape rendue sur `/estimation` (une fois par parcours) | `entry_point` (`home_hero`\|`cta`\|`direct`\|`restored`), `has_address_prefill` (bool) |
| `estimation_step_view` | Chaque changement d'étape affichée (avant ET arrière) | `step_number` (1-5), `step_key` (`address`\|`property`\|`characteristics`\|`situation`\|`contact`), `step_direction` (`forward`\|`backward`\|`restore`) |
| `estimation_step_error` | La validation bloque le passage à l'étape suivante | `step_number`, `step_key`, `error_fields` (noms joints par `\|`), `error_count` |
| `estimation_address_selected` | Adresse validée à l'étape 1 | `address_source` (`autocomplete`\|`manual`), `postal_code`, `city`, `departement_code` |
| `estimation_submit` | Clic « Obtenir mon estimation », **après** validation, avant l'appel API | `lead_id`, `property_type`, `surface_bucket`, `rooms`, `dpe`, `postal_code`, `departement_code`, `is_owner`, `want_to_sell`, `lead_quality` |
| `estimation_api_result` | Réponse de `POST /v1/estimations` | `lead_id`, `estimation_status` (`ok`\|`static-fallback`\|`deferred`), `confidence_score`, `comparables_count`, `latency_ms` |
| `estimation_failed` | 422 / 429 / exception — le visiteur reste sur le formulaire | `lead_id`, `failure_type` (`validation`\|`rate_limited`\|`unexpected`), `http_status` |

> **Pourquoi `estimation_step_view` et pas `estimation_step_completed`** — la
> vue de l'étape N+1 *est* la complétion de l'étape N. Un second événement
> décrirait le même fait, doublerait le volume et créerait deux entonnoirs
> susceptibles de diverger. `estimation_step_error` suffit à diagnostiquer la
> friction.

### 4.3 Conversions

| Événement | Déclenchement | Paramètres |
|---|---|---|
| `generate_lead` | Chargement de `/rapport/` avec un `lastEstimation` **non encore tracké** | `lead_id`, `lead_type` = `estimation`, `value`, `currency` = `EUR`, `lead_quality`, `property_type`, `surface_bucket`, `rooms`, `dpe`, `postal_code`, `departement_code`, `estimation_value`, `estimation_status`, `is_owner`, `want_to_sell`, `user_data` (§7.3) |
| `contact_lead` | Succès de `POST /v1/leads` (ou du repli EmailJS) sur `/contact` | `lead_id`, `lead_type` = `contact`, `contact_subject` (`estimation`\|`partenariat`\|`information`\|`autre`), `value`, `currency` = `EUR`, `user_data` |

> `generate_lead` est un **nom recommandé GA4** : il alimente les rapports
> « Génération de leads » sans configuration.

> **`region` n'est pas envoyé**, contrairement à ce que prévoyait la première
> version de ce plan. Le navigateur ne dispose d'aucune correspondance
> département → région : `regionParente` vit dans les collections de contenu,
> qui ne sont pas importables depuis un script client. Le paramètre arrivera
> avec le lot 2 de `specs/cms-seo-tracking.md`, qui sérialise déjà ces données
> en JSON pour `/carte`. En attendant, `departement_code` couvre l'essentiel du
> besoin de pilotage géographique.

### 4.4 Engagement et signaux de qualité

| Événement | Déclenchement | Paramètres |
|---|---|---|
| `report_view` | `/rapport/` affiché avec une estimation exploitable | `lead_id`, `estimation_status` |
| `report_pdf_download` | Clic sur « Télécharger mon rapport PDF » (`rapport.astro:152`) | `lead_id`, `estimation_status` |
| `partner_click_out` | Clic sur un lien partenaire sortant | `partner_slug`, `partner_name`, `partner_category`, `page_type` (`partenaires_index`\|`partenaire_detail`\|`region`\|`departement`\|`page_libre`), `page_path`, `link_url`, `position` |
| `cta_click` | Clic sur tout élément portant `data-cta` | `cta_id` (cf. table ci-dessous), `cta_label`, `cta_destination`, `page_path` |
| `sticky_cta_dismiss` | Fermeture de la barre collée | `page_path` |

**Valeurs de `cta_id` posées dans les pages** (un identifiant par emplacement,
jamais par libellé — deux boutons au même texte à deux endroits différents sont
deux questions différentes) :

| `cta_id` | Emplacement |
|---|---|
| `announce` | Bandeau d'annonce du haut de page (`Header.astro`) |
| `header` | CTA d'en-tête, affichage bureau |
| `header_nav` | CTA d'en-tête, menu mobile |
| `hero_form` | Bouton du formulaire d'adresse de l'accueil |
| `section_final_estimation` / `section_final_contact` | Double CTA de fin d'accueil |
| `faq_contact` | « Écrivez-nous » sous la FAQ |
| `sticky` | Barre collée en bas de fenêtre |
| `carte` | CTA de fin de `/carte` |
| `partenaires_contact` / `partenaires_parcours` | Double CTA de fin de `/partenaires` |
| `rapport_expert` / `rapport_nouvelle` | Actions de fin de rapport |

> **Pas d'événement `report_cta_click` distinct** : il décrirait le même fait
> qu'un `cta_click` filtré sur `cta_id` commençant par `rapport_`, en coûtant un
> nom d'événement de plus et un entonnoir de plus à tenir à jour. Un seul
> événement, une dimension pour le qualifier.

> `partner_click_out` reprend **à l'identique** le contrat déjà arbitré dans
> `specs/cms-seo-tracking.md` §6. Ne pas le renommer : la question « nom à
> valider par le marketing » qui y figure est tranchée ici — on garde.

### 4.5 Non retenus, et pourquoi

- **`phone_click` / `email_click`** — aucun lien `tel:` ni `mailto:` n'existe
  aujourd'hui hors pages légales et bandeau. À câbler *le jour où* un numéro
  est publié, pas avant : une balise sans déclencheur possible est une dette.
- **Interactions de formulaire (mesure améliorée GA4)** — à **désactiver** :
  le tunnel est un formulaire unique à 5 panneaux, `form_start`/`form_submit`
  y produiraient un bruit ininterprétable qui concurrencerait notre entonnoir.
- **Clics sortants (mesure améliorée GA4)** — à **laisser activés** : ils
  produisent des événements `click`, jamais des conversions. Le reporting
  partenaires s'appuie sur `partner_click_out`, jamais sur `click`.
- **`view_item` / `add_to_cart`** — le vocabulaire e-commerce ne décrit pas ce
  parcours ; le détourner rendrait les rapports intégrés faux plutôt qu'utiles.

---

## 5. Modèle de valeur des conversions

Envoyer `value: 1` partout revient à dire à Smart Bidding que tous les leads se
valent. Ils ne se valent pas : un propriétaire qui déclare vouloir vendre un
bien à 600 000 € n'a pas la valeur d'un curieux locataire.

### 5.1 Qualification du lead (`lead_quality`)

Dérivée des deux champs de l'étape 4, déjà collectés
(`estimation-wizard.js` — `isOwner`, `wantToSell`) :

| `is_owner` | `want_to_sell` | `lead_quality` | Coefficient |
|---|---|---|---|
| `yes` | `yes` | `hot` | **3,0** |
| `yes` | `maybe` | `warm` | **1,5** |
| `yes` | `no` | `cold` | **0,5** |
| `no` | *(toute valeur)* | `cold` | **0,2** |

### 5.2 Formule

```
value = VALEUR_BASE_LEAD × coefficient_qualité × coefficient_bien
```

avec `coefficient_bien = min(2,5 ; estimation_value / 250 000)`, borné à 2,5
pour qu'un bien exceptionnel ne fasse pas dérailler l'apprentissage à lui seul,
et `coefficient_bien = 1` si l'estimation n'a pas abouti
(`estimation_status ≠ ok`).

`VALEUR_BASE_LEAD` est **à arbitrer par le métier**, et c'est la seule inconnue
du modèle. Deux façons de la fixer :

- **A — Leads revendus à prix fixe** (le plus probable ici) :
  `VALEUR_BASE_LEAD` = prix de cession d'un lead à un partenaire. Directement
  observable, aucune modélisation.
- **B — Rémunération sur honoraires** :
  `VALEUR_BASE_LEAD = prix_moyen_bien × taux_honoraires × taux(lead→mandat) ×
  taux(mandat→vente)`. Exemple d'ordre de grandeur, **à ne pas reprendre tel
  quel** : 250 000 × 4 % × 5 % × 70 % ≈ **350 €**.

En attendant l'arbitrage, poser `VALEUR_BASE_LEAD = 100` : l'échelle relative
entre leads est correcte, ce qui est tout ce dont Smart Bidding a besoin en
phase d'observation. `contact_lead` : `50` hors partenariat, `0` pour
`partenariat` (conversion d'observation, non comptée).

> ⚠️ La valeur envoyée doit rester **cohérente dans le temps**. Un changement
> d'échelle en cours de campagne relance l'apprentissage à zéro. Décider avant
> d'ouvrir les budgets.

---

## 6. Configuration Google Tag Manager (conteneur `GTM-5TB8F4CS`)

### 6.1 Variables intégrées à activer

`Page URL`, `Page Path`, `Page Hostname`, `Referrer`, `Event`, `Click Element`,
`Click Classes`, `Click URL`, `Click Text`.

### 6.2 Variables définies par l'utilisateur

**Constantes**

| Nom | Type | Valeur |
|---|---|---|
| `CONST — GA4 Measurement ID` | Constante | `G-XXXXXXXXXX` |
| `CONST — Google Ads Conversion ID` | Constante | `AW-XXXXXXXXXX` |
| `CONST — Meta Pixel ID` | Constante | `XXXXXXXXXXXXXXX` |

**Variables de couche de données** (toutes en *Version 2*, valeur par défaut
laissée **vide** — pas `undefined`, pas `(not set)`)

`lead_id`, `lead_type`, `lead_quality`, `value`, `currency`, `property_type`,
`surface_bucket`, `rooms`, `dpe`, `postal_code`, `departement_code`, `region`,
`estimation_value`, `estimation_status`, `is_owner`, `want_to_sell`,
`confidence_score`, `comparables_count`, `latency_ms`, `failure_type`,
`http_status`, `step_number`, `step_key`, `step_direction`, `error_fields`,
`error_count`, `address_source`, `city`, `entry_point`, `has_address_prefill`,
`cta_id`, `cta_label`, `cta_destination`, `contact_subject`, `partner_slug`,
`partner_name`, `partner_category`, `page_type`, `link_url`, `position`,
`consent_analytics`, `consent_ads`,
`user_data.sha256_email_address`, `user_data.sha256_phone_number`.

**Table de correspondance** — `LOOKUP — Ads Conversion Label`, entrée
`{{Event}}` :

| `{{Event}}` | Sortie |
|---|---|
| `generate_lead` | `<label estimation>` |
| `contact_lead` | `<label contact>` |
| `report_pdf_download` | `<label pdf>` |
| `estimation_step_view` | `<label micro>` |

**Variable de paramètres d'événement GA4** — `SETTINGS — Params communs` :
regroupe l'ensemble des variables de couche de données ci-dessus. Les
paramètres dont la variable est vide sont automatiquement omis par GTM, ce qui
permet **une seule balise d'événement GA4 pour tout le site** (§6.5).

### 6.3 Déclencheurs

**Déclencheur unique pour GA4** — `CE — Tous événements métier`, type
« Événement personnalisé », nom d'événement (correspond à l'expression
régulière) :

```
^(estimation_|generate_lead$|contact_lead$|report_|partner_click_out$|cta_click$|sticky_cta_dismiss$|consent_update$)
```

L'ancrage est délibéré : sans lui, les événements internes de GTM (`gtm.js`,
`gtm.dom`, `gtm.load`, `gtm.click`) déclencheraient la balise et pollueraient
la propriété.

**Déclencheurs de conversion** (un par balise Ads / Meta, événement
personnalisé en correspondance exacte) :

| Déclencheur | Événement | Condition supplémentaire |
|---|---|---|
| `CE — generate_lead` | `generate_lead` | — |
| `CE — contact_lead (hors partenariat)` | `contact_lead` | `contact_subject` ≠ `partenariat` |
| `CE — contact_lead (partenariat)` | `contact_lead` | `contact_subject` = `partenariat` |
| `CE — report_pdf_download` | `report_pdf_download` | — |
| `CE — micro : étape 3 atteinte` | `estimation_step_view` | `step_number` = `3` **et** `step_direction` = `forward` |
| `CE — partner_click_out` | `partner_click_out` | — |
| `CE — consent_update` | `consent_update` | — |

> **Le micro-déclencheur « étape 3 »** n'est pas décoratif. Au démarrage, une
> campagne qui reçoit moins de ~30 conversions/mois ne sort jamais de sa phase
> d'apprentissage. Une conversion secondaire à volume élevé (« a rempli
> l'adresse, le type de bien et les caractéristiques ») donne du signal aux
> enchères pendant que le volume de vrais leads se constitue. Elle est
> **secondaire** : jamais comptée dans la colonne « Conversions ».

### 6.4 Réglages de consentement, balise par balise

| Balise | Consentement supplémentaire requis |
|---|---|
| Google tag (GA4) | *Aucun* — le Consent Mode s'applique nativement (`analytics_storage`) |
| GA4 — Événement | *Aucun* — idem |
| Google Ads — Conversion Linker | *Aucun* — natif |
| Google Ads — Conversions | *Aucun* — natif (`ad_storage`, `ad_user_data`) |
| **Meta — Pixel de base** | **`ad_storage` + `ad_user_data` + `ad_personalization`** |
| **Meta — Événements** | **idem** |

C'est le point que l'on rate le plus souvent : le Consent Mode est un mécanisme
**Google**. Une balise Custom HTML Meta s'exécute sans lui demander son avis si
on ne coche rien. Les trois signaux sont donc à déclarer explicitement, sans
quoi le pixel se charge chez un visiteur qui a refusé — manquement caractérisé
à l'article 82.

### 6.5 Balises

| # | Balise | Type | Déclencheur | Notes |
|---|---|---|---|---|
| 1 | `GA4 — Configuration` | Google tag | *Initialisation — Toutes les pages* | ID `{{CONST — GA4 Measurement ID}}`. `send_page_view` = true |
| 2 | `GA4 — Événement générique` | GA4 Event | `CE — Tous événements métier` | Nom d'événement = `{{Event}}`, paramètres = `{{SETTINGS — Params communs}}` |
| 3 | `Ads — Conversion Linker` | Conversion Linker | *Toutes les pages* | Filet de sécurité pour la capture du `gclid` |
| 4 | `Ads — Conversion : estimation` | Google Ads Conversion Tracking | `CE — generate_lead` | `transaction_id` = `{{lead_id}}`, valeur `{{value}}`, devise `{{currency}}`, conversions améliorées activées |
| 5 | `Ads — Conversion : contact` | idem | `CE — contact_lead (hors partenariat)` | idem |
| 6 | `Ads — Conversion : partenariat` | idem | `CE — contact_lead (partenariat)` | valeur `0` |
| 7 | `Ads — Conversion : PDF` | idem | `CE — report_pdf_download` | secondaire |
| 8 | `Ads — Conversion : micro étape 3` | idem | `CE — micro : étape 3 atteinte` | secondaire, valeur `0` |
| 9 | `Ads — Remarketing` | Google Ads Remarketing | *Toutes les pages* | Audiences de remarketing |
| 10 | `Meta — Pixel de base` | Custom HTML | *Toutes les pages* (consentement §6.4) | `fbq('init', {{CONST — Meta Pixel ID}})` |
| 11 | `Meta — Lead` | Custom HTML | `CE — generate_lead` | `fbq('track','Lead',{value,currency},{eventID:'{{lead_id}}'})`. **Séquencement** : balise 10 en balise de configuration |
| 12 | `Meta — Contact` | Custom HTML | `CE — contact_lead (hors partenariat)` | idem, `'Contact'` |
| 13 | `Meta — ViewContent` | Custom HTML | `CE — report_view` | idem |

**Une seule balise GA4 d'événement** (n° 2) plutôt que quinze : le nom de
l'événement et ses paramètres viennent du dataLayer, donc quinze balises
seraient quinze copies du même objet. Ajouter un événement au plan ne demandera
alors que d'étendre l'expression régulière du déclencheur et, si besoin, la
variable de paramètres.

### 6.6 Le conteneur est généré, pas configuré à la souris

Tout le §6 est produit par `scripts/build-gtm-container.mjs` et versionné dans
`gtm/container-estimer-co.json`, importable tel quel. Le mode opératoire complet
(import, identifiants à renseigner, recette, publication) est dans
[`gtm/README.md`](../gtm/README.md).

**Pourquoi ce détour plutôt que de configurer directement dans l'interface** :
un conteneur configuré à la souris ne vit que chez Google. Il n'est ni relisible
en revue, ni comparable d'une version à l'autre, ni reconstructible après une
fausse manœuvre — et personne ne peut répondre à « qui a changé ce déclencheur,
quand, et pourquoi » autrement qu'en fouillant l'historique des versions.
Accessoirement, les 44 variables de couche de données tiennent ici en une liste ;
à la main, ce sont 44 formulaires identiques à remplir.

`scripts/test-gtm-container.mjs` verrouille en CI ce qui est vérifiable sans
Google — et notamment **la dérive entre le code et le conteneur** : le test relit
les événements réellement poussés par `src/scripts/` et échoue si le déclencheur
GA4 en laisse passer un. Ce qu'il ne peut PAS faire, c'est garantir que Google
acceptera l'import : seule l'interface fait autorité sur le format. D'où
l'obligation d'importer dans un espace de travail neuf et de passer par le mode
Aperçu avant toute publication.

### 6.7 Dossiers du conteneur

`00 — Socle`, `10 — GA4`, `20 — Google Ads`, `30 — Meta`, `90 — Variables`.
Nommage des versions : `AAAA-MM-JJ — objet du changement`. Aucune publication
sans description : c'est le seul journal de bord d'un conteneur.

---

## 7. Google Ads

### 7.1 Actions de conversion à créer

| Nom | Catégorie | Comptage | Fenêtre clic | Objectif | Valeur |
|---|---|---|---|---|---|
| `Estimation — lead` | Envoyer un formulaire de prospect | **Une seule** | 30 j | **Principal** | Variable (`{{value}}`) |
| `Contact — message` | Contacter | Une seule | 30 j | Principal | Variable |
| `Contact — partenariat` | Autre | Une seule | 30 j | **Secondaire** | Aucune |
| `Rapport — PDF` | Télécharger | Une seule | 30 j | Secondaire | Aucune |
| `Tunnel — étape 3` | Autre | Une seule | 7 j | Secondaire | Aucune |

« Une seule » et non « Toutes » : un visiteur qui estime deux biens représente
deux leads *métier*, mais l'attribution publicitaire porte sur l'acquisition du
visiteur, pas sur son activité. Compter « toutes » gonflerait mécaniquement le
taux de conversion des campagnes qui attirent des visiteurs répétitifs.

### 7.2 Réglages du compte

- **Balisage automatique (`gclid`) activé** — et **aucun UTM manuel sur les
  annonces Google** : un `utm_source` manuel écrase l'attribution automatique
  dans GA4. C'est l'erreur la plus fréquente et la plus coûteuse.
- **Consent Mode déclaré** — vérifier dans *Outils → Diagnostic du consentement*
  que Google reçoit bien les signaux et que la **modélisation des conversions**
  est active. C'est le bénéfice concret du choix « Advanced » déjà fait
  (`Analytics.astro`) : les refus restent modélisés au lieu de disparaître.
- **Liaisons** : Ads ↔ GA4, Ads ↔ Search Console, Ads ↔ Merchant (sans objet ici).
- **Exclusions** : IP internes filtrées côté GA4 ; `/pdf-preview` exclu de tout
  suivi (page d'outillage).

### 7.3 Conversions améliorées pour les prospects

Elles rattachent une conversion à un clic même quand le cookie a disparu (ITP,
navigation multi-appareils). Le gain type est de 5 à 15 % de conversions
récupérées — et elles sont le **prérequis technique** de l'import de
conversions hors ligne (§10).

Mise en œuvre retenue, conforme au §2.6 :

1. Le code hache e-mail et téléphone en SHA-256 **avant** le push
   (normalisation Google : `trim`, minuscules, téléphone en `+33XXXXXXXXX`).
2. Le dataLayer reçoit :
   ```js
   user_data: {
     sha256_email_address: '<hex>',
     sha256_phone_number:  '<hex>'   // omis si non renseigné
   }
   ```
3. Dans GTM : variable *Données fournies par l'utilisateur* → mode manuel →
   champs alimentés par `{{user_data.sha256_email_address}}` et
   `{{user_data.sha256_phone_number}}`, rattachée aux balises 4 et 5.

> **Point de conformité à traiter avant activation** : la politique de
> confidentialité mentionne « les identifiants techniques nécessaires à leur
> rapprochement » (`politique-de-confidentialite.astro:474`). Un e-mail haché
> reste une donnée personnelle au sens du RGPD. Faire évoluer cette phrase pour
> nommer explicitement « une empreinte cryptographique de votre adresse e-mail
> et de votre numéro de téléphone », et **incrémenter `CONSENT_REVISION`**
> (`src/lib/analytics.ts:67`) — l'ajout d'une finalité invalide les
> consentements déjà recueillis, c'est précisément le cas prévu par ce
> compteur.

---

## 8. Meta Ads

| Événement Meta | Source | Paramètres |
|---|---|---|
| `PageView` | Pixel de base | — |
| `Lead` | `generate_lead` | `value`, `currency`, `eventID` = `lead_id` |
| `Contact` | `contact_lead` (hors partenariat) | `value`, `currency`, `eventID` = `lead_id` |
| `ViewContent` | `report_view` | `content_name` = `rapport`, `eventID` = `lead_id` |

`eventID` est indispensable : c'est lui qui permettra la **déduplication** le
jour où la Conversions API (envoi serveur) doublera le pixel. Sans lui, chaque
conversion serait comptée deux fois par Meta.

---

## 9. Implémentation côté code

### 9.1 Nouveaux fichiers

**`src/scripts/tracking.js`** — style du projet : script classique injecté par
`RawScript.astro`, ES5, ni `import` ni `export`, tout en portée globale.

```js
// Contrat : window.embTrack(nom, params) — ne lève JAMAIS, ne bloque JAMAIS.
// Un défaut de mesure ne doit pas casser un parcours de conversion.
function embTrack(nom, params) {
  try {
    if (typeof window === "undefined") return;
    window.dataLayer = window.dataLayer || [];
    var charge = { event: nom };
    if (params) {
      for (var cle in params) {
        if (!Object.prototype.hasOwnProperty.call(params, cle)) continue;
        var valeur = params[cle];
        // Un paramètre vide vaut mieux absent : GTM l'omet, et les rapports
        // GA4 ne se remplissent pas de lignes « (not set) ».
        if (valeur === null || valeur === undefined || valeur === "") continue;
        charge[cle] = valeur;
      }
    }
    window.dataLayer.push(charge);
  } catch (erreur) {
    /* silence volontaire */
  }
}

/** Identifiant de lead — clé de déduplication inter-plateformes (§2.4). */
function embLeadId() { /* crypto.randomUUID() avec repli */ }

/** Tranches de surface — cardinalité maîtrisée pour GA4 (§9.4). */
function embSurfaceBucket(surface) { /* <30 | 30-59 | 60-89 | 90-119 | 120-199 | 200+ */ }

/** Code département depuis le code postal (2A/2B et DOM compris). */
function embDepartement(codePostal) { /* … */ }

/** Qualification du lead (§5.1). */
function embLeadQuality(isOwner, wantToSell) { /* hot | warm | cold */ }

/** Type de page, pour qualifier les clics sortants. */
function embPageType(chemin) { /* accueil | partenaires_index | … */ }

/** Délégation unique des clics : un seul écouteur, en capture et passif. */
// document.addEventListener('click', …) -> partner_click_out | cta_click
```

`embHash` (SHA-256 des données de contact) n'y figure pas : c'est du lot T3, et
livrer une fonction que rien n'appelle serait de la dette, pas de l'avance.

**`src/components/Tracking.astro`** — `<RawScript code={trackingScript} />`,
inséré dans `BaseLayout.astro` **juste après `<Analytics />`** dans le `<head>` :
`embTrack` doit exister avant l'exécution du moindre script de page.

**Conditionné à `TRACKING_ACTIF`**, comme `Analytics` et `ConsentBanner`. On
avait d'abord envisagé de l'injecter en permanence, en arguant qu'un tableau
JavaScript que personne ne lit n'est pas un traceur. C'est vrai — et
`scripts/test-consent-banner.mjs` a eu raison de le refuser : il vérifie que
sans conteneur, **aucun marqueur Google n'atteint la page, `dataLayer`
compris**. Un site déclaré muet doit l'être jusque dans son code source, sans
quoi la promesse devient affaire d'interprétation. Bénéfice accessoire : zéro
octet mort sur un déploiement sans conteneur.

**Conséquence pour tous les appelants** : `embTrack` peut ne pas exister. Les
scripts de page écrivent donc `if (typeof embTrack === "function")`, exactement
comme ils testent déjà `requestLead` ou `CONFIG`. Un `ReferenceError` levé au
milieu de `handleSubmit()` ne coûterait pas une mesure, il coûterait le lead.

### 9.2 Points d'insertion (fichier par fichier)

✅ = livré au lot T0.

| Fichier | Endroit | Ajout |
|---|---|---|
| ✅ `src/layouts/BaseLayout.astro` | après `<Analytics />` | `<Tracking />` |
| ✅ `src/components/ConsentBanner.astro` | l. 158 | `consentement_maj` → `consent_update`, clés en `consent_analytics` / `consent_ads` |
| ✅ `src/components/StickyCta.astro` | l. 67 | `data-cta="sticky"` |
| ✅ `src/components/Header.astro` | l. 22, 52, 56 | `data-cta="announce"` / `header_nav` / `header` |
| ✅ `src/pages/index.astro` | l. 358, 888, 898, 946 | `hero_form`, `section_final_estimation`, `section_final_contact`, `faq_contact` |
| ✅ `src/pages/carte.astro` | l. 203 | `data-cta="carte"` |
| ✅ `src/pages/partenaires.astro` | listing + CTA final | `data-partner-slug` (dérivé du nom, cf. commentaire du fichier), `data-partner-name`, `data-partner-position` ; `partenaires_contact` / `partenaires_parcours`. **`data-partner-category` reste absent** tant que la page ne consomme pas la collection `partenaires` (`specs/cms-seo-tracking.md` lot 1) — une catégorie inventée serait pire qu'une catégorie manquante |
| ✅ `src/pages/rapport.astro` | l. 155-156 | `data-cta="rapport_expert"` / `rapport_nouvelle` |
| ✅ `src/scripts/sticky-cta.js` | l. 130 | `sticky_cta_dismiss` |
| ✅ `src/scripts/estimation-ui.js` | enveloppe de `next` / `prev` / `goToStep` / `setErrors` | `suivreEtape()` compare `wizard.state.currentStep` au dernier suivi. **Une enveloppe plutôt que six appels** : un site d'appel ajouté plus tard et oublié creuserait un trou dans l'entonnoir, et un trou dans un entonnoir ne se voit pas — on lit simplement de mauvais taux d'abandon pendant des mois |
| ✅ ″ | retour `false` de `next()` | `estimation_step_error` — les NOMS des champs fautifs, jamais leur contenu |
| ✅ ″ | après le pré-remplissage depuis l'URL | `estimation_start` — `mesureActive` reste faux pendant toute l'initialisation, qui appelle `next()`/`goToStep()` plusieurs fois |
| ✅ ″ | `handleSubmit()`, après validation | génération du `lead_id` + `estimation_submit` |
| ✅ ″ | `finalizeSubmit()` | `estimation_api_result` (statut, score de confiance, comparables, latence) |
| ✅ ″ | branches `invalid` / `rate-limited` / `catch` | `estimation_failed` |
| ✅ ″ | `finalizeSubmit()`, avant `persistEstimation()` | `payload.lead_id` — il n'atteint jamais l'API, dont la validation est en liste blanche stricte |
| ✅ `src/scripts/rapport-report.js` | `mesurerRapport()`, après lecture de `lastEstimation` | `report_view` puis, si `lead_id` non encore tracké : `generate_lead` + marquage `emb.lead.<id>.tracked` |
| ✅ ″ | `downloadPDF()`, **après** `doc.save()` | `report_pdf_download` — un PDF qui a échoué n'est pas un téléchargement |
| ✅ `src/scripts/contact.js` | `onSuccess()` | `contact_lead` (le succès, **pas** la soumission) |

**Ce qui ne bouge pas** : `estimation-wizard.js` n'est pas touché. Le wizard
ignore l'API ; il doit tout autant ignorer la mesure. La couche
`estimation-ui.js`, qui possède déjà le DOM et l'orchestration, est le bon
endroit — et la suite de tests `scripts/test-estimation-wizard.mjs` reste
valable sans modification.

### 9.3 Le cas `/rapport/`, en détail

```
Chargement de /rapport/
  ├─ lastEstimation absent .......................... aucun événement
  ├─ lastEstimation sans lead_id (ancien visiteur) .. report_view seul
  └─ lastEstimation avec lead_id
       ├─ localStorage['emb.lead.<id>.tracked'] ..... report_view seul
       └─ sinon ..................................... report_view + generate_lead
                                                       puis marquage tracked
```

Couvre le rechargement, le retour arrière bfcache (`estimation-ui.js:1108`), le
bouton « Réessayer » (`rapport-report.js:874`) et le visiteur de retour dont le
`lastEstimation` date d'une visite antérieure.

### 9.4 Dimensions et métriques personnalisées GA4

À enregistrer dans *Admin → Définitions personnalisées* (portée **événement**) —
sans cela, les paramètres sont collectés mais invisibles dans les rapports :

`lead_id`, `lead_type`, `lead_quality`, `property_type`, `surface_bucket`,
`dpe`, `departement_code`, `region`, `estimation_status`, `is_owner`,
`want_to_sell`, `step_key`, `error_fields`, `cta_id`, `partner_slug`,
`partner_category`, `contact_subject`, `address_source`, `entry_point`,
`page_type`.

**Métriques** : `estimation_value` (Devise), `confidence_score` (Standard),
`comparables_count` (Standard), `latency_ms` (Standard).

`postal_code` est envoyé sur les événements de conversion mais **n'est pas
enregistré** comme dimension : ~6 300 valeurs distinctes feraient apparaître des
lignes « (other) » dans les rapports. `departement_code` (101 valeurs) est le
bon grain d'analyse ; le code postal reste disponible via BigQuery ou l'API.

### 9.5 Tests

Un fichier `scripts/test-tracking.mjs`, dans la convention des dix suites
existantes (`node --test`, chargement du script en contexte `vm`), couvrant :

- `embTrack` ne lève pas si `dataLayer` est absent, et omet les valeurs vides ;
- `embSurfaceBucket`, `embDepartement` (dont `2A`/`2B`/DOM), `embLeadQuality`
  sur toutes les combinaisons ;
- `generate_lead` émis une fois et une seule pour un `lead_id` donné, même
  après trois chargements de `/rapport/` ;
- aucun `dataLayer.push` ne contient `address`, `name`, `email`, `phone` ou
  `message` en clair — **ce test est le garde-fou du §2.6** et doit échouer
  bruyamment si quelqu'un ajoute un paramètre imprudent.

À ajouter au script `test` de `package.json` et donc à la CI
(`.github/workflows/site.yml`).

---

## 10. Convention de campagne et attribution

### 10.1 UTM

| Canal | Règle |
|---|---|
| **Google Ads** | **Aucun UTM.** Balisage automatique (`gclid`) uniquement (§7.2) |
| **Meta Ads** | UTM obligatoires : `utm_source=meta`, `utm_medium=paid_social`, `utm_campaign={{campaign.name}}`, `utm_content={{ad.name}}`, `utm_id={{campaign.id}}` |
| **E-mailing / partenaires** | `utm_medium=email` / `referral`, `utm_source` = nom de l'émetteur |

### 10.2 Nommage des campagnes

`canal_objectif_cible_zone_AAAAMM` — minuscules, sans accent, séparateur `_`.
Exemple : `gads_lead_proprietaire_idf_202609`.

### 10.3 Attribution

GA4 : modèle **basé sur les données**, fenêtre d'acquisition 90 jours. Ads :
attribution par défaut du compte. Ne pas comparer trait pour trait les chiffres
Ads et GA4 : les fenêtres, les modèles et le traitement de la modélisation du
consentement diffèrent — c'est normal, et l'expliquer une fois vaut mieux que
de l'expliquer tous les mois.

---

## 11. Lots de livraison

| Lot | Contenu | Dépend de | Valeur |
|---|---|---|---|
| **T0 — Socle** ✅ | `tracking.js`, `Tracking.astro`, attributs `data-cta` / `data-partner-*`, renommage `consent_update`, événements `cta_click` / `partner_click_out` / `sticky_cta_dismiss`, `scripts/test-tracking.mjs` (22 cas, en CI) | — | Le dataLayer parle |
| **T1 — Tunnel et conversions** ✅ | Événements du §4.2, `generate_lead` sur `/rapport/`, `contact_lead`, `lead_id`, modèle de valeur, 16 tests supplémentaires | T0 | **Mesure de bout en bout : campagnes ouvrables** |
| **T2 — GTM et plateformes** ◐ | Conteneur généré et versionné (`gtm/`, §6 couvert intégralement) ; **restent manuels** : actions Ads (§7.1), dimensions GA4 (§9.4), pixel Meta (§8) — aucun de ces objets n'a de format d'import | T1 | Conversions remontées |
| **T3 — Conversions améliorées** | Hachage SHA-256, variable *user_data*, mise à jour de la politique, `CONSENT_REVISION` +1 | T2 | +5 à 15 % de conversions attribuées |
| **T4 — Serveur** *(optionnel)* | `PUBLIC_GTM_SERVER_URL` → conteneur serveur, Meta CAPI, résilience aux bloqueurs | T3 | Fiabilité de la mesure |
| **T5 — Hors ligne** *(optionnel)* | `gclid` + `ga_client_id` transmis à `POST /v1/leads`, import des conversions hors ligne (lead → mandat signé) | T4 + CRM | Optimisation sur la **vraie** valeur |

> **T5 exige deux changements hors périmètre front** : (1) `POST /v1/leads`
> refuse aujourd'hui tout champ hors liste blanche
> (`api/app/validators/lead.ts` — `LEAD_ALLOWED_FIELDS`), il faudra l'étendre ;
> (2) **aucun lead n'est persisté côté serveur** — il n'existe pas de table
> `leads`, les données traversent le processus et partent par SMTP. Sans outil
> de suivi commercial capable de rattacher un `gclid` à une signature, l'import
> hors ligne n'a aucune matière. À arbitrer avant d'y investir.

---

## 12. Recette

### 12.1 Avant publication du conteneur

Mode Aperçu GTM + Tag Assistant, parcours complet :

- [ ] Accueil : `cta_click` (`hero_form`) à la soumission de l'adresse
- [ ] `/estimation` : `estimation_start` **une seule fois**
- [ ] `estimation_step_view` à chaque étape, `step_direction` correct en arrière
- [ ] Champ vide → `estimation_step_error` avec les bons `error_fields`
- [ ] `estimation_address_selected` avec `address_source=autocomplete`, puis en saisie manuelle
- [ ] Soumission : `estimation_submit` avec un `lead_id` non vide
- [ ] `estimation_api_result` avec `estimation_status` cohérent (tester aussi API coupée → `static-fallback`)
- [ ] `/rapport/` : `report_view` **+** `generate_lead`, `value` non nulle
- [ ] **Recharger `/rapport/` : `report_view` seul, pas de second `generate_lead`**
- [ ] **Retour arrière puis avant : idem**
- [ ] PDF : `report_pdf_download`
- [ ] `/partenaires` : `partner_click_out` avec les bons attributs, et **le lien s'ouvre sans délai**
- [ ] `/contact` : `contact_lead` au succès seulement ; tester aussi un échec (aucun événement)

### 12.2 Consentement

- [ ] Avant tout choix : aucun cookie `_ga`, `_gcl`, `_fbp`. Tag Assistant affiche les balises Google en « consentement non accordé »
- [ ] Refus : idem, durablement, et le parcours reste **entièrement fonctionnel** jusqu'au rapport
- [ ] Acceptation : `consent_update` poussé, cookies déposés, `generate_lead` remonté
- [ ] Retrait a posteriori (« Gestion des cookies ») : cookies effacés par `autoClear` (`ConsentBanner.astro:200-222`), plus aucun événement publicitaire
- [ ] Rappel : le bandeau ne s'affiche pas sous Playwright/Puppeteer (`hideFromBots`) — cf. l'en-tête de `ConsentBanner.astro`

### 12.3 Après publication

- [ ] GA4 **DebugView** : tous les événements et paramètres, orthographe comprise
- [ ] Ads : chaque action de conversion passe en « Enregistrement des conversions » sous 48 h
- [ ] Ads → *Diagnostic du consentement* : signaux reçus, modélisation active
- [ ] Ads : diagnostic des **conversions améliorées** (T3) sans avertissement
- [ ] Meta Pixel Helper + *Événements de test*
- [ ] **Contrôle anti-doublon** : le nombre de conversions Ads « Estimation — lead »
      doit rester cohérent avec le nombre de `generate_lead` dans GA4. Un écart
      d'un facteur ~2 signe un import GA4 activé en plus de la balise (§2.5)

---

## 13. Points à arbitrer avant de lancer

1. **`VALEUR_BASE_LEAD`** (§5.2) — modèle A ou B, et le montant. Seule inconnue
   bloquante pour les enchères à la valeur.
2. **Conversions améliorées** (§7.3) — validation RGPD, réécriture du paragraphe
   « publicité » de la politique, incrément de `CONSENT_REVISION`.
3. **Identifiants** à fournir : ID de mesure GA4, ID de conversion Ads et
   libellés, ID du pixel Meta.
4. **Marquage côté serveur** (T4) — sous-domaine (`sst.estimer.co`) et
   hébergement à prévoir, comme sur ritmodiag.com.
5. **Suivi commercial** (T5) — existe-t-il un outil capable de rattacher un lead
   à un mandat signé ? Sans lui, l'optimisation sur la valeur réelle reste
   hors d'atteinte.
6. **Campagne partenariat** — les candidatures partenaires relèvent-elles du
   même budget publicitaire ? Sinon, elles restent en observation, comme prévu.
