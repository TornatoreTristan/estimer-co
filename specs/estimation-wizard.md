# Specs — Découpage de l'estimateur en wizard multi-étapes

Statut : **Ready for Dev (Lot 1)**
Stack : Astro 7 statique, JS vanilla, CSS vanilla. **Aucun backend** — tout est client.

Fichiers concernés :
- `src/pages/estimation.astro` — formulaire monolithique actuel + styles scoped
- `src/scripts/estimation.js` — Google Places `Autocomplete` (legacy) sur `#address`, toggles conditionnels, calcul local, EmailJS, `localStorage`, redirection `/rapport`
- `src/pages/rapport.astro`, `src/scripts/rapport-report.js`, `src/scripts/rapport-map.js` — **consommateurs** de `localStorage.lastEstimation`
- `src/lib/config.ts`, `src/components/ClientConfig.astro`, `src/components/RawScript.astro` — injection de `CONFIG` en global inline
- `src/styles/global.css` — design system flat (tokens `--orange`, `--border`, classes `.field/.input/.select/.btn/.pill/.card/.form-legend/.eyebrow/.link-arrow`)

---

## 0. Contrainte critique sur les données existantes

Le champ `address` stocké dans `lastEstimation` est la **valeur brute laissée par le widget Google dans l'input** (typiquement `"12 Rue de la Paix, 75001 Paris, France"`), pas un simple libellé de voie. `rapport-map.js` reconstruit `fullAddress = address + ", " + postalCode + " " + city + ", France"` pour géocoder.

**Règle impérative : ne pas « nettoyer » `address`.** Comportement à conserver strictement — `address` = valeur telle que déposée dans l'input (autocomplete ou saisie manuelle), `postalCode`/`city` = extraits séparément. Toute autre approche casse silencieusement la carte du rapport.

---

## 1. Découpage retenu — 5 étapes

| # | Titre | Champs | Justification |
|---|---|---|---|
| 1 | **Adresse du bien** | `address` (autocomplete), `postalCode`, `city` (auto-remplis) | Un seul geste avant tout engagement. Résultat immédiat visible (préremplissage) → progression perçue dès la 1ʳᵉ interaction. |
| 2 | **Type de bien** | `propertyType`, `hasTerrain` (si maison), `terrainSize` (si terrain) | Champ pivot conditionnant d'autres champs : l'isoler évite un écran « à trous ». |
| 3 | **Caractéristiques & DPE** | `surface`, `rooms`, `dpe`, `dpeRequest` (si DPE inconnu), CTA Ritmodiag | Données factuelles nécessaires au calcul ; place naturelle de l'accroche DPE. |
| 4 | **Votre situation** | `isOwner`, `wantToSell` | Qualification peu engageante, transition douce vers le contact. |
| 5 | **Vos coordonnées** | `name`, `email`, `phone` + bouton final | PII en dernier, après investissement de temps → meilleur taux de complétion. |

Pourquoi 5 : 3 étapes obligerait à empiler ~8 champs sur « Le bien » (retour au formulaire actuel coupé en deux) ; 8 étapes (1 champ/écran) multiplierait les clics sans gain. 5 respecte le regroupement par intention, avec au plus 3 champs visibles simultanément hors conditionnels.

**Ordre non négociable** : Adresse → Bien → Situation → Coordonnées.

---

## 2. User stories & critères d'acceptation

### US-1 — Navigation entre étapes
> En tant que vendeur potentiel, je veux avancer et reculer entre les étapes afin de contrôler ma saisie sans tout recommencer.

