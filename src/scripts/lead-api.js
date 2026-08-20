// ============================================================================
// LEAD API — client de `POST /v1/leads` (e-mails transactionnels)
// ============================================================================
//
// Mêmes contraintes de forme que `estimation-api.js` : ce fichier est injecté
// tel quel dans la page (`RawScript.astro` -> `<script is:inline>` à partir
// d'un import `?raw`). Il n'y a ni bundler ni résolution de modules ES : PAS
// de `import`, PAS de `export`. Tout vit dans la portée globale, en
// `var`/`function`, ce qui le rend chargeable dans le contexte `vm` de
// `scripts/test-lead-api.mjs`.
//
// ---------------------------------------------------------------------------
// POURQUOI CE MODULE EXISTE : SORTIR L'ENVOI D'E-MAIL DU NAVIGATEUR
// ---------------------------------------------------------------------------
// Jusqu'ici, le lead partait par EmailJS depuis la page : le corps du message
// était fabriqué en JavaScript client, et les identifiants du service vivaient
// dans le HTML livré (`PUBLIC_EMAILJS_*`). Deux conséquences, aucune
// théorique :
//   - le contenu de l'e-mail est modifiable par quiconque ouvre la console ;
//   - les identifiants sont publics par construction, donc réutilisables par
//     un tiers pour envoyer depuis notre compte.
// Le nouveau chemin n'envoie que des DONNÉES STRUCTURÉES à notre API, qui
// valide, rend le gabarit côté serveur et envoie via Scaleway TEM. Les
// identifiants SMTP ne quittent jamais le serveur.
//
// EmailJS reste câblé en REPLI LEGACY, et uniquement dans les cas où l'on sait
// que l'API n'a rien envoyé (cf. `shouldUseLegacyFallback`) : tant que
// `PUBLIC_API_URL` n'est pas déployé, le formulaire doit continuer de produire
// des leads.
//
// Périmètre :
//   - `buildEstimationLeadPayload(payload)` pure — payload wizard -> corps HTTP
//   - `buildContactLeadPayload(form)`       pure — formulaire contact -> corps HTTP
//   - `isLeadApiConfigured(config)`         pure — l'API est-elle joignable ?
//   - `shouldUseLegacyFallback(response)`   pure — faut-il rejouer par EmailJS ?
//   - `requestLead(payload, options, callback)`  IMPURE (fetch) — ne rejette jamais

// ============================================================================
// 1. CONSTANTES
// ============================================================================

/** Chemin de l'endpoint transactionnel (versionné, cf. §6.1). */
var LEAD_API_PATH = "/v1/leads";

/**
 * Timeout de l'unique tentative.
 *
 * Volontairement plus long que celui de l'estimation (6 s) : côté serveur, un
 * envoi SMTP est borné par `MAIL_TIMEOUT` (10 s par défaut) et l'accusé de
 * réception part ensuite. Couper à 6 s abandonnerait des envois qui allaient
 * aboutir — et produirait exactement le doublon que l'on cherche à éviter.
 */
var LEAD_API_TIMEOUT_MS = 12000;

/**
 * AUCUN RETRY. Ce n'est pas un oubli.
 *
 * Rejouer une requête dont on n'a pas lu la réponse, sur un endpoint qui
 * ENVOIE DES E-MAILS, produit un second e-mail chaque fois que la première
 * requête avait en réalité abouti. Un lead en double coûte un appel commercial
 * inutile et donne au prospect l'image d'un site qui bégaie ; l'estimation,
 * elle, est idempotente et peut se permettre son unique retry.
 */
var LEAD_API_MAX_ATTEMPTS = 1;

/** Valeurs acceptées par l'API pour `property.propertyType`. */
var LEAD_PROPERTY_TYPES = ["appartement", "maison", "terrain", "local-commercial"];

/** Classes DPE acceptées par l'API. */
var LEAD_DPE_VALUES = ["A", "B", "C", "D", "E", "F", "G", "unknown"];

/** Énumérations fermées des champs facultatifs (mêmes valeurs que le wizard). */
var LEAD_ENUMS = {
  dpeRequest: ["yes", "no"],
  hasTerrain: ["yes", "no"],
  hasElevator: ["yes", "no", "unknown"],
  outdoor: ["none", "balcony", "terrace", "garden"],
  condition: ["to-renovate", "fair", "good", "new"],
  isOwner: ["yes", "no"],
  wantToSell: ["yes", "no", "maybe"],
};

/** Statuts d'estimation acceptés par l'API. */
var LEAD_ESTIMATION_STATUSES = ["ok", "static-fallback", "deferred"];

