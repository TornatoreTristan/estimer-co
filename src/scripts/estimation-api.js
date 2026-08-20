// ============================================================================
// ESTIMATION API — client de `POST /v1/estimations` (Lot 3)
// ============================================================================
//
// Mêmes contraintes de forme que `estimation-wizard.js` : ce fichier est
// injecté tel quel dans la page (`RawScript.astro` -> `<script is:inline>` à
// partir d'un import `?raw`). Il n'y a ni bundler ni résolution de modules ES :
// PAS de `import`, PAS de `export`. Tout vit dans la portée globale, en
// `var`/`function`, ce qui le rend chargeable dans le contexte `vm` de
// `scripts/test-estimation-api.mjs`.
//
// Il doit être chargé AVANT `estimation-ui.js` (qui le consomme) et peut l'être
// indépendamment du wizard : `/rapport` s'en sert pour le bouton « Relancer le
// calcul » du mode dégradé.
//
// Périmètre :
//   - `buildEstimationApiPayload(data)`      pure — wizard.state.data -> corps HTTP
//   - `mapApiErrorToFieldErrors(apiError)`   pure — 422 -> wizard.state.errors
//   - `mapApiResultToLegacyEstimation(r)`    pure — DTO API -> contrat historique
//   - `resolveEstimationStatus(res, config)` pure — statut final de lastEstimation
//   - `requestEstimation(payload, options, callback)`  IMPURE (fetch) — ne rejette jamais
//
// RGPD / §2.6 : `buildEstimationApiPayload` ne transmet JAMAIS `name`, `email`
// ni `phone`. Ces champs restent côté front (EmailJS). L'API les refuse
// d'ailleurs explicitement (422 `forbidden_pii`), et cette garantie est
// couverte par un test dédié.

// ============================================================================
// 1. CONSTANTES
// ============================================================================

/** Chemin de l'endpoint d'estimation (versionné, cf. §6.1). */
var ESTIMATION_API_PATH = "/v1/estimations";

/** Timeout par tentative (§2.4, étape 1). */
var ESTIMATION_API_TIMEOUT_MS = 6000;

/** Backoff avant l'unique retry (§2.4, étape 1). */
var ESTIMATION_API_RETRY_DELAY_MS = 1500;

/**
 * Nombre maximum de tentatives : 1 appel + 1 retry. Le retry n'a lieu que sur
 * erreur réseau, timeout ou 5xx — JAMAIS sur 4xx (une requête invalide le
 * restera, et un 429 doit être respecté, pas contourné).
 */
var ESTIMATION_API_MAX_ATTEMPTS = 2;

/**
 * Champs du wizard interdits à l'API (§2.6, point 1). Listés explicitement
 * plutôt qu'implicitement « non copiés » : un test vérifie cette liste, donc
 * ajouter un champ PII au wizard sans y penser reste détecté.
 */
var ESTIMATION_API_FORBIDDEN_FIELDS = ["name", "email", "phone"];

/** Valeurs acceptées par l'API pour `outdoor` (§6.1). */
var ESTIMATION_API_OUTDOOR_VALUES = ["none", "balcony", "terrace", "garden"];

/** Valeurs acceptées par l'API pour `condition` (§6.1). */
var ESTIMATION_API_CONDITION_VALUES = ["to-renovate", "fair", "good", "new"];

/** Classes DPE acceptées par l'API (§6.1). */
var ESTIMATION_API_DPE_VALUES = ["A", "B", "C", "D", "E", "F", "G", "unknown"];

/** Types de bien acceptés par l'API (§6.1). */
var ESTIMATION_API_PROPERTY_TYPES = [
  "appartement",
  "maison",
  "terrain",
  "local-commercial",
];

// ============================================================================
// 2. PAYLOAD — fonction pure
// ============================================================================

/** Nombre fini à partir d'une saisie brute (string du wizard ou number). `null` sinon. */
function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  var parsed = typeof value === "number" ? value : parseFloat(String(value).replace(",", "."));
  return isFinite(parsed) ? parsed : null;
}