```gherkin
Scénario: Avancer quand l'étape courante est valide
  Given je suis sur l'étape 1 "Adresse du bien"
  And j'ai sélectionné une adresse valide via l'autocomplete
  When je clique sur "Suivant"
  Then l'étape 1 est masquée et l'étape 2 "Type de bien" devient visible
  And l'indicateur de progression affiche "Étape 2 sur 5"
  And le focus clavier se déplace sur le titre de l'étape 2

Scénario: Reculer sans perdre les données saisies
  Given je suis sur l'étape 3 avec surface=85 et rooms=3
  When je clique deux fois sur "Précédent"
  Then je suis sur l'étape 1
  When je clique deux fois sur "Suivant"
  Then les champs surface et rooms affichent toujours 85 et 3

Scénario: "Précédent" absent à la première étape
  Given je suis sur l'étape 1
  Then le bouton "Précédent" n'est pas affiché (hidden)

Scénario: "Suivant" remplacé par le bouton d'envoi à la dernière étape
  Given je suis sur l'étape 5
  Then le bouton visible est "Recevoir mon estimation gratuite" (type=submit)
  And aucun bouton "Suivant" n'est visible
```

### US-2 — Sélection d'adresse via autocomplete (étape 1)
> Je veux taper mon adresse et la sélectionner dans une liste afin de ne pas ressaisir code postal et ville.

```gherkin
Scénario: Sélection d'une suggestion Google Places
  Given l'API Google Maps est chargée
  When je tape "12 rue de la Paix" et sélectionne la suggestion (clavier ou souris)
  Then le champ adresse conserve la valeur déposée par le widget Google
  And un encart récapitulatif affiche "Code postal : 75001" et "Ville : Paris"
  And un clic sur "Suivant" fait avancer à l'étape 2 sans message d'erreur

Scénario: Correction d'une adresse déjà sélectionnée
  Given l'encart récapitulatif affiche "75001 / Paris"
  When je clique sur "Ce n'est pas la bonne adresse ?"
  Then l'encart est masqué et le champ adresse redevient éditable
  And postalCode/city internes sont réinitialisés
```

### US-3 — Adresse saisie manuellement (fallback)
> Si mon adresse n'apparaît pas dans les suggestions, je veux renseigner CP et ville manuellement afin de ne pas être bloqué.

```gherkin
Scénario: Aucune suggestion sélectionnée
  When je tape "45 avenue Foch" et quitte le champ sans sélectionner de suggestion
  Then aucun place_changed n'a été déclenché
  And un bloc "Code postal / Ville" apparaît en édition libre
  And un clic sur "Suivant" laisse sur l'étape 1 avec une erreur annoncée tant que ces deux champs ne sont pas remplis

Scénario: Code postal invalide
  When je saisis "ABC12" en code postal et clique sur "Suivant"
  Then je reste sur l'étape 1
  And "Le code postal doit contenir 5 chiffres" s'affiche, lié via aria-describedby
  And le focus est renvoyé sur le champ code postal
```

### US-4 — Adresse hors France
Périmètre MVP : France uniquement, `componentRestrictions: { country: "fr" }` conservé. Aucun message dédié « hors France » au Lot 1.

### US-5 — Cohérence des champs conditionnels au retour arrière
```gherkin
Scénario: Changement de type de bien après avoir renseigné le terrain
  Given à l'étape 2 : "Maison", terrain "Oui", 500 m²
  When je change le type pour "Appartement"
  Then hasTerrain et terrainSize sont masqués et réinitialisés
  When je reviens sur "Maison"
  Then hasTerrain est visible mais vide (pas de mémorisation)
```
Comportement identique à l'existant — ne pas le modifier.

### US-6 — Reprise après rafraîchissement (RGPD)
```gherkin
Scénario: Reprise des données non-PII
  Given j'ai rempli les étapes 1 à 3 et je suis à l'étape 4
  When je rafraîchis la page
  Then je suis relocalisé sur l'étape 4
  And les champs des étapes 1 à 3 contiennent les valeurs saisies

Scénario: Aucune persistance des données personnelles avant l'envoi
  Given j'ai saisi nom et email à l'étape 5
  When je rafraîchis la page avant de soumettre
  Then les champs nom/email/téléphone sont vides
  And aucune de ces valeurs n'a été écrite en sessionStorage

Scénario: Nettoyage après soumission
  Given j'ai soumis avec succès
  Then la clé sessionStorage "estimationWizardState" est supprimée
```