/**
 * Raisons d'échec pour lesquelles on SAIT qu'aucun e-mail n'est parti, et où
 * le repli EmailJS est donc sans risque de doublon. Cf.
 * `shouldUseLegacyFallback` pour le raisonnement complet.
 */
var LEAD_FALLBACK_REASONS = ["no-config", "network", "server"];

// ============================================================================
// 2. OUTILS DE TYPAGE — fonctions pures
// ============================================================================

/** Nombre fini à partir d'une saisie brute (string du wizard ou number). `null` sinon. */
function toLeadNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  var parsed = typeof value === "number" ? value : parseFloat(String(value).replace(",", "."));
  return isFinite(parsed) ? parsed : null;
}

/** Entier à partir d'une saisie brute. `null` si inexploitable. */
function toLeadInteger(value) {
  var parsed = toLeadNumber(value);
  if (parsed === null) return null;
  var rounded = Math.round(parsed);
  return rounded === parsed ? rounded : null;
}

/** Chaîne nettoyée, ou "" si la valeur est absente. */
function toLeadString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/**
 * Pose `target[key] = value` uniquement si `value` appartient à `allowed`.
 *
 * Les champs facultatifs ABSENTS ne doivent pas être envoyés du tout : la
 * validation VineJS est stricte, et une chaîne vide sur une énumération vaut
 * 422 alors que l'utilisateur n'a simplement rien renseigné.
 */
function assignEnum(target, key, value, allowed) {
  var normalized = toLeadString(value);
  if (normalized && allowed.indexOf(normalized) !== -1) {
    target[key] = normalized;
  }
}

// ============================================================================
// 3. PAYLOAD ESTIMATION — fonction pure
// ============================================================================

/**
 * Construit le corps de `POST /v1/leads` (kind `estimation`) à partir du
 * payload de soumission du wizard (`wizard.serializeForSubmit(estimation)`,
 * enrichi de `estimationStatus` par `finalizeSubmit`).
 *
 * Contrairement à `buildEstimationApiPayload`, cette fonction transmet
 * DÉLIBÉRÉMENT les coordonnées : c'est tout l'objet de l'endpoint. La
 * séparation reste stricte côté API — `/v1/estimations` refuse ces champs en
 * 422, `/v1/leads` les reçoit et n'en persiste aucun.
 *
 * @param {object} payload cf. `buildSubmitPayload` dans estimation-wizard.js
 * @returns {object} corps JSON prêt à sérialiser
 */
function buildEstimationLeadPayload(payload) {
  var p = payload || {};
  var estimation = p.estimation || null;
  var status = toLeadString(p.estimationStatus) || "ok";

  var property = {
    address: toLeadString(p.address),
    postalCode: toLeadString(p.postalCode),
    city: toLeadString(p.city),
    dpe: LEAD_DPE_VALUES.indexOf(p.dpe) !== -1 ? p.dpe : "unknown",
  };

  if (LEAD_PROPERTY_TYPES.indexOf(p.propertyType) !== -1) {
    property.propertyType = p.propertyType;
  }

  var surface = toLeadNumber(p.surface);
  if (surface !== null) property.surface = surface;

  var rooms = toLeadInteger(p.rooms);
  if (rooms !== null) property.rooms = rooms;

  var floor = toLeadInteger(p.floor);
  if (floor !== null && floor >= 0) property.floor = floor;

  assignEnum(property, "dpeRequest", p.dpeRequest, LEAD_ENUMS.dpeRequest);
  assignEnum(property, "hasTerrain", p.hasTerrain, LEAD_ENUMS.hasTerrain);
  assignEnum(property, "hasElevator", p.hasElevator, LEAD_ENUMS.hasElevator);
  assignEnum(property, "outdoor", p.outdoor, LEAD_ENUMS.outdoor);
  assignEnum(property, "condition", p.condition, LEAD_ENUMS.condition);
  assignEnum(property, "isOwner", p.isOwner, LEAD_ENUMS.isOwner);
  assignEnum(property, "wantToSell", p.wantToSell, LEAD_ENUMS.wantToSell);

  // La surface du terrain n'a de sens que si l'utilisateur a répondu « oui ».
  if (property.hasTerrain === "yes") {
    var terrainSize = toLeadNumber(p.terrainSize);
    if (terrainSize !== null && terrainSize > 0) property.terrainSize = terrainSize;
  }

  var body = {
    kind: "estimation",
    name: toLeadString(p.name),
    email: toLeadString(p.email),
    property: property,
    estimation: buildLeadEstimationBlock(estimation, status),
  };

  var phone = toLeadString(p.phone);
  if (phone) body.phone = phone;

  return body;
}

