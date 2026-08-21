# Conteneur Google Tag Manager — mode opératoire

Lot **T2** de [`specs/plan-taggage-conversions.md`](../specs/plan-taggage-conversions.md).
Le plan reste la source de vérité des décisions ; ce fichier ne décrit que les
gestes à faire.

| Fichier | Rôle |
|---|---|
| `scripts/build-gtm-container.mjs` | **Source de vérité de la configuration.** C'est lui qu'on modifie |
| `gtm/container-estimer-co.json` | Généré (`npm run gtm:build`), committé parce que c'est lui qu'on importe |
| `scripts/test-gtm-container.mjs` | Garde-fous en CI (`npm run test:gtm`) |

> **Ne pas configurer à la souris.** Un conteneur modifié directement dans
> l'interface n'est ni relisible en revue, ni comparable d'une version à
> l'autre, ni reconstructible après une fausse manœuvre. Tout changement passe
> par le générateur, puis par un ré-import. La CI échoue si le JSON committé a
> divergé du générateur.

---

## 1. Ce que l'import couvre — et ce qu'il ne couvre pas

**Couvert** (49 variables, 9 déclencheurs, 14 balises, 5 dossiers) : tout le §6
du plan. Variables de couche de données, déclencheurs, balises GA4, Google Ads
et Meta, réglages de consentement, dossiers.

**Non couvert, parce qu'aucun de ces objets n'a de format d'import** :

- les **actions de conversion Google Ads** (§4 ci-dessous) — le conteneur les
  alimente, il ne les crée pas ;
- les **dimensions personnalisées GA4** (§5) — sans elles, les paramètres sont
  collectés mais **invisibles dans les rapports** ;
- le **pixel Meta** lui-même (§6), qui doit exister côté Meta Business.

Tant que ces trois-là ne sont pas faits, les balises tirent dans le vide.

---

## 2. Importer

1. GTM → conteneur **GTM-5TB8F4CS** → *Admin* → **Importer un conteneur**.
2. Fichier : `gtm/container-estimer-co.json`.
3. Espace de travail : **créer un espace de travail** dédié.
   Jamais « Default Workspace » : un import qui déraille doit pouvoir être jeté
   sans emporter le travail de quelqu'un d'autre.
4. Option d'import : **Fusionner** → **Remplacer les balises, déclencheurs et
   variables en conflit**.
   *Écraser* supprimerait tout ce que le conteneur contient déjà.
5. Lire l'**aperçu des modifications** que GTM affiche avant de valider. C'est
   le seul contrôle qui fasse autorité sur le format du fichier : le test
   automatique vérifie la cohérence interne du conteneur, **pas** que Google
   l'acceptera.

> ⚠️ **Ne rien publier à cette étape.** L'import ne fait que remplir un espace
> de travail. La publication vient au §7, après la recette.

---

## 3. Les trois identifiants à renseigner

Tout est regroupé dans trois variables constantes, dossier `90 — Variables` —
c'est précisément pour ça qu'elles existent : un identifiant recopié dans huit
balises est un identifiant qu'on oubliera de corriger dans la huitième.

| Variable | Valeur | État |
|---|---|---|
| `CONST — GA4 Measurement ID` | `G-B066RRFQL5` | ✅ **déjà versionnée** — rien à saisir |
| `CONST — Google Ads Conversion ID` | `18402972391` | ✅ **déjà versionnée** — rien à saisir |
| `CONST — Meta Pixel ID` | 15 chiffres | à fournir (Meta Events Manager) |

Ces identifiants ne sont pas des secrets : ils figurent en clair dans le HTML
livré dès que les balises tirent. Les versionner dans le générateur supprime une
ressaisie à chaque import — donc une occasion de se tromper. Les fournir se fait
dans `scripts/build-gtm-container.mjs`, puis `npm run gtm:build`, jamais
directement dans l'interface.

> **`AW-` est à retirer de la constante.** Les balises `awct` (conversion) et
> `sp` (remarketing) attendent le nombre seul. Seule la balise `Ads —
> Configuration` veut le préfixe, et elle se le fabrique à partir de la même
> constante. Coller `AW-…` dans la constante produit des balises qui passent la
> validation de GTM et ne remontent **jamais** rien.