### US-7 — Navigation clavier, pas de piège de focus
```gherkin
Scénario: Entrée dans le champ adresse ne soumet pas le formulaire
  Given le menu de suggestions Google est ouvert sur #address
  When je sélectionne une suggestion avec les flèches puis Entrée
  Then la suggestion est appliquée
  And le formulaire n'est ni soumis ni avancé automatiquement

Scénario: Entrée dans un autre champ avance à l'étape suivante
  Given je suis dans #surface à l'étape 3, valeurs valides
  When j'appuie sur Entrée
  Then le comportement équivaut à un clic sur "Suivant"

Scénario: Échap ferme le menu de suggestions
  Then le menu se ferme et le focus reste sur #address

Scénario: Annonce du changement d'étape
  When je passe de l'étape 2 à l'étape 3
  Then une région aria-live="polite" annonce "Étape 3 sur 5 : Caractéristiques et DPE"
```

### US-8 — Champs conditionnels
```gherkin
Scénario: Terrain visible uniquement pour une maison (étape 2)
  When je sélectionne "Maison"
  Then "Avez-vous du terrain ?" devient visible
  When je sélectionne "Oui"
  Then "Surface du terrain" devient visible et requis

Scénario: Devis DPE si DPE inconnu (étape 3)
  When je sélectionne "Je ne connais pas mon DPE"
  Then "Souhaitez-vous réaliser un DPE ?" devient visible
  When je sélectionne "Oui, je souhaite un devis"
  Then le CTA Ritmodiag devient visible dans l'étape 3
```

### US-9 — Validation par étape
```gherkin
Scénario: Blocage si un champ requis est vide
  Given je suis à l'étape 2 sans Type de bien
  When je clique sur "Suivant"
  Then je reste sur l'étape 2
  And le champ affiche aria-invalid="true" et un message d'erreur associé
  And une bannière role="alert" annonce "Merci de compléter les champs obligatoires"
  And le focus va sur le premier champ en erreur

Scénario: Pas d'erreur avant interaction
  Given j'arrive sur l'étape 3
  Then aucun champ n'affiche d'erreur avant interaction ou clic sur "Suivant"
```

### US-10 — Soumission finale (non-régression stricte)
```gherkin
Scénario: Soumission réussie
  When je clique sur "Recevoir mon estimation gratuite"
  Then le bouton affiche "Envoi en cours..." et est désactivé pendant l'appel EmailJS
  And un formData de forme strictement identique à l'actuel est poussé dans localStorage.estimationDatabase
  And ce même objet est écrit dans localStorage.lastEstimation
  And je suis redirigé vers /rapport sans régression d'affichage

Scénario: Échec d'envoi EmailJS
  Then l'erreur est loguée en console (comportement actuel)
  And le bouton est réactivé
  And la redirection vers /rapport a lieu quand même (comportement actuel conservé)
```

---

## 3. Modèle de données

### 3.1 État du wizard (mémoire)

```js
/**
 * @typedef {Object} WizardData
 * @property {string} address        // valeur brute de #address (formatted_address Google OU saisie libre)
 * @property {string} postalCode
 * @property {string} city
 * @property {string} placeId        // optionnel, debug/QA
 * @property {'autocomplete'|'manual'} addressSource
 * @property {string} propertyType   // '' | 'appartement' | 'maison' | 'terrain' | 'local-commercial'
 * @property {string} hasTerrain     // '' | 'yes' | 'no'
 * @property {string} terrainSize    // string brute (jamais parsée, comportement actuel)
 * @property {string} surface        // string brute, parsée en Number à la soumission
 * @property {string} rooms
 * @property {string} dpe            // '' | 'A'..'G' | 'unknown'
 * @property {string} dpeRequest     // '' | 'yes' | 'no'
 * @property {string} isOwner        // '' | 'yes' | 'no'
 * @property {string} wantToSell     // '' | 'yes' | 'no' | 'maybe'
 * @property {string} name
 * @property {string} email
 * @property {string} phone
 */

/**
 * @typedef {Object} WizardState
 * @property {number} currentStep     // 1..5
 * @property {number} totalSteps      // 5
 * @property {number} maxStepReached  // reprise après refresh
 * @property {WizardData} data
 * @property {Record<string,string>} errors
 * @property {Record<string,boolean>} touched
 */
```