/** Entier à partir d'une saisie brute. `null` si la valeur n'est pas un entier exploitable. */
function toFiniteInteger(value) {
  var parsed = toFiniteNumber(value);
  if (parsed === null) return null;
  var rounded = Math.round(parsed);
  return rounded === parsed ? rounded : null;
}

/**
 * Construit le corps de `POST /v1/estimations` à partir de `wizard.state.data`.
 * Fonction pure : ne lit rien du DOM, ne fait aucun appel réseau.
 *
 * Règles :
 * - Ne transmet JAMAIS `name`, `email`, `phone` (§2.6) — l'API répond 422.
 * - Les champs optionnels ABSENTS ne sont pas envoyés du tout : la validation
 *   VineJS est stricte, une chaîne vide sur une énumération vaudrait 422 alors
 *   que l'utilisateur n'a simplement rien renseigné (§7.1, tous optionnels).
 * - Les champs conditionnels ne sont transmis que si la règle de visibilité de
 *   `WIZARD_STEPS[].conditionalFields` est satisfaite — on interroge
 *   `isFieldVisible()` (source unique de vérité) plutôt que de redéclarer
 *   « l'étage n'existe que pour un appartement » ici.
 *
 * @param {object} data `wizard.state.data`
 * @returns {object} corps JSON prêt à sérialiser
 */
function buildEstimationApiPayload(data) {
  var d = data || {};

  /**
   * Un champ conditionnel n'est transmis que s'il est visible. Quand
   * `isFieldVisible` n'est pas chargé (ce module peut vivre seul sur
   * `/rapport`, sans `estimation-wizard.js`), on se rabat sur « visible » :
   * les données proviennent alors d'un `lastEstimation` déjà validé.
   */
  function visible(fieldName) {
    if (typeof isFieldVisible !== "function") return true;
    return isFieldVisible(fieldName, d);
  }

  var payload = {
    address: String(d.address || "").trim(),
    postalCode: String(d.postalCode || "").trim(),
    city: String(d.city || "").trim(),
  };

  if (ESTIMATION_API_PROPERTY_TYPES.indexOf(d.propertyType) !== -1) {
    payload.propertyType = d.propertyType;
  }

  var surface = toFiniteNumber(d.surface);
  if (surface !== null) payload.surface = surface;

  var rooms = toFiniteInteger(d.rooms);
  if (rooms !== null) payload.rooms = rooms;

  payload.dpe = ESTIMATION_API_DPE_VALUES.indexOf(d.dpe) !== -1 ? d.dpe : "unknown";

  // --- Champs optionnels de l'étape 3 (§7.1) --------------------------------

  if (visible("floor")) {
    var floor = toFiniteInteger(d.floor);
    if (floor !== null && floor >= 0) payload.floor = floor;
  }

  if (visible("hasElevator")) {
    // '' (non répondu) et 'unknown' (« je ne sais pas ») ne sont pas des
    // booléens : on n'envoie rien plutôt que d'affirmer « pas d'ascenseur ».
    if (d.hasElevator === "yes") payload.hasElevator = true;
    else if (d.hasElevator === "no") payload.hasElevator = false;
  }

  if (visible("outdoor") && ESTIMATION_API_OUTDOOR_VALUES.indexOf(d.outdoor) !== -1) {
    payload.outdoor = d.outdoor;
  }

  if (visible("condition") && ESTIMATION_API_CONDITION_VALUES.indexOf(d.condition) !== -1) {
    payload.condition = d.condition;
  }

  // Terrain : la question n'est posée que pour une maison, et la surface n'a
  // de sens que si l'utilisateur a répondu « oui ».
  if (d.hasTerrain !== "no" && visible("terrainSize")) {
    var terrainSize = toFiniteNumber(d.terrainSize);
    if (terrainSize !== null && terrainSize > 0) payload.terrainSize = terrainSize;
  }

  return payload;
}

// ============================================================================
// 3. ERREURS DE VALIDATION — fonction pure
// ============================================================================