/**
 * Bloc `estimation` du corps HTTP : le chiffre déjà calculé, et surtout la
 * façon dont il l'a été.
 *
 * `status` est la donnée la plus importante du bloc — c'est elle qui déclenche
 * la mention « ESTIMATION NON CALCULEE » en tête de l'e-mail interne. Un lead
 * issu du repli statique traité comme un lead nominal, c'est un conseiller qui
 * annonce au client un prix que personne n'a calculé sur des transactions
 * réelles.
 */
function buildLeadEstimationBlock(estimation, status) {
  var block = {
    status: LEAD_ESTIMATION_STATUSES.indexOf(status) !== -1 ? status : "deferred",
  };

  if (!estimation || typeof estimation !== "object") {
    return block;
  }

  var prixM2 = toLeadNumber(estimation.prixM2);
  if (prixM2 !== null && prixM2 >= 0) block.prixM2 = Math.round(prixM2);

  var min = toLeadNumber(estimation.estimationMin);
  if (min !== null && min >= 0) block.estimationMin = Math.round(min);

  var moyenne = toLeadNumber(estimation.estimationMoyenne);
  if (moyenne !== null && moyenne >= 0) block.estimationMoyenne = Math.round(moyenne);

  var max = toLeadNumber(estimation.estimationMax);
  if (max !== null && max >= 0) block.estimationMax = Math.round(max);

  // Enrichissements de l'API (absents du calcul de repli) : tolérés manquants.
  if (estimation.confidence && estimation.confidence.score !== undefined) {
    var score = toLeadInteger(estimation.confidence.score);
    if (score !== null && score >= 0 && score <= 100) block.confidenceScore = score;
  }

  if (estimation.method && estimation.method.comparablesCount !== undefined) {
    var comparables = toLeadInteger(estimation.method.comparablesCount);
    if (comparables !== null && comparables >= 0) block.comparablesCount = comparables;
  }

  return block;
}

// ============================================================================
// 4. PAYLOAD CONTACT — fonction pure
// ============================================================================

/**
 * Construit le corps de `POST /v1/leads` (kind `contact`) à partir des champs
 * du formulaire de contact.
 *
 * Le SUJET est transmis sous forme de CODE (`estimation`, `partenariat`…),
 * pas de libellé : c'est l'API qui produit le texte lisible. Envoyer le
 * libellé affiché reviendrait à laisser la page décider du contenu de
 * l'e-mail, ce que ce module existe précisément pour empêcher.
 *
 * @param {{name:string,email:string,phone?:string,subject?:string,message?:string,website?:string}} form
 * @returns {object}
 */
function buildContactLeadPayload(form) {
  var f = form || {};

  var body = {
    kind: "contact",
    name: toLeadString(f.name),
    email: toLeadString(f.email),
    message: toLeadString(f.message),
  };

  var phone = toLeadString(f.phone);
  if (phone) body.phone = phone;

  var subject = toLeadString(f.subject);
  if (subject) body.subject = subject;

  // Piège à robots : transmis tel quel, c'est l'API qui décide (200 silencieux).
  var website = toLeadString(f.website);
  if (website) body.website = website;

  return body;
}

// ============================================================================
// 5. DÉCISIONS DE REPLI — fonctions pures
// ============================================================================

/** L'API est-elle configurée ? (`CONFIG.API.BASE_URL` non vide) */
function isLeadApiConfigured(config) {
  return Boolean(config && toLeadString(config.BASE_URL));
}