> **Ne jamais coller le snippet « Balise Google » proposé par Ads dans le
> site.** Il court-circuiterait le conteneur, figerait un identifiant hors du
> générateur versionné, et chargerait un second `gtag.js`. La balise `Ads —
> Configuration` du conteneur remplit ce rôle.

## 3bis. Les libellés de conversion

Chaque action de conversion Ads a son **libellé** (une chaîne alphanumérique du
type `nX2wCMbv8...`), à ne pas confondre avec l'« identifiant associé au type de
conversion » que l'interface affiche en évidence — ce dernier est un numéro
interne à l'API, il n'a rien à faire dans une balise.

On le trouve sur la page de l'action → **Configurer la balise** → *Google Tag
Manager*. Dans un snippet, c'est la partie après la barre oblique :
`'send_to': 'AW-18402972391/LE_LIBELLÉ'`.

Ils se renseignent dans `scripts/build-gtm-container.mjs`, en haut du bloc des
conversions :

| Constante | Action Ads | État |
|---|---|---|
| `LIBELLE_ESTIMATION` | Estimation - Lead | à fournir |
| `LIBELLE_CONTACT` | Contact - message | à fournir |
| `LIBELLE_PARTENARIAT` | Contact - partenariat | à fournir |
| `LIBELLE_PDF` | *(reportée)* | — |
| `LIBELLE_MICRO` | *(reportée)* | — |

> **Une balise dont le libellé est encore un gabarit `LABEL_…` est
> automatiquement mise EN PAUSE** par le générateur. C'est mécanique et non
> confié à la vigilance : une conversion qui tire avec un faux libellé ne
> remonte rien, sans lever la moindre erreur — les campagnes tournent, le budget
> part, et la colonne « Conversions » reste à zéro sans qu'on sache pourquoi.
> Renseigner le libellé réveille la balise, il n'y a rien d'autre à penser.

> **Pas de table de correspondance par événement.** Elle a existé, elle
> supposait « un événement = une action ». « Contact - message » et
> « Contact - partenariat » sont deux actions Ads déclenchées par le même
> `contact_lead`, séparées par le sujet : la table leur aurait servi le même
> libellé. Chaque balise porte donc le sien.

---

## 4. Créer les actions de conversion Google Ads

Ads → *Objectifs* → *Conversions* → **Nouvelle action** → *Site Web* → configuration **manuelle**.

| Nom | Catégorie | Valeur | Comptage | Fenêtre clic | Objectif | État |
|---|---|---|---|---|---|---|
| Estimation - Lead | Envoyer un formulaire de prospect | Différente (défaut 100 €) | **Une seule** | 30 j | **Principal** | ✅ créée |
| Contact - message | Contacter | Différente (défaut 50 €) | Une seule | 30 j | Principal | ✅ créée |
| Contact - partenariat | Envoyer un formulaire de prospect | Ne pas utiliser | Une seule | 30 j | **Secondaire** | ✅ créée |
| Rapport — PDF | Télécharger | Ne pas utiliser | Une seule | 30 j | Secondaire | ⏸ reportée |
| Tunnel — étape 3 | Autre | Ne pas utiliser | Une seule | 7 j | Secondaire | ⏸ reportée |