### 3.2 Mapping vers le payload existant — aucune rupture

À la soumission, produire **exactement** l'objet actuel (mêmes clés, mêmes types) :

```js
{
  id: Date.now(),
  timestamp: new Date().toISOString(),
  propertyType, address, postalCode, city,
  surface: parseFloat(data.surface),
  rooms: parseInt(data.rooms, 10),
  dpe, dpeRequest, isOwner, wantToSell,
  hasTerrain, terrainSize,          // reste une string, comme aujourd'hui
  name, email, phone,
  estimation: calculerEstimation(city, surface, rooms, propertyType, dpe),
}
```

Écrit dans `localStorage.estimationDatabase` (append) et `localStorage.lastEstimation`, sans changement de clé ni de structure.

### 3.3 Persistance intermédiaire — contrainte RGPD

| Donnée | Persistée ? | Justification |
|---|---|---|
| Étapes 1 à 4 (adresse, bien, situation) | **Oui** — `sessionStorage.estimationWizardState`, à chaque changement d'étape validée | Non identifiantes ; survit à un refresh accidentel. `sessionStorage` s'efface à la fermeture de l'onglet. |
| Étape 5 (`name`, `email`, `phone`) | **Non** — mémoire JS uniquement, jamais en storage avant le clic final | Minimisation des données (RGPD art. 5.1.c). Coût UX limité : 3 champs. |
| `estimationWizardState` | Supprimée après soumission réussie | Pas de résidu une fois `lastEstimation` écrite. |

**Dette existante hors scope** : `estimationDatabase`/`lastEstimation` stockent nom/email/téléphone indéfiniment, sans expiration ni consentement. Non modifié par ce lot (contrat `/rapport`), à traiter ultérieurement.

---

## 4. Contrats côté client

Aucun endpoint serveur. Module `src/scripts/estimation-wizard.js` (importé en `?raw` comme les autres scripts).

```js
/** Construit le contrôleur et l'attache au <form>. À appeler après DOMContentLoaded. */
function createWizard(formEl) {}

/**
 * @typedef {Object} WizardController
 * @property {WizardState} state
 * @property {(step:number)=>void} goToStep
 * @property {()=>boolean} next        // valide l'étape courante ; false + reste en place si invalide
 * @property {()=>void} prev
 * @property {(step:number, data:WizardData)=>{valid:boolean, errors:Record<string,string>}} validateStep
 * @property {(name:keyof WizardData, value:string)=>void} updateField
 * @property {()=>object} serializeForSubmit   // formData de §3.2
 * @property {()=>void} persist        // écrit l'état (hors étape 5) en sessionStorage
 * @property {()=>void} restore        // relit sessionStorage, repositionne sur maxStepReached
 */

/**
 * Règles de validation par étape :
 * - step 1: address non vide ; postalCode /^\d{5}$/ ; city non vide
 * - step 2: propertyType requis ; si 'maison' → hasTerrain requis ; si hasTerrain==='yes' → terrainSize > 0
 * - step 3: surface > 0 ; rooms entier >= 1 ; dpe requis (dpeRequest reste OPTIONNEL, comme aujourd'hui)
 * - step 4: isOwner requis ; wantToSell requis
 * - step 5: name requis ; email requis + format valide ; phone requis (pas de regex stricte au Lot 1)
 */

/**
 * Transforme un PlaceResult en champs de formulaire.
 * Ne modifie JAMAIS la valeur affichée dans #address (cf. §0).
 * @returns {{postalCode:string, city:string, placeId:string}|null}  null si address_components absent → fallback manuel (US-3)
 */
function parseGooglePlace(place) {}
```