/**
 * Faut-il rejouer l'envoi par EmailJS (repli legacy) ?
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA SEULE QUESTION QUI COMPTE : « EST-ON SÛR QU'AUCUN E-MAIL N'EST PARTI ? »
 * ══════════════════════════════════════════════════════════════════════════
 * Le repli n'est autorisé que lorsque la réponse le PROUVE :
 *   - `no-config` : aucune requête n'a été émise ;
 *   - `network`   : `fetch` a rejeté avant toute réponse (DNS, CORS, hors
 *                   ligne) — la requête n'a pas été traitée ;
 *   - `server`    : l'API a répondu, mais en refusant de traiter. Cela couvre
 *                   le 502 `MAIL_UNAVAILABLE` (« je n'ai pas pu remettre cet
 *                   e-mail », dit explicitement), les 5xx, et aussi le 403
 *                   `FORBIDDEN_ORIGIN` et le 404 — ce dernier étant le cas
 *                   très concret d'un front déployé avant l'API. Dans tous
 *                   ces cas la réponse a été lue : rien n'est parti.
 *
 * Tout le reste est exclu, et chacun pour sa raison :
 *   - `timeout` : le serveur peut très bien être en train d'envoyer. C'est le
 *     cas ambigu, et on tranche en faveur de « pas de doublon » — un e-mail
 *     reçu deux fois donne au prospect l'image d'un site cassé, et fait
 *     rappeler deux fois par le commercial ;
 *   - 422 : la saisie est à corriger. La rejouer par EmailJS ferait partir un
 *     lead que l'API vient de juger invalide, sans que l'utilisateur ait rien
 *     corrigé ;
 *   - 429 : le quota existe pour être respecté. Le contourner par un autre
 *     canal, c'est le supprimer.
 *
 * @param {object} response cf. `requestLead`
 * @returns {boolean}
 */
function shouldUseLegacyFallback(response) {
  if (!response || response.status === "ok") return false;
  return LEAD_FALLBACK_REASONS.indexOf(response.reason) !== -1;
}

// ============================================================================
// 6. APPEL RÉSEAU — fonction impure, mais qui ne rejette JAMAIS
// ============================================================================

/**
 * @typedef {Object} LeadApiResponse
 * @property {'ok'|'invalid'|'rate-limited'|'failed'} status
 * @property {'sent'|'dry-run'|null} mode  `dry-run` = l'API a tout construit
 *   sans ouvrir de connexion SMTP (environnement non configuré côté serveur)
 * @property {string|null} reference       référence courte, citable au support
 * @property {Record<string,string>|null} errors  erreurs par champ si `invalid`
 * @property {number|null} httpStatus
 * @property {string|null} code
 * @property {string|null} message         message prêt à afficher, en français
 * @property {number|null} retryAfter
 * @property {'network'|'timeout'|'server'|'no-config'|null} reason
 */

/** Réponse d'échec normalisée. Jamais d'exception qui remonte à l'appelant. */
function buildLeadFailure(reason, options) {
  var opts = options || {};
  return {
    status: opts.status || "failed",
    mode: null,
    reference: opts.reference || null,
    errors: opts.errors || null,
    httpStatus: opts.httpStatus === undefined ? null : opts.httpStatus,
    code: opts.code || null,
    message: opts.message || null,
    retryAfter: opts.retryAfter === undefined ? null : opts.retryAfter,
    reason: reason,
  };
}

/** Base URL nettoyée de sa barre finale ; "" si non configurée. */
function normalizeLeadBaseUrl(baseUrl) {
  return toLeadString(baseUrl).replace(/\/+$/, "");
}

/**
 * Convertit un corps 422 (`{ code, errors:[{field, rule, message}] }`) en
 * `Record<champ, message>`.
 *
 * Les champs imbriqués sont ramenés à leur nom simple (`property.surface` ->
 * `surface`) : ce sont les identifiants des inputs du wizard, ce qui permet à
 * `wizard.setErrors()` de replacer l'utilisateur sur le bon champ sans aucune
 * table de correspondance. Un champ inconnu du formulaire tombe sous `_form`.
 */
function mapLeadErrorToFieldErrors(apiError) {
  var errors = {};
  if (!apiError || typeof apiError !== "object") return errors;

  var list = apiError.errors || apiError.messages;
  if (!Array.isArray(list)) return errors;

  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (!item || typeof item !== "object") continue;

    var field = toLeadString(item.field);
    var message = toLeadString(item.message);
    if (!message) continue;

    var dot = field.lastIndexOf(".");
    if (dot !== -1) field = field.slice(dot + 1);

    var key = field || "_form";
    if (!errors[key]) errors[key] = message;
  }

  return errors;
}

/**
 * Appelle `POST /v1/leads`.
 *
 * Garanties :
 * - UNE seule tentative (cf. `LEAD_API_MAX_ATTEMPTS`) ;
 * - timeout via `AbortController` ;
 * - ne rejette JAMAIS : toute erreur est convertie en `LeadApiResponse`.
 *
 * @param {object} payload cf. `buildEstimationLeadPayload` / `buildContactLeadPayload`
 * @param {object} [options] `{ baseUrl, timeoutMs, fetchImpl, setTimeoutImpl,
 *   abortControllerImpl }` — les trois derniers n'existent que pour les tests.
 * @param {(response: LeadApiResponse) => void} [callback]
 * @returns {Promise<LeadApiResponse>} résolue, jamais rejetée
 */
