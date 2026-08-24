// ============================================================================
// RAPPORT — corriger ses informations et relancer le calcul (sans nouveau lead)
// ============================================================================
//
// Mêmes contraintes de forme que `estimation-api.js` et `rapport-report.js` :
// ce fichier est injecté tel quel dans la page (`RawScript.astro` ->
// `<script is:inline>` à partir d'un import `?raw`). Il n'y a ni bundler ni
// résolution de modules ES : PAS de `import`, PAS de `export`. Tout vit dans la
// portée globale, en `var`/`function`, ce qui le rend chargeable dans le
// contexte `vm` de `scripts/test-rapport-edit.mjs`.
//
// Ordre de chargement sur `/rapport` (cf. `rapport.astro`) :
//   pdf-report.js -> rapport-map.js -> estimation-wizard.js
//   -> estimation-api.js -> rapport-report.js -> CE FICHIER
//
// ---------------------------------------------------------------------------
// CE QUE CE MODULE FAIT — ET SURTOUT CE QU'IL NE FAIT PAS
// ---------------------------------------------------------------------------
// Le visiteur qui découvre son rapport constate parfois une saisie fautive :
// 85 m² au lieu de 58, un DPE finalement connu, un état « à rénover » saisi
// trop vite. Jusqu'ici, la seule issue était « Nouvelle estimation », c'est-à-
// dire refaire les cinq étapes ET redonner ses coordonnées — ce qui produisait
// un SECOND lead pour le même bien et le même prospect : un doublon dans la
// boîte du conseiller, une seconde conversion comptée, un prospect rappelé
// deux fois.
//
// Ce module rejoue donc UNIQUEMENT le calcul :
//   - il appelle `POST /v1/estimations`, qui est sans effet de bord et ne
//     reçoit AUCUNE donnée personnelle (cf. `buildEstimationApiPayload`) ;
//   - il n'appelle JAMAIS `POST /v1/leads` ni EmailJS. `lead-api.js` n'est
//     d'ailleurs pas chargé sur cette page : l'envoi d'un lead depuis ici n'est
//     pas seulement interdit par convention, il est impossible ;
//   - il conserve `lead_id`, `id`, `timestamp`, `name`, `email` et `phone` à
//     l'identique, de sorte que le verrou de conversion de `rapport-report.js`
//     (`emb.lead.<id>.tracked`) tienne : recalculer ne recompte pas.
//
// LIMITE ASSUMÉE, À CONNAÎTRE : l'e-mail déjà parti chez le conseiller porte le
// montant d'AVANT correction, et rien ne le met à jour — il n'existe pas
// d'endpoint pour cela. `revision` et `editedFields` sont donc écrits dans
// `lastEstimation` et remontés en mesure (`report_estimation_edited`), ce qui
// permet au moins de repérer les leads dont le chiffre a bougé après coup.
//
// ---------------------------------------------------------------------------
// SOURCE UNIQUE DE VÉRITÉ
// ---------------------------------------------------------------------------
// Aucune règle métier n'est réécrite ici. La conditionnalité vient de
// `isFieldVisible()` (dérivée de `WIZARD_STEPS[].conditionalFields`), la
// validation de `validateStep()`, le corps HTTP de `buildEstimationApiPayload()`
// — toutes déclarées dans `estimation-wizard.js` / `estimation-api.js`. Ce
// fichier n'apporte que l'état d'un formulaire réduit et son rendu.
//
// Périmètre :
//   - `buildReportEditState(lastEstimation)`        pure — lastEstimation -> état éditable
//   - `normalizeReportEditData(data)`               pure — vide les champs devenus invisibles
//   - `computeReportEditVisibility(data)`           pure — quoi afficher
//   - `validateReportEdit(data)`                    pure — étapes 2 et 3 réunies
//   - `diffReportEditFields(previous, next)`        pure — ce qui a changé
//   - `mergeReportEdit(previous, data, estimation, changed)`  pure — nouveau lastEstimation
//   - `replaceInEstimationDatabase(database, payload)`        pure — historique local
//   - `describeReportEdit(lastEstimation)`          pure — « ce qui a été corrigé »

// ============================================================================
// 1. CONSTANTES
// ============================================================================