/**
 * Convertit une réponse 422 (`{ code:'VALIDATION_ERROR', errors:[{field, rule,
 * message}] }`) en `Record<champ, message>` directement assignable à
 * `wizard.state.errors`.
 *
 * Les noms de champ de l'API sont ALIGNÉS sur ceux du wizard (`address`,
 * `postalCode`, `city`, `propertyType`, `surface`, `rooms`, `dpe`, `floor`,
 * `hasElevator`, `outdoor`, `condition`, `terrainSize`) : il n'y a donc
 * volontairement AUCUNE table de correspondance à maintenir ici — seul un
 * éventuel préfixe de chemin VineJS (`body.address`) est retiré. Un champ
 * inconnu du wizard (`lat`, `lon`, ou un champ PII refusé) est rangé sous
 * `_form` pour rester affichable en bannière plutôt que d'être perdu.
 *
 * @param {object} apiError corps de la réponse d'erreur, déjà parsé
 * @returns {Record<string,string>}
 */
function mapApiErrorToFieldErrors(apiError) {
  var errors = {};
  if (!apiError || typeof apiError !== "object") return errors;

  var list = apiError.errors || apiError.messages;
  if (!Array.isArray(list)) return errors;

  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (!item || typeof item !== "object") continue;

    var field = String(item.field || item.fieldName || "").trim();
    var message = String(item.message || "").trim();
    if (!message) continue;

    // VineJS peut préfixer le chemin (`body.address`, `data.surface`).
    var dot = field.lastIndexOf(".");
    if (dot !== -1) field = field.slice(dot + 1);

    // Les champs PII sont des champs du wizard (étape 5) mais ne sont JAMAIS
    // envoyés à l'API : une erreur portant leur nom trahit un bug de notre
    // côté, pas une saisie fautive. On ne va donc pas l'afficher sous le champ
    // « Nom » de l'utilisateur, qui n'y peut rien.
    var isForbidden = ESTIMATION_API_FORBIDDEN_FIELDS.indexOf(field) !== -1;
    var key = field && !isForbidden && isKnownWizardField(field) ? field : "_form";
    // Premier message conservé : c'est le plus spécifique côté VineJS.
    if (!errors[key]) errors[key] = message;
  }

  return errors;
}

/**
 * Un champ porte-t-il un `#id` dans le formulaire du wizard ? On s'appuie sur
 * `WIZARD_STEPS` quand il est chargé (source unique de vérité) et, à défaut,
 * sur une liste de repli minimale pour rester utilisable hors `/estimation`.
 */
function isKnownWizardField(fieldName) {
  if (typeof WIZARD_STEPS !== "undefined" && Array.isArray(WIZARD_STEPS)) {
    for (var i = 0; i < WIZARD_STEPS.length; i++) {
      if (WIZARD_STEPS[i].fields.indexOf(fieldName) !== -1) return true;
    }
    return false;
  }
  return (
    [
      "address",
      "postalCode",
      "city",
      "propertyType",
      "surface",
      "rooms",
      "dpe",
      "floor",
      "hasElevator",
      "outdoor",
      "condition",
      "terrainSize",
    ].indexOf(fieldName) !== -1
  );
}

// ============================================================================
// 4. DTO API -> CONTRAT HISTORIQUE `estimation` (§5.4) — fonction pure
// ============================================================================

/**
 * Mappe un `EstimationResult` (§5.3) vers l'objet `estimation` attendu par
 * `rapport-report.js` et `pdf-report.js`.
 *
 * NON-RÉGRESSION CRITIQUE (US-11) : `prixM2`, `estimationMin`, `estimationMax`
 * et `estimationMoyenne` sont conservés — mêmes noms, même niveau, type
 * `number`. Tout le reste (`confidence`, `range`, `method`, `comparables`,
 * `location`, `dataSource`, `display`, `computedAt`, `apiVersion`) est
 * ADDITIONNEL : les lecteurs doivent tolérer son absence.
 *
 * @param {object} result
 * @returns {object|null} `null` si l'API n'a pas produit de valeur
 *   (`method.kind === 'not-supported'`) — l'appelant bascule alors en mode
 *   « estimation différée ».
 */