function requestLead(payload, options, callback) {
  var opts = options || {};
  var baseUrl = normalizeLeadBaseUrl(opts.baseUrl);
  var timeoutMs = opts.timeoutMs || LEAD_API_TIMEOUT_MS;

  var fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
  var setTimeoutImpl =
    opts.setTimeoutImpl || (typeof setTimeout === "function" ? setTimeout : null);
  var AbortControllerImpl =
    opts.abortControllerImpl ||
    (typeof AbortController === "function" ? AbortController : null);

  function done(response) {
    if (typeof callback === "function") {
      try {
        callback(response);
      } catch (error) {
        // Une exception dans le callback appelant ne doit pas transformer
        // cette promesse en rejet.
        if (typeof console !== "undefined" && console.error) {
          console.error("Callback de lead en erreur :", error);
        }
      }
    }
    return response;
  }

  if (!baseUrl || !fetchImpl) {
    return Promise.resolve(
      done(
        buildLeadFailure("no-config", {
          message: !baseUrl
            ? "Aucune URL d'API configurée (PUBLIC_API_URL)."
            : "fetch() indisponible dans ce navigateur.",
        })
      )
    );
  }

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
    request = fetchImpl(baseUrl + LEAD_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
  } catch (error) {
    clear();
    return Promise.resolve(done(buildLeadFailure("network")));
  }

  return Promise.resolve(request).then(
    function (response) {
      clear();
      return readLeadResponse(response).then(done, function () {
        return done(buildLeadFailure("network"));
      });
    },
    function () {
      clear();
      return done(
        buildLeadFailure(timedOut ? "timeout" : "network", {
          message: timedOut
            ? "L'envoi de votre demande a dépassé le délai imparti."
            : "Le service d'envoi est injoignable.",
        })
      );
    }
  );
}

/** Interprète le code HTTP et le corps de la réponse. */
function readLeadResponse(response) {
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
    var code = body && body.code ? String(body.code) : null;

    if (httpStatus >= 200 && httpStatus < 300) {
      return {
        status: "ok",
        // `dry-run` : l'API a tout fait sauf ouvrir la connexion SMTP. C'est
        // un succès du point de vue du parcours — mais aucun e-mail n'existe.
        mode: body && body.status === "dry-run" ? "dry-run" : "sent",
        reference: body && body.reference ? String(body.reference) : null,
        errors: null,
        httpStatus: httpStatus,
        code: null,
        message: null,
        retryAfter: null,
        reason: null,
      };
    }

    if (httpStatus === 422) {
      return buildLeadFailure("http", {
        status: "invalid",
        httpStatus: httpStatus,
        code: code || "VALIDATION_ERROR",
        errors: mapLeadErrorToFieldErrors(body),
        message: (body && body.message) || "Certaines informations doivent être corrigées.",
      });
    }

    if (httpStatus === 429) {
      var retryAfter = body && body.retryAfter ? Number(body.retryAfter) : null;
      if (!retryAfter && response && response.headers && response.headers.get) {
        var header = response.headers.get("Retry-After");
        if (header) retryAfter = Number(header);
      }
      if (!isFinite(retryAfter) || retryAfter <= 0) retryAfter = null;

      return buildLeadFailure("http", {
        status: "rate-limited",
        httpStatus: httpStatus,
        code: code || "RATE_LIMITED",
        retryAfter: retryAfter,
        message:
          "Trop de demandes depuis votre connexion. Réessayez dans " +
          (retryAfter ? retryAfter + " secondes" : "quelques instants") +
          ".",
      });
    }

    /*
     * 5xx — dont le 502 `MAIL_UNAVAILABLE` : l'API dit explicitement qu'elle
     * n'a pas remis l'e-mail. C'est le seul cas d'échec côté serveur où le
     * repli EmailJS est certain de ne pas produire de doublon.
     */
    if (httpStatus >= 500) {
      return buildLeadFailure("server", {
        httpStatus: httpStatus,
        code: code,
        reference: body && body.reference ? String(body.reference) : null,
        message:
          (body && body.message) ||
          "Votre demande n'a pas pu être transmise. Réessayez dans quelques instants.",
      });
    }

    // 4xx restants (403 origine refusée, 404 route absente) : la requête ne
    // passera pas davantage au second essai, et rien n'a été envoyé.
    return buildLeadFailure("server", {
      httpStatus: httpStatus,
      code: code,
      message: (body && body.message) || "Le service d'envoi a refusé la demande.",
    });
  });
}