/**
 * Champs modifiables depuis le rapport : ceux des étapes 2 et 3 du wizard,
 * c'est-à-dire exactement ceux qui entrent dans le calcul.
 *
 * L'ADRESSE en est volontairement absente : changer d'adresse, ce n'est plus
 * corriger une saisie, c'est estimer un AUTRE bien — et un autre bien mérite un
 * autre lead. Le bouton « Nouvelle estimation » du bas de page reste la voie
 * pour cela. Les coordonnées et la situation du demandeur (`isOwner`,
 * `wantToSell`) sont exclues pour la même raison : elles qualifient le lead
 * déjà transmis, pas le bien, et les rejouer ici les désynchroniserait de
 * l'e-mail reçu par le conseiller.
 */
var REPORT_EDIT_FIELDS = [
  "propertyType",
  "hasTerrain",
  "terrainSize",
  "surface",
  "rooms",
  "dpe",
  "floor",
  "hasElevator",
  "outdoor",
  "condition",
];

/**
 * Champs recopiés de `lastEstimation` vers l'état éditable. Les trois premiers
 * ne sont pas modifiables (cf. ci-dessus) mais sont indispensables :
 * `buildEstimationApiPayload` les exige, et l'API refuserait un corps sans
 * adresse. `dpeRequest` suit le DPE dans la cascade de `WIZARD_STEPS`.
 */
var REPORT_EDIT_SOURCE_FIELDS = ["address", "postalCode", "city", "dpeRequest"].concat(
  REPORT_EDIT_FIELDS
);

/** Libellés lisibles, pour le récapitulatif « ce que vous avez modifié ». */
var REPORT_EDIT_LABELS = {
  propertyType: "Type de bien",
  hasTerrain: "Terrain",
  terrainSize: "Surface du terrain",
  surface: "Surface habitable",
  rooms: "Nombre de pièces",
  dpe: "DPE",
  floor: "Étage",
  hasElevator: "Ascenseur",
  outdoor: "Extérieur",
  condition: "État général",
};

// ============================================================================
// 2. ÉTAT ÉDITABLE — fonctions pures
// ============================================================================