function mapApiResultToLegacyEstimation(result) {
  if (!result || typeof result !== "object") return null;
  if (result.value === null || result.value === undefined) return null;

  var range = result.range || {};

  return {
    // --- contrat historique, inchangé ---
    prixM2: Math.round(Number(result.pricePerSqm) || 0),
    estimationMin: Math.round(Number(range.low) || 0),
    estimationMax: Math.round(Number(range.high) || 0),
    estimationMoyenne: Math.round(Number(result.value) || 0),
    // --- ajouts, tous optionnels côté lecteurs (US-11) ---
    confidence: result.confidence,
    display: result.display,
    range: result.range,
    method: result.method,
    comparables: Array.isArray(result.comparables) ? result.comparables : [],
    location: result.location,
    dataSource: result.dataSource,
    computedAt: result.computedAt,
    apiVersion: result.apiVersion,
  };
}

// ============================================================================
// 5. STATUT FINAL — fonction pure
// ============================================================================

/**
 * Décide du `estimationStatus` à écrire dans `lastEstimation`.
 *
 * DÉCISION CLIENT (elle prime sur le §2.4 d'origine) : le repli affiche
 * TOUJOURS un prix. `PUBLIC_ESTIMATION_FALLBACK` vaut donc `'static'` par
 * défaut, et un échec d'API produit `'static-fallback'` — jamais un écran sans
 * chiffre. Le mode `'deferred'` (§2.4) reste implémenté pour deux cas qui, eux,
 * ne relèvent pas d'une panne :
 *   - `PUBLIC_ESTIMATION_FALLBACK=none` (choix de déploiement explicite) ;
 *   - l'API a répondu 200 mais sans valeur (`method.kind = 'not-supported'`,
 *     ex. local commercial, §3.2) : là, c'est l'API qui dit « je ne sais pas ».
 *
 * Les échecs de VALIDATION (`invalid`, 422 / adresse introuvable) ne passent
 * jamais par ici : une donnée invalide ne doit produire aucune estimation, le
 * front renvoie l'utilisateur sur le champ fautif.
 *
 * @param {object} apiResponse cf. `requestEstimation`
 * @param {{FALLBACK?:string}} [config] typiquement `CONFIG.API`
 * @returns {'ok'|'deferred'|'static-fallback'}
 */
function resolveEstimationStatus(apiResponse, config) {
  var response = apiResponse || {};
  var fallback = config && config.FALLBACK ? String(config.FALLBACK) : "static";

  if (response.status === "ok") {
    var hasValue =
      response.result &&
      response.result.value !== null &&
      response.result.value !== undefined;
    return hasValue ? "ok" : "deferred";
  }

  return fallback === "static" ? "static-fallback" : "deferred";
}

// ============================================================================
// 6. APPEL RÉSEAU — fonction impure, mais qui ne rejette JAMAIS
// ============================================================================

/**
 * @typedef {Object} EstimationApiResponse
 * @property {'ok'|'invalid'|'rate-limited'|'deferred'} status
 * @property {object|null} result           `EstimationResult` si `status === 'ok'`
 * @property {Record<string,string>|null} errors  erreurs par champ si `status === 'invalid'`
 * @property {number|null} httpStatus
 * @property {string|null} code             code applicatif (`RATE_LIMITED`...)
 * @property {string|null} message          message prêt à afficher, en français
 * @property {number|null} retryAfter       secondes, si `status === 'rate-limited'`
 * @property {boolean} addressUnresolved    true si l'adresse est en cause (retour étape 1)
 * @property {number} attempts              nombre de tentatives réellement faites
 * @property {'network'|'timeout'|'http'|'no-config'|null} reason
 */

/** Réponse d'échec normalisée. Jamais d'exception qui remonte à l'appelant. */
function buildEstimationApiFailure(reason, options) {
  var opts = options || {};
  return {
    status: opts.status || "deferred",
    result: null,
    errors: opts.errors || null,
    httpStatus: opts.httpStatus === undefined ? null : opts.httpStatus,
    code: opts.code || null,
    message: opts.message || null,
    retryAfter: opts.retryAfter === undefined ? null : opts.retryAfter,
    addressUnresolved: !!opts.addressUnresolved,
    attempts: opts.attempts || 0,
    reason: reason,
  };
}

/** Base URL nettoyée de sa barre finale ; "" si non configurée. */
function normalizeApiBaseUrl(baseUrl) {
  var value = String(baseUrl || "").trim();
  return value.replace(/\/+$/, "");
}