### Google Places — risque signalé
`google.maps.places.Autocomplete` est le widget **legacy, déprécié par Google en mars 2025** au profit de `PlaceAutocompleteElement`. Les clés existantes fonctionnent toujours. **Ne pas migrer dans ce lot** — inscrit en dette technique (Lot 2).

**Robustesse requise (Lot 1)** : si le script Google Maps échoue à charger (bloqueur, clé absente en preview, réseau), l'étape 1 doit rester utilisable — `#address` fonctionne comme champ texte simple et le bloc manuel CP/ville est révélé automatiquement après un timeout (~3 s) plutôt que de bloquer l'utilisateur avec un « Suivant » inactif.

---

## 5. Composants UI

Réutiliser au maximum `.field`, `.input`, `.select`, `.btn`, `.pill`, `.eyebrow`, `.form-legend`, `.link-arrow`. Minimum de classes nouvelles, même esprit flat (filets 1px, accent orange, pas de radius/shadow).

### 5.1 Indicateur de progression — `.wizard-progress`
```html
<div class="wizard-progress" role="progressbar" aria-valuemin="1" aria-valuemax="5"
     aria-valuenow="1" aria-label="Progression du formulaire d'estimation">
  <ol class="wizard-progress__list">
    <li class="wizard-progress__item" data-state="active" aria-current="step">
      <span class="wizard-progress__num mono">01</span>
      <span class="wizard-progress__label">Adresse</span>
    </li>
    <li class="wizard-progress__item" data-state="upcoming">
      <span class="wizard-progress__num mono">02</span>
      <span class="wizard-progress__label">Type de bien</span>
    </li>
    <!-- 03 Caractéristiques, 04 Situation, 05 Coordonnées -->
  </ol>
</div>
```
CSS : liste horizontale, séparateurs `1px solid var(--border)`, `data-state="active"` en `var(--orange)`, `data-state="done"` avec la puce cochée de `.check-list li::before`.

### 5.2 En-tête d'étape
```html
<legend class="wizard-step__head">
  <span class="eyebrow">Étape 1 sur 5</span>
  <h2>Quelle est l'adresse du bien ?</h2>
  <p class="muted">Nous préremplissons le code postal et la ville pour vous.</p>
</legend>
```

### 5.3 Panneau d'étape
`<fieldset class="wizard-step" data-step="N" hidden>` à l'intérieur du `<form id="estimationForm">` **existant** (un seul formulaire, pas de multi-pages). Le contrôleur bascule `hidden`.

### 5.4 Champ adresse + récapitulatif + fallback manuel
```html
<div class="field">
  <label for="address">Adresse du bien <span class="required">*</span></label>
  <input type="text" id="address" class="input" placeholder="12 rue de la Paix" required
         autocomplete="off" aria-describedby="address-error" />
  <p class="field-error" id="address-error" role="alert" hidden></p>
</div>

<div class="address-recap card card--sand" id="addressRecap" hidden>
  <div class="address-recap__row"><span class="muted">Code postal</span><strong id="addressRecapPostal"></strong></div>
  <div class="address-recap__row"><span class="muted">Ville</span><strong id="addressRecapCity"></strong></div>
  <button type="button" class="link-arrow" id="addressRecapEdit">Ce n'est pas la bonne adresse ?</button>
</div>

<div class="address-manual" id="addressManual" hidden>
  <div class="field-row">
    <div class="field">
      <label for="postalCode">Code postal <span class="required">*</span></label>
      <input type="text" id="postalCode" class="input" placeholder="75001" pattern="[0-9]{5}" required />
    </div>
    <div class="field">
      <label for="city">Ville <span class="required">*</span></label>
      <input type="text" id="city" class="input" placeholder="Paris" required />
    </div>
  </div>
</div>
```