/** Valeur de formulaire à partir d'une valeur stockée (nombre ou chaîne). */
function toReportEditString(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Reconstruit un `WizardData` partiel à partir de `lastEstimation`.
 *
 * `lastEstimation` a subi `buildSubmitPayload` : `surface` et `rooms` y sont
 * des `number`, `terrainSize` et `floor` des chaînes. Le formulaire, lui, ne
 * manipule que des chaînes — comme le wizard, dont `validateStep` et
 * `buildEstimationApiPayload` savent l'un comme l'autre parser une saisie
 * brute.
 *
 * @param {object} lastEstimation
 * @returns {object} état éditable, tous champs présents (chaîne vide à défaut)
 */
function buildReportEditState(lastEstimation) {
  var source = lastEstimation || {};
  var data =
    typeof createDefaultWizardData === "function" ? createDefaultWizardData() : {};

  REPORT_EDIT_SOURCE_FIELDS.forEach(function (field) {
    data[field] = toReportEditString(source[field]);
  });

  // Un `lastEstimation` d'une version antérieure peut porter une combinaison
  // que les règles actuelles rendent impossible (ex. un étage sur une maison) :
  // on la nettoie d'emblée plutôt que de l'envoyer à l'API.
  return normalizeReportEditData(data);
}

/**
 * Vide les champs devenus INVISIBLES compte tenu des autres valeurs — l'exact
 * pendant de `applyConditionalResets()` côté wizard, mais dérivé ici de
 * `isFieldVisible()` plutôt que d'une seconde lecture des règles.
 *
 * La boucle est nécessaire : passer d'une maison à un appartement masque
 * `hasTerrain`, ce qui masque à son tour `terrainSize`, qui ne dépend pas
 * directement de `propertyType`. Elle est bornée par le nombre de champs, une
 * cascade ne pouvant pas être plus longue que cela.
 *
 * @param {object} data
 * @returns {object} copie normalisée (l'entrée n'est jamais mutée)
 */
function normalizeReportEditData(data) {
  var next = Object.assign({}, data || {});
  if (typeof isFieldVisible !== "function") return next;

  var passes = 0;
  var changed = true;

  while (changed && passes < REPORT_EDIT_FIELDS.length) {
    changed = false;
    passes += 1;
    REPORT_EDIT_FIELDS.forEach(function (field) {
      if (next[field] !== "" && !isFieldVisible(field, next)) {
        next[field] = "";
        changed = true;
      }
    });
  }

  return next;
}

/**
 * Visibilité de chaque champ éditable, plus celle du bloc « précisions
 * facultatives » qui disparaît quand aucun de ses champs ne s'applique (terrain
 * nu, local commercial).
 *
 * @param {object} data
 * @returns {Record<string,boolean>} avec la clé additionnelle `_optional`
 */
function computeReportEditVisibility(data) {
  var visibility = {};
  REPORT_EDIT_FIELDS.forEach(function (field) {
    visibility[field] =
      typeof isFieldVisible === "function" ? isFieldVisible(field, data || {}) : true;
  });

  visibility._optional =
    visibility.floor || visibility.hasElevator || visibility.outdoor || visibility.condition;

  return visibility;
}

// ============================================================================
// 3. VALIDATION — fonction pure
// ============================================================================

/**
 * Valide l'état éditable en réunissant les étapes 2 et 3 du wizard.
 *
 * Le formulaire du rapport affiche les deux d'un coup ; les RÈGLES, elles,
 * restent celles de `validateStep` — un seuil de surface écrit ici finirait
 * par diverger de celui du tunnel, et le visiteur verrait deux messages
 * différents pour la même saisie.
 *
 * @param {object} data
 * @returns {{valid:boolean, errors:Record<string,string>}}
 */
function validateReportEdit(data) {
  if (typeof validateStep !== "function") return { valid: true, errors: {} };

  var errors = Object.assign(
    {},
    validateStep(2, data).errors,
    validateStep(3, data).errors
  );

  return { valid: Object.keys(errors).length === 0, errors: errors };
}

// ============================================================================
// 4. DIFFÉRENTIEL ET FUSION — fonctions pures
// ============================================================================

/**
 * Champs éditables dont la valeur a changé. Comparaison sur chaîne nettoyée :
 * « 85 » et « 85 » saisis à nouveau ne comptent pas comme une modification, et
 * un espace de bord non plus.
 *
 * @param {object} previous état de départ
 * @param {object} next état du formulaire
 * @returns {string[]} noms de champs, dans l'ordre de `REPORT_EDIT_FIELDS`
 */
function diffReportEditFields(previous, next) {
  var before = previous || {};
  var after = next || {};

  return REPORT_EDIT_FIELDS.filter(function (field) {
    return toReportEditString(before[field]).trim() !== toReportEditString(after[field]).trim();
  });
}

/**
 * Produit le `lastEstimation` mis à jour après un recalcul réussi.
 *
 * TOUT CE QUI IDENTIFIE LE LEAD EST PRÉSERVÉ par la copie de `previous` :
 * `id`, `timestamp`, `lead_id`, `name`, `email`, `phone`, l'adresse et la
 * situation du demandeur. C'est cette préservation, et elle seule, qui garantit
 * qu'un recalcul ne crée pas un second lead ni une seconde conversion — le
 * verrou de `rapport-report.js` porte sur `lead_id`.
 *
 * @param {object} previous `lastEstimation` en place
 * @param {object} data état éditable validé
 * @param {object} estimation résultat de `mapApiResultToLegacyEstimation`
 * @param {string[]} changedFields cf. `diffReportEditFields`
 * @param {string} [updatedAt] horodatage ISO (injectable pour les tests)
 * @returns {object} nouveau `lastEstimation`
 */
function mergeReportEdit(previous, data, estimation, changedFields, updatedAt) {
  var updated = Object.assign({}, previous || {});
  var d = data || {};

  updated.propertyType = d.propertyType;
  updated.dpe = d.dpe;
  updated.hasTerrain = d.hasTerrain;
  updated.terrainSize = d.terrainSize; // reste une chaîne, comme à la soumission
  updated.floor = d.floor;
  updated.hasElevator = d.hasElevator;
  updated.outdoor = d.outdoor;
  updated.condition = d.condition;

  // `surface` et `rooms` sont des `number` dans `lastEstimation` (cf.
  // `buildSubmitPayload`) : le rapport et le PDF les formatent comme tels.
  updated.surface = parseFloat(d.surface);
  updated.rooms = parseInt(d.rooms, 10);

  updated.estimation = estimation;
  updated.estimationStatus = "ok";

  // Traçabilité de la correction. `revision` sert de clé de déduplication à
  // l'événement de mesure, exactement comme `lead_id` pour la conversion.
  updated.revision = (Number(updated.revision) || 0) + 1;
  updated.editedFields = (changedFields || []).join("|");
  updated.updatedAt = updatedAt || new Date().toISOString();

  return updated;
}

/**
 * Remplace l'entrée de même `id` dans l'historique local `estimationDatabase`,
 * ou l'ajoute si elle n'y figure pas (localStorage partiellement purgé).
 * Ne mute pas le tableau reçu.
 *
 * @param {Array<object>} database
 * @param {object} payload
 * @returns {Array<object>}
 */
function replaceInEstimationDatabase(database, payload) {
  var list = Array.isArray(database) ? database.slice() : [];
  var target = payload || {};

  for (var i = 0; i < list.length; i++) {
    if (list[i] && target.id !== undefined && list[i].id === target.id) {
      list[i] = target;
      return list;
    }
  }

  list.push(target);
  return list;
}

// ============================================================================
// 5. RÉCAPITULATIF DE LA CORRECTION — fonction pure
// ============================================================================

/**
 * Phrase affichée en tête du rapport quand celui-ci a déjà été recalculé :
 * dire que le chiffre a changé, et sur quelle correction.
 *
 * Rendre ce fait VISIBLE n'est pas cosmétique. Le PDF téléchargé, l'e-mail reçu
 * par le conseiller et l'écran peuvent désormais porter trois montants
 * différents ; le visiteur doit au moins savoir que celui qu'il a sous les yeux
 * est le plus récent, et pourquoi.
 *
 * @param {object} lastEstimation
 * @returns {string} phrase prête à afficher, "" si le rapport n'a jamais été corrigé
 */
function describeReportEdit(lastEstimation) {
  var source = lastEstimation || {};
  var revision = Number(source.revision) || 0;
  if (revision <= 0) return "";

  var labels = String(source.editedFields || "")
    .split("|")
    .filter(function (field) {
      return REPORT_EDIT_LABELS[field];
    })
    .map(function (field) {
      return REPORT_EDIT_LABELS[field];
    });

  var phrase =
    revision === 1
      ? "Estimation recalculée après correction de vos informations"
      : "Estimation recalculée " + revision + " fois après correction de vos informations";

  if (labels.length) {
    phrase += " — dernière modification : " + labels.join(", ");
  }

  return phrase + ".";
}

// ============================================================================
// 6. CÂBLAGE DOM — protégé, ne s'exécute que si #reportEditForm existe
// ============================================================================

var reportEditFormEl =
  typeof document !== "undefined" ? document.getElementById("reportEditForm") : null;

if (reportEditFormEl) {
  /** Lecture défensive du rapport en place. `null` si illisible. */
  var reportEditSource = (function () {
    try {
      return JSON.parse(localStorage.getItem("lastEstimation"));
    } catch (error) {
      return null;
    }
  })();

  // `rapport-report.js`, chargé juste avant, a déjà renvoyé le visiteur vers
  // `/estimation/` dans ce cas : il n'y a rien à modifier.
  if (reportEditSource) {
    var reportEditToggleEl = document.getElementById("reportEditToggle");
    var reportEditStatusEl = document.getElementById("reportEditStatus");
    var reportEditSubmitEl = document.getElementById("reportEditSubmit");
    var reportEditCancelEl = document.getElementById("reportEditCancel");
    var reportEditOptionalEl = document.getElementById("reportEditOptional");

    /** État initial, figé : il sert de référence au différentiel. */
    var reportEditInitial = buildReportEditState(reportEditSource);
    var reportEditData = Object.assign({}, reportEditInitial);
    var reportEditInFlight = false;
    var reportEditIdleLabel = reportEditSubmitEl ? reportEditSubmitEl.innerHTML : "";

    // ------------------------------------------------------------------
    // Rendu
    // ------------------------------------------------------------------

    function reportEditField(name) {
      return document.getElementById(name);
    }

    function reportEditGroup(name) {
      return document.getElementById(name + "Group");
    }

    /** Reporte l'état sur les `<input>`/`<select>` (jamais l'inverse). */
    function reportEditHydrate() {
      REPORT_EDIT_FIELDS.forEach(function (name) {
        var input = reportEditField(name);
        if (input) input.value = reportEditData[name];
      });
      reportEditSyncVisibility();
    }

    /**
     * Applique la visibilité au DOM. Les champs masqués sont aussi VIDÉS
     * visuellement : `normalizeReportEditData` a déjà vidé la donnée, et un
     * `<select>` qui garderait « Oui » sous un bloc replié réapparaîtrait
     * renseigné au prochain changement de type de bien.
     */
    function reportEditSyncVisibility() {
      var visibility = computeReportEditVisibility(reportEditData);

      REPORT_EDIT_FIELDS.forEach(function (name) {
        var group = reportEditGroup(name);
        if (group) group.hidden = !visibility[name];

        if (!visibility[name]) {
          var input = reportEditField(name);
          if (input) input.value = "";
        }
      });

      if (reportEditOptionalEl) reportEditOptionalEl.hidden = !visibility._optional;
    }

    function reportEditClearErrors() {
      REPORT_EDIT_FIELDS.forEach(function (name) {
        var input = reportEditField(name);
        var errorEl = document.getElementById(name + "-error");
        if (input) input.removeAttribute("aria-invalid");
        if (errorEl) {
          errorEl.hidden = true;
          errorEl.textContent = "";
        }
      });
    }

    /**
     * Affiche les erreurs de TOUS les champs éditables — et non ceux d'une
     * seule étape, comme le fait `renderErrors()` du wizard : ici les étapes 2
     * et 3 sont à l'écran en même temps.
     *
     * @returns {boolean} true si au moins une erreur porte sur un champ affiché
     */
    function reportEditRenderErrors(errors) {
      reportEditClearErrors();
      var placed = false;
      var first = null;

      REPORT_EDIT_FIELDS.forEach(function (name) {
        var message = errors && errors[name];
        if (!message) return;

        var input = reportEditField(name);
        var errorEl = document.getElementById(name + "-error");
        if (input) input.setAttribute("aria-invalid", "true");
        if (errorEl) {
          errorEl.hidden = false;
          errorEl.textContent = message;
        }
        placed = true;
        if (!first) first = input;
      });

      if (first && typeof first.focus === "function") first.focus();
      return placed;
    }

    /**
     * Message d'état du formulaire. `tone` pilote la couleur ; le rôle
     * `status` du conteneur suffit à l'annoncer aux lecteurs d'écran sans
     * voler le focus.
     */
    function reportEditSetStatus(message, tone) {
      if (!reportEditStatusEl) return;
      if (!message) {
        reportEditStatusEl.hidden = true;
        reportEditStatusEl.textContent = "";
        return;
      }
      reportEditStatusEl.textContent = message;
      reportEditStatusEl.setAttribute("data-tone", tone || "info");
      reportEditStatusEl.hidden = false;
    }

    function reportEditSetBusy(busy) {
      if (!reportEditSubmitEl) return;
      reportEditSubmitEl.disabled = busy;
      if (busy) {
        reportEditSubmitEl.innerHTML = "<span>Recalcul en cours…</span>";
        reportEditSubmitEl.setAttribute("aria-busy", "true");
      } else {
        reportEditSubmitEl.innerHTML = reportEditIdleLabel;
        reportEditSubmitEl.removeAttribute("aria-busy");
      }
    }

    /** Rend la main au visiteur : bouton réactivé ET drapeau relâché. */
    function reportEditRelease() {
      reportEditInFlight = false;
      reportEditSetBusy(false);
    }

    // ------------------------------------------------------------------
    // Ouverture / fermeture
    // ------------------------------------------------------------------

    function reportEditOpen(open) {
      reportEditFormEl.hidden = !open;
      if (reportEditToggleEl) {
        reportEditToggleEl.setAttribute("aria-expanded", open ? "true" : "false");
        reportEditToggleEl.textContent = open
          ? "Annuler la modification"
          : "Modifier mes informations";
      }
      if (open) {
        var first = reportEditField("propertyType");
        if (first && typeof first.focus === "function") first.focus();
      }
    }

    if (reportEditToggleEl) {
      reportEditToggleEl.addEventListener("click", function () {
        var willOpen = reportEditFormEl.hidden;
        if (!willOpen) {
          // Fermer, c'est renoncer : on repart de l'état enregistré plutôt que
          // de garder une saisie à moitié faite pour la prochaine ouverture.
          reportEditData = Object.assign({}, reportEditInitial);
          reportEditClearErrors();
          reportEditSetStatus("", "info");
          reportEditHydrate();
        }
        reportEditOpen(willOpen);
      });
    }

    if (reportEditCancelEl) {
      reportEditCancelEl.addEventListener("click", function () {
        reportEditData = Object.assign({}, reportEditInitial);
        reportEditClearErrors();
        reportEditSetStatus("", "info");
        reportEditHydrate();
        reportEditOpen(false);
        if (reportEditToggleEl && typeof reportEditToggleEl.focus === "function") {
          reportEditToggleEl.focus();
        }
      });
    }

    // ------------------------------------------------------------------
    // Saisie
    // ------------------------------------------------------------------

    REPORT_EDIT_FIELDS.forEach(function (name) {
      var input = reportEditField(name);
      if (!input) return;

      var eventName = input.tagName === "SELECT" ? "change" : "input";
      input.addEventListener(eventName, function () {
        reportEditData[name] = input.value;
        reportEditData = normalizeReportEditData(reportEditData);

        var errorEl = document.getElementById(name + "-error");
        if (errorEl) {
          errorEl.hidden = true;
          errorEl.textContent = "";
        }
        input.removeAttribute("aria-invalid");

        reportEditSyncVisibility();
      });
    });

    // ------------------------------------------------------------------
    // Recalcul
    // ------------------------------------------------------------------

    /** `CONFIG.API` défensif (la clé peut manquer sur une preview sans .env). */
    function reportEditApiConfig() {
      return typeof CONFIG !== "undefined" && CONFIG.API ? CONFIG.API : {};
    }

    function reportEditSubmit() {
      if (reportEditInFlight) return;

      var validation = validateReportEdit(reportEditData);
      if (!validation.valid) {
        var placed = reportEditRenderErrors(validation.errors);
        reportEditSetStatus(
          placed
            ? "Certaines informations doivent être corrigées."
            : "Certaines informations doivent être corrigées avant de relancer le calcul.",
          "error"
        );
        return;
      }

      var changedFields = diffReportEditFields(reportEditInitial, reportEditData);
      if (!changedFields.length) {
        // Un appel API et un rechargement de page pour un résultat identique,
        // c'est un quota consommé pour rien — et une seconde d'attente offerte
        // au visiteur en échange de rien.
        reportEditSetStatus(
          "Aucune modification à recalculer : les informations sont inchangées.",
          "info"
        );
        return;
      }

      reportEditClearErrors();
      reportEditInFlight = true;
      reportEditSetBusy(true);
      reportEditSetStatus(
        "Nouveau calcul à partir des ventes réelles de votre secteur…",
        "info"
      );

      requestEstimation(
        buildEstimationApiPayload(reportEditData),
        { baseUrl: reportEditApiConfig().BASE_URL },
        function (response) {
          try {
            reportEditFinalize(response, changedFields);
          } catch (error) {
            // `requestEstimation` avale les exceptions de son callback : sans
            // ce filet, une erreur imprévue laisserait le formulaire
            // définitivement bloqué sur « Recalcul en cours… ».
            console.error("Erreur pendant le recalcul :", error);
            reportEditRelease();
            reportEditSetStatus(
              "Une erreur inattendue est survenue. Vous pouvez réessayer.",
              "error"
            );
          }
        }
      );
    }

    /**
     * Suite du recalcul, une fois l'API retournée.
     *
     * RÈGLE : on ne remplace le rapport en place QUE par un calcul réussi. Un
     * échec laisse `lastEstimation` intact — dégrader en `static-fallback` une
     * estimation fondée sur des transactions réelles parce que le réseau a
     * hoqueté serait une régression silencieuse du rapport déjà affiché, et le
     * visiteur n'a rien demandé de tel : il a demandé une CORRECTION.
     */
    function reportEditFinalize(response, changedFields) {
      if (response.status === "invalid") {
        reportEditRelease();
        // `requestEstimation` a déjà traduit le corps 422 en
        // `Record<champ, message>` via `mapApiErrorToFieldErrors` : les noms
        // sont ceux du wizard, donc ceux des `#id` de ce formulaire.
        var placed = reportEditRenderErrors(response.errors || {});
        reportEditSetStatus(
          placed
            ? "Certaines informations doivent être corrigées."
            : response.message || "Certaines informations doivent être corrigées.",
          "error"
        );
        return;
      }

      if (response.status === "rate-limited") {
        reportEditRelease();
        reportEditSetStatus(
          response.message ||
            "Trop de demandes depuis votre connexion. Réessayez dans quelques instants.",
          "error"
        );
        return;
      }

      var estimation =
        response.status === "ok" ? mapApiResultToLegacyEstimation(response.result) : null;

      if (!estimation) {
        reportEditRelease();
        reportEditSetStatus(
          "Nos données de transactions n'ont pas pu être consultées. Votre rapport " +
            "actuel reste affiché ; réessayez dans quelques minutes.",
          "error"
        );
        return;
      }

      var updated = mergeReportEdit(
        reportEditSource,
        reportEditData,
        estimation,
        changedFields
      );

      try {
        localStorage.setItem("lastEstimation", JSON.stringify(updated));

        var database = [];
        try {
          database = JSON.parse(localStorage.getItem("estimationDatabase") || "[]");
        } catch (error) {
          database = [];
        }
        localStorage.setItem(
          "estimationDatabase",
          JSON.stringify(replaceInEstimationDatabase(database, updated))
        );
      } catch (error) {
        // Sans écriture, le rechargement réafficherait l'ancien rapport : mieux
        // vaut le dire que de laisser croire à un recalcul sans effet.
        console.error("Impossible d'enregistrer l'estimation :", error);
        reportEditRelease();
        reportEditSetStatus(
          "Le nouveau calcul n'a pas pu être enregistré dans votre navigateur.",
          "error"
        );
        return;
      }

      // Rechargement plutôt que re-rendu : `rapport-report.js` construit la
      // page entière (détails, bandeaux, comparables, méthodologie, carte) au
      // chargement, et la mesure de l'édition est émise là-bas — au chargement
      // SUIVANT, pas au bord de cette navigation (cf. son en-tête). Le drapeau
      // reste volontairement à `true` : la navigation n'est pas instantanée.
      window.location.reload();
    }

    reportEditFormEl.addEventListener("submit", function (e) {
      if (e && typeof e.preventDefault === "function") e.preventDefault();
      reportEditSubmit();
    });

    // ------------------------------------------------------------------
    // Rapport déjà corrigé : bandeau, et mesure de la correction
    // ------------------------------------------------------------------

    var reportEditNoticeEl = document.getElementById("reportEditNotice");
    var reportEditNotice = describeReportEdit(reportEditSource);

    if (reportEditNoticeEl && reportEditNotice) {
      reportEditNoticeEl.textContent = reportEditNotice;
      reportEditNoticeEl.hidden = false;
    }

    /**
     * `report_estimation_edited` — émis ICI, au chargement qui SUIT le
     * recalcul, et non juste avant le `reload()`.
     *
     * C'est le même raisonnement que pour la conversion dans
     * `rapport-report.js` : un événement poussé au bord d'une navigation est
     * une course avec le navigateur, que le conteneur de tags perd une fois
     * sur deux. Et comme la page est réatteignable (rechargement, retour
     * arrière), il faut le même verrou — porté ici par le couple
     * `lead_id` + `revision`, qui ne se répète jamais.
     */
    (function mesurerCorrection() {
      if (typeof embTrack !== "function") return;

      var leadId = reportEditSource.lead_id || "";
      var revision = Number(reportEditSource.revision) || 0;

      // Sans `lead_id` (parcours antérieur au lot T1), pas de clé de verrou
      // stable : mieux vaut ne rien compter que compter à chaque rechargement.
      if (!leadId || revision <= 0) return;

      var cleVerrou = "emb.lead." + leadId + ".rev." + revision;
      try {
        if (localStorage.getItem(cleVerrou) === "1") return;
      } catch (error) {
        /* stockage indisponible : on préfère un événement en trop à zéro. */
      }

      function pousser() {
        embTrack("report_estimation_edited", {
          lead_id: leadId,
          estimation_revision: revision,
          // Des NOMS de champs, jamais leur contenu.
          changed_fields: String(reportEditSource.editedFields || ""),
          estimation_status: reportEditSource.estimationStatus,
        });
        try {
          localStorage.setItem(cleVerrou, "1");
        } catch (error) {
          /* voir plus haut */
        }
      }

      if (typeof embAttendreConsentement === "function") {
        embAttendreConsentement().then(pousser, pousser);
      } else {
        pousser();
      }
    })();

    // Amorçage : le formulaire part de l'état enregistré, replié.
    reportEditHydrate();
    reportEditOpen(false);

    // Le visiteur revient par le bfcache après le rechargement : le bouton
    // pouvait être resté sur « Recalcul en cours… » au moment du gel.
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("pageshow", function (e) {
        if (!e || !e.persisted) return;
        reportEditRelease();
        reportEditSetStatus("", "info");
      });
    }
  }
}