/**
 * Appelle `POST /v1/estimations`.
 *
 * Garanties (§2.4) :
 * - timeout de 6 s PAR TENTATIVE, via `AbortController` ;
 * - 1 seul retry, après ~1,5 s, et UNIQUEMENT sur erreur réseau / timeout /
 *   5xx. Jamais sur un 4xx : un 422 restera un 422, et un 429 doit être
 *   respecté (« le front n'effectue aucun retry », US-8) ;
 * - ne rejette JAMAIS : toute erreur est convertie en `EstimationApiResponse`.
 *
 * @param {object} payload cf. `buildEstimationApiPayload`
 * @param {object} [options] `{ baseUrl, timeoutMs, retryDelayMs, fetchImpl,
 *   setTimeoutImpl, abortControllerImpl }` — les trois derniers n'existent que
 *   pour les tests (aucune dépendance implicite à l'environnement).
 * @param {(response: EstimationApiResponse) => void} [callback]
 * @returns {Promise<EstimationApiResponse>} résolue, jamais rejetée
 */
function requestEstimation(payload, options, callback) {
  var opts = options || {};
  var baseUrl = normalizeApiBaseUrl(opts.baseUrl);
  var timeoutMs = opts.timeoutMs || ESTIMATION_API_TIMEOUT_MS;
  var retryDelayMs =
    opts.retryDelayMs === undefined ? ESTIMATION_API_RETRY_DELAY_MS : opts.retryDelayMs;
  var maxAttempts = opts.maxAttempts || ESTIMATION_API_MAX_ATTEMPTS;

  var fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
  var setTimeoutImpl = opts.setTimeoutImpl || (typeof setTimeout === "function" ? setTimeout : null);
  var AbortControllerImpl =
    opts.abortControllerImpl ||
    (typeof AbortController === "function" ? AbortController : null);

  function done(response) {
    if (typeof callback === "function") {
      try {
        callback(response);
      } catch (error) {
        // Une exception dans le callback appelant ne doit pas transformer
        // cette promesse en rejet : le contrat « ne rejette jamais » vaut
        // aussi pour ce qui se passe après.
        if (typeof console !== "undefined" && console.error) {
          console.error("Callback d'estimation en erreur :", error);
        }
      }
    }
    return response;
  }

  if (!baseUrl || !fetchImpl) {
    return Promise.resolve(
      done(
        buildEstimationApiFailure("no-config", {
          message: !baseUrl
            ? "Aucune URL d'API configurée (PUBLIC_API_URL)."
            : "fetch() indisponible dans ce navigateur.",
        })
      )
    );
  }

  var url = baseUrl + ESTIMATION_API_PATH;

  /** Une tentative. Résout toujours (jamais de rejet). */
  function attempt(attemptNumber) {
    var controller = AbortControllerImpl ? new AbortControllerImpl() : null;
    var timedOut = false;
    var timer = null;

    if (controller && setTimeoutImpl) {
      timer = setTimeoutImpl(function () {
        timedOut = true;
        try {
          controller.abort();
        } catch (error) {
          /* AbortController non standard : on laissera le timeout au réseau. */
        }
      }, timeoutMs);
    }

    function clear() {
      if (timer !== null && typeof clearTimeout === "function") clearTimeout(timer);
      timer = null;
    }

    var request;
    try {
      request = fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined,
      });
    } catch (error) {
      clear();
      return Promise.resolve(
        buildEstimationApiFailure("network", { attempts: attemptNumber })
      );
    }

    return Promise.resolve(request).then(
      function (response) {
        clear();
        return readResponse(response, attemptNumber);
      },
      function () {
        clear();
        return buildEstimationApiFailure(timedOut ? "timeout" : "network", {
          attempts: attemptNumber,
          message: timedOut
            ? "L'API d'estimation n'a pas répondu dans le délai imparti."
            : "L'API d'estimation est injoignable.",
        });
      }
    );
  }

  /** Interprète le code HTTP et le corps de la réponse. */
  function readResponse(response, attemptNumber) {
    var httpStatus = response && typeof response.status === "number" ? response.status : 0;

    function parseBody() {
      if (!response || typeof response.json !== "function") return Promise.resolve(null);
      return Promise.resolve(response.json()).then(
        function (body) {
          return body;
        },
        function () {
          return null; // corps illisible : on se contente du code HTTP.
        }
      );
    }

    return parseBody().then(function (body) {
      if (httpStatus >= 200 && httpStatus < 300) {
        if (!body || typeof body !== "object") {
          return buildEstimationApiFailure("http", {
            httpStatus: httpStatus,
            attempts: attemptNumber,
            message: "Réponse de l'API illisible.",
          });
        }
        return {
          status: "ok",
          result: body,
          errors: null,
          httpStatus: httpStatus,
          code: null,
          message: null,
          retryAfter: null,
          addressUnresolved: false,
          attempts: attemptNumber,
          reason: null,
        };
      }

      var code = body && body.code ? String(body.code) : null;

      if (httpStatus === 422) {
        var fieldErrors = mapApiErrorToFieldErrors(body);
        return buildEstimationApiFailure("http", {
          status: "invalid",
          httpStatus: httpStatus,
          code: code || "VALIDATION_ERROR",
          errors: fieldErrors,
          attempts: attemptNumber,
          message: (body && body.message) || "Certaines informations doivent être corrigées.",
        });
      }

      if (httpStatus === 404) {
        // Adresse / commune non résolue : ce n'est pas une panne, on renvoie
        // l'utilisateur à l'étape 1 plutôt que de produire une estimation.
        return buildEstimationApiFailure("http", {
          status: "invalid",
          httpStatus: httpStatus,
          code: code || "COMMUNE_NOT_FOUND",
          addressUnresolved: true,
          errors: {
            address:
              "Nous n'avons pas retrouvé cette adresse. Vérifiez-la, puis complétez le code postal et la ville.",
          },
          attempts: attemptNumber,
          message:
            (body && body.message) ||
            "Nous n'avons pas retrouvé cette adresse. Vérifiez-la, puis complétez le code postal et la ville.",
        });
      }

      if (httpStatus === 429) {
        var retryAfter = body && body.retryAfter ? Number(body.retryAfter) : null;
        if (!retryAfter && response && response.headers && response.headers.get) {
          var header = response.headers.get("Retry-After");
          if (header) retryAfter = Number(header);
        }
        if (!isFinite(retryAfter) || retryAfter <= 0) retryAfter = null;
        return buildEstimationApiFailure("http", {
          status: "rate-limited",
          httpStatus: httpStatus,
          code: code || "RATE_LIMITED",
          retryAfter: retryAfter,
          attempts: attemptNumber,
          message:
            "Trop de demandes depuis votre connexion. Réessayez dans " +
            (retryAfter ? retryAfter + " secondes" : "quelques instants") +
            ".",
        });
      }

      return buildEstimationApiFailure("http", {
        httpStatus: httpStatus,
        code: code,
        attempts: attemptNumber,
        message: (body && body.message) || "L'API d'estimation a rencontré une erreur.",
      });
    });
  }

  /** Un échec est-il rejouable ? Réseau, timeout et 5xx uniquement. */
  function isRetryable(response) {
    if (!response || response.status === "ok") return false;
    if (response.reason === "network" || response.reason === "timeout") return true;
    return typeof response.httpStatus === "number" && response.httpStatus >= 500;
  }

  function wait(delay) {
    if (!delay || !setTimeoutImpl) return Promise.resolve();
    return new Promise(function (resolve) {
      setTimeoutImpl(resolve, delay);
    });
  }

  function run(attemptNumber) {
    return attempt(attemptNumber).then(function (response) {
      if (attemptNumber < maxAttempts && isRetryable(response)) {
        return wait(retryDelayMs).then(function () {
          return run(attemptNumber + 1);
        });
      }
      return response;
    });
  }

  return run(1).then(done, function (error) {
    // Filet de sécurité : même une exception inattendue dans la chaîne
    // ci-dessus ne doit pas rejeter.
    if (typeof console !== "undefined" && console.error) {
      console.error("Erreur inattendue de l'appel d'estimation :", error);
    }
    return done(buildEstimationApiFailure("network", { attempts: maxAttempts }));
  });
}