### 5.5 Navigation — `.wizard-nav`
```html
<div class="wizard-nav">
  <button type="button" class="btn btn--outline" id="wizardPrev" hidden>&larr; Précédent</button>
  <button type="button" class="btn btn--primary" id="wizardNext">Suivant &rarr;</button>
  <button type="submit" class="btn btn--primary btn--lg btn--block" id="wizardSubmit" hidden>
    <span>Recevoir mon estimation gratuite</span><span>&rarr;</span>
  </button>
</div>
```

### 5.6 Bannière d'erreur — `.wizard-alert`
`role="alert"`, sur le modèle de `.aside-note` en variante erreur (tokens `--error` / `--error-soft` déjà présents dans `global.css`).

### 5.7 Écran final
Aucun nouvel écran : l'état final reste le bouton submit existant (« Envoi en cours… » puis redirection `/rapport`).

---

## 6. Accessibilité

1. Chaque étape = `<fieldset>` avec `<legend>` contenant le titre (`h2`).
2. `aria-current="step"` sur l'item actif de la progression.
3. `aria-live="polite"` sur `#wizardLiveRegion` (visuellement masqué, classe `.sr-only` à ajouter) → « Étape X sur 5 : {titre} ».
4. `role="alert"` sur `.wizard-alert` pour les échecs de validation.
5. **Focus** : au changement d'étape, focus programmatique sur le `<h2>` (`tabindex="-1"` + `.focus()`), pas sur le premier champ. En cas d'erreur, focus sur le premier champ invalide.
6. `aria-invalid="true"` + `aria-describedby` vers le `.field-error` ; retirés dès correction.
7. **Pas de piège clavier avec Google Places** : le `.pac-container` est injecté hors du DOM du formulaire — vérifier flèches / Entrée / Échap. Conserver et étendre le `preventDefault()` sur `Enter` pour empêcher toute soumission prématurée.
8. Navigation via `<button type="button">` explicites.
9. Respecter `prefers-reduced-motion` (règle déjà en fin de `global.css`) pour toute transition entre étapes.
10. `<label for="...">` conservés pour tous les champs, y compris conditionnels.

---

## 7. Priorisation

### Lot 1 — MVP
- Découpage 5 étapes (§1)
- US-1, US-2, US-3, US-5, US-7, US-8, US-9, US-10 intégralement
- US-6 pour les étapes 1-4 uniquement, sans persistance PII
- Fallback si Google Maps ne charge pas (§4)
- Progression, en-tête d'étape, navigation, bannière d'erreur, focus/aria-live (§5, §6)
- Non-régression stricte du payload et de `/rapport`

### Lot 2 — Nice to have
- Écran récapitulatif avant envoi (étape 6 « Vérifiez vos informations »)
- Analytics par étape (`step_view` / `step_complete` / `step_abandon`) — `CONFIG.ANALYTICS.GA4_MEASUREMENT_ID` existe mais n'est pas consommé
- Migration `Autocomplete` → `PlaceAutocompleteElement`
- Validation stricte du téléphone (regex FR)
- Message dédié pour les adresses hors France
- Politique de rétention `localStorage` (dette RGPD existante)

---

## 8. Décisions tranchées (questions ouvertes du PO)

| Question | Décision |
|---|---|
| 4 ou 5 étapes ? | **5 étapes** (recommandation PO) |
| Adresses hors France | **Hors scope** — `country: "fr"` conservé |
| Écran récapitulatif avant envoi | **Lot 2** |
| Validation du téléphone | **`required` seul**, pas de regex au Lot 1 |
| Durée de vie de la reprise | **`sessionStorage`** (exposition RGPD minimale) |
| Bouton « Suivant » désactivé si l'étape est invalide ? | **Non** — toujours cliquable, validation au clic avec erreur annoncée via `role="alert"`. Un `disabled` sans raison annoncée est un piège d'accessibilité (la cause du blocage est invisible pour un lecteur d'écran). Décision post-revue QA. |