Les deux dernières sont **reportées** (décision du 21/08/2026 : on démarre avec
les trois conversions issues d'un formulaire). Leurs balises sont en pause dans
le conteneur — pas supprimées : les remettre en service ne demandera qu'un
libellé et un ré-import.

Ce qu'on se prive en attendant : la micro-conversion d'étape 3 est le signal à
fort volume qui aide les enchères à sortir de leur phase d'apprentissage tant
que les vrais leads sont rares. À reconsidérer si les campagnes plafonnent sous
une trentaine de conversions par mois.

Deux points qui coûtent cher s'ils sont manqués :

- **« Une seule » et non « Toutes ».** Un visiteur qui estime deux biens
  représente bien deux leads métier, mais l'attribution publicitaire porte sur
  l'acquisition du visiteur. « Toutes » gonflerait mécaniquement le taux de
  conversion des campagnes qui attirent des visiteurs répétitifs.
- **Ne PAS importer en plus l'événement GA4 correspondant.** Les conversions
  remontent par balise directe (plan §2.5). Faire les deux compte double, et
  divise par deux le coût par conversion affiché — le défaut n°1 des comptes
  Ads mal câblés.

Relever le **libellé** de chaque action et le reporter dans la table de
correspondance du §3.

---

## 5. Déclarer les dimensions personnalisées GA4

GA4 → *Admin* → *Définitions personnalisées*. **Sans cette étape, les
paramètres sont collectés mais n'apparaissent dans aucun rapport.**

**Dimensions** (portée *Événement*) : `lead_id`, `lead_type`, `lead_quality`,
`property_type`, `surface_bucket`, `dpe`, `departement_code`,
`estimation_status`, `is_owner`, `want_to_sell`, `step_key`, `step_direction`,
`error_fields`, `cta_id`, `partner_slug`, `contact_subject`, `address_source`,
`entry_point`, `page_type`, `failure_type`.

**Métriques** : `estimation_value` (Devise), `confidence_score` (Standard),
`comparables_count` (Standard), `latency_ms` (Standard).

> **`postal_code` n'est volontairement PAS déclaré.** ~6 300 valeurs distinctes
> feraient apparaître des lignes « (other) » qui rendent le rapport faux.
> `departement_code` (101 valeurs) est le bon grain d'analyse ; le code postal
> reste envoyé et exploitable via BigQuery ou l'API.

### Conservation des données

*Admin* → *Paramètres des données* → *Conservation des données* → **14 mois**
(le maximum d'une propriété standard ; le défaut est de 2 mois, ce qui interdit
toute comparaison d'une année sur l'autre).

Ce réglage porte sur les données **dérivées** des traceurs, couvertes par la
clause « 25 mois pour les statistiques agrégées » de la politique. À ne pas
confondre avec la **durée du cookie `_ga` lui-même**, plafonnée à 395 jours par
la balise de configuration du conteneur (`cookie_expires`) pour tenir les
« 13 mois maximum » annoncés au visiteur.

> **À vérifier après l'import** : ouvrir `GA4 — Configuration` et contrôler que
> le paramètre `cookie_expires` vaut bien `34128000`. Sans lui, GA4 retombe sur
> ses **deux ans** par défaut — soit un traceur d'une durée que la politique du
> site interdit. `scripts/test-gtm-container.mjs` verrouille la valeur côté
> dépôt, mais seule l'interface dira si l'import l'a conservée.

À faire aussi, tant qu'on y est :

- *Collecte de données* → **désactiver « Interactions avec les formulaires »**
  dans la mesure améliorée. Le tunnel est un formulaire unique à 5 panneaux :
  `form_start`/`form_submit` y produiraient un bruit qui concurrencerait notre
  propre entonnoir.
- Laisser **« Clics sortants » activés** : ce sont des événements `click`,
  jamais des conversions. Le reporting partenaires s'appuie sur
  `partner_click_out`.
- *Paramètres des données* → **filtrer le trafic interne** (IP du bureau).

---

## 5bis. Vérifier la variable de conversions améliorées

⚠️ **`UD — Données fournies par l'utilisateur` est l'entité la plus susceptible
d'être mal reconstituée par l'import.** Le nom exact des champs de ce type de
variable n'est pas documenté hors de l'interface.

Après l'import, l'ouvrir et vérifier qu'elle contient bien :

| Champ | Valeur |
|---|---|
| Type de saisie | **Manuel** |
| E-mail | `{{DLV — user_data.sha256_email_address}}` |
| Téléphone | `{{DLV — user_data.sha256_phone_number}}` |

Si elle est vide ou incomplète, la refaire à la main prend deux minutes
(*Variables* → *Nouvelle* → **Données fournies par l'utilisateur** → mode
*Manuel*), sous le **même nom** — les deux balises de conversion la référencent.

**Mode « Manuel » et jamais « Automatique ».** Le mode automatique demande à
Google de parcourir le DOM à la recherche de champs de formulaire, c'est-à-dire
de lire l'adresse e-mail en clair sur la page. Ici, le site calcule lui-même une
empreinte SHA-256 (`embUserData` dans `src/scripts/tracking.js`) : Google ne voit
jamais la donnée d'origine.

Côté Google Ads, activer les conversions améliorées sur les deux actions
concernées (**Estimation — lead** et **Contact — message**), en choisissant
l'implémentation **par Google Tag Manager** — et accepter les conditions
d'utilisation des données client, sans quoi le diagnostic reste en attente
indéfiniment.

Les trois autres conversions (partenariat, PDF, micro-étape 3) n'ont
**volontairement pas** de conversions améliorées : aucun formulaire ne leur
fournit de coordonnées, et les activer laisserait un diagnostic en erreur
permanent — un voyant rouge derrière lequel une vraie panne passerait inaperçue.

## 6. Meta

Créer le pixel dans Events Manager, relever son identifiant, le poser dans
`CONST — Meta Pixel ID`.

Les trois balises d'événement (`Lead`, `Contact`, `ViewContent`) portent un
`eventID` égal au `lead_id`. **Ne pas le retirer** : c'est lui qui permettra la
déduplication le jour où la Conversions API (envoi serveur, lot T4) doublera le
pixel. Sans lui, chaque conversion serait comptée deux fois.

---

## 7. Recette, puis publication

### Mode Aperçu (avant toute publication)

Parcours complet, en vérifiant dans Tag Assistant :

- [ ] accueil : `cta_click` (`hero_form`) à la soumission de l'adresse ;
- [ ] `/estimation` : `estimation_start` **une seule fois**, puis un
      `estimation_step_view` par étape, `step_direction` correct en arrière ;
- [ ] champ vide → `estimation_step_error` avec les bons `error_fields` ;
- [ ] soumission → `estimation_submit` avec un `lead_id` non vide ;
- [ ] `/rapport/` → `report_view` **+** `generate_lead`, `value` non nulle,
      et la balise `Ads — Conversion : estimation` qui tire ;
- [ ] **recharger `/rapport/` : `report_view` seul, pas de second
      `generate_lead`** ;
- [ ] **retour arrière puis avant : idem** ;
- [ ] `/partenaires` → `partner_click_out`, et le lien s'ouvre sans délai ;
- [ ] `/contact` → `contact_lead` au succès seulement ; tester aussi un échec
      (aucun événement) ;
- [ ] `Meta — Lead` tire **après** `Meta — Pixel de base`, jamais avant.

### Consentement

- [ ] avant tout choix : aucun cookie `_ga`, `_gcl`, `_fbp` ; Tag Assistant
      affiche les balises Google en « consentement non accordé » et **les
      balises Meta comme non déclenchées** ;
- [ ] refus : idem durablement, et le parcours reste **entièrement
      fonctionnel** jusqu'au rapport ;
- [ ] acceptation : `consent_update` poussé, cookies déposés, `generate_lead`
      remonté ;
- [ ] retrait a posteriori (« Gestion des cookies » du pied de page) : cookies
      effacés, plus aucun événement publicitaire.

> Rappel : le bandeau ne s'affiche pas sous Playwright/Puppeteer/Selenium
> (`hideFromBots` de vanilla-cookieconsent). La recette du consentement se fait
> à la main, ou en masquant `navigator.webdriver`.

### Publier

*Envoyer* → nom de version `AAAA-MM-JJ — objet du changement`, description
obligatoire. **C'est le seul journal de bord du conteneur.**

### Après publication

- [ ] GA4 **DebugView** : tous les événements et paramètres, orthographe comprise ;
- [ ] Ads : chaque action passe en « Enregistrement des conversions » sous 48 h ;
- [ ] Ads → *Diagnostic du consentement* : signaux reçus, **modélisation des
      conversions active** — c'est le bénéfice concret du Consent Mode
      « Advanced » déjà en place côté site ;
- [ ] Meta Pixel Helper + *Événements de test* ;
- [ ] **contrôle anti-doublon** : le nombre de conversions Ads
      « Estimation — lead » doit rester cohérent avec le nombre de
      `generate_lead` dans GA4. Un écart d'un facteur ~2 signe un import GA4
      activé en plus de la balise.

---

## 8. Modifier la configuration plus tard

1. éditer `scripts/build-gtm-container.mjs` ;
2. `npm run gtm:build` ;
3. `npm run test:gtm` ;
4. commiter le générateur **et** le JSON ;
5. ré-importer dans un espace de travail neuf (§2), re-recetter, republier.

**Ajouter un événement au site** ne demande souvent qu'une chose ici : l'ajouter
à `VARIABLES_DATALAYER` si son paramètre est nouveau. Le déclencheur GA4 est une
expression régulière par famille (`estimation_`, `report_`…), et le test
`« le déclencheur GA4 attrape tous les événements poussés par le site »`
échouera en CI si un nouvel événement passe à travers.
