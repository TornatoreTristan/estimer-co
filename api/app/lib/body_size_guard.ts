/**
 * Garde de taille de corps — appliquée AVANT `bodyparser_middleware`
 * (spec revue QA, C1 : `specs/blog-automatisation-ia.md`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Pourquoi un nouveau garde, ce que remplace l'ancien
 * ══════════════════════════════════════════════════════════════════════════
 * `config/bodyparser.ts` porte une limite JSON GLOBALE de 15 Mo, nécessaire à
 * `POST /v1/blog/articles` (image en base64, jusqu'à ~13,3 Mo encodés).
 * L'ancien `MaxBodySizeMiddleware` (toujours présent, sur `/v1/estimations`
 * uniquement) est un middleware NOMMÉ : il s'exécute au niveau de la ROUTE,
 * donc APRÈS `router.use([bodyparser_middleware])` (`start/kernel.ts`), qui
 * s'exécute pour tout le trafic routé, middlewares nommés inclus. Le corps —
 * jusqu'à 15 Mo — est donc déjà intégralement lu et parsé quand cet ancien
 * middleware regardait `Content-Length` : il ne protégeait plus rien.
 *
 * `BodySizeGuardMiddleware` (`app/middleware/body_size_guard_middleware.ts`)
 * répare ça : il s'enregistre dans la pile `server.use(...)`, qui s'exécute
 * pour CHAQUE requête avant même le routage — donc avant `router.use(...)`
 * et `bodyparser_middleware`. `evaluateBodySizeGuard`, ci-dessous, porte la
 * décision pure (aucune dépendance HTTP), pour rester testable sans requête
 * réseau — même choix que `app/lib/client_ip.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Portée
 * ══════════════════════════════════════════════════════════════════════════
 * Par défaut sur TOUTES les routes qui acceptent un corps (POST/PUT/PATCH/
 * DELETE), SAUF `/v1/blog/**`, qui garde la limite globale du bodyparser
 * (15 Mo) — c'est là, et seulement là, qu'une image base64 est légitime.
 *
 * Seuil par défaut : voir `DEFAULT_MAX_BODY_BYTES`, calculé pour couvrir
 * largement `POST /v1/leads` (le plus gros payload hors blog : `message`
 * jusqu'à 5 000 caractères UTF-8, potentiellement multi-octets) ET
 * `POST /v1/estimations`, qui garde en plus sa propre limite de 4 Ko
 * (`MaxBodySizeMiddleware`, appliquée après ce garde, en défense en
 * profondeur — un corps qui passe déjà sous 4 Ko passe forcément sous ce
 * seuil global, donc cette seconde vérification ne coûte jamais un faux
 * rejet).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Ce que « Content-Length déclaré ≤ seuil » garantit réellement
 * ══════════════════════════════════════════════════════════════════════════
 * Un `Content-Length` MENSONGER ne permet pas de contourner ce garde pour
 * faire lire un corps arbitrairement gros : `@adonisjs/bodyparser` délègue la
 * lecture du flux à `raw-body` (`node_modules/raw-body/index.js`), qui :
 *
 *  1. compare, à CHAQUE chunk reçu (`onData`), le nombre d'octets déjà reçus à
 *     SA PROPRE limite configurée (`limit`, ici la limite globale du
 *     bodyparser — 15 Mo pour le JSON) — PAS au `Content-Length` déclaré par
 *     le client. Un client qui annonce un `Content-Length` inférieur à ce
 *     qu'il envoie réellement ne peut donc jamais faire lire plus que cette
 *     limite globale : au-delà, `raw-body` lève lui-même une 413
 *     (`entity.too.large`) ;
 *  2. à la fin du flux (`onEnd`), compare les octets RÉELLEMENT reçus
 *     (`received`) au `Content-Length` déclaré (`length`) et lève une erreur
 *     (« request size did not match content length ») s'ils diffèrent.
 *
 * Autrement dit : un `Content-Length` mensonger ne peut jamais faire lire à
 * l'API plus que la limite globale déjà configurée dans le bodyparser (15 Mo
 * au pire, sur `/v1/blog/**`) — ce garde ne fait qu'ajouter un rejet PLUS TÔT
 * (avant lecture) pour le cas honnête (le client annonce fidèlement un corps
 * trop gros), et pour le cas « pas de `Content-Length` du tout » (chunked).
 * Un client malveillant qui annonce un `Content-Length` PETIT tout en
 * envoyant un corps plus gros passe ce garde, mais reste borné par la limite
 * globale du bodyparser (15 Mo), exactement comme avant ce correctif — ce
 * garde ne dégrade donc rien, il ajoute une protection supplémentaire sans
 * en retirer aucune.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Cas `/v1/blog/**` : anonymes rejetés avant lecture, jetons invalides non
 * ══════════════════════════════════════════════════════════════════════════
 * Toutes les routes `/v1/blog/**` exigent un jeton Bearer (`BlogAuthMiddleware`,
 * `app/middleware/blog_auth_middleware.ts`). Mais cette vérification COMPLÈTE
 * (jeton connu en base, non révoqué, bon scope) est un middleware NOMMÉ : elle
 * s'exécute, comme l'ancien `MaxBodySizeMiddleware`, après le bodyparser — le
 * corps de 15 Mo serait donc déjà lu quand `BlogAuthMiddleware` rejette un
 * jeton invalide.
 *
 * Ce garde fait donc, lui, une vérification de FORME de l'en-tête
 * `Authorization` (regex `^Bearer\s+.+$`), AVANT lecture du corps : un
 * appelant qui ne présente même pas un jeton au bon format (absent, mal
 * formé) est rejeté en 401 sans qu'un octet de son corps ne soit lu. C'est
 * délibérément PLUS FAIBLE que la vérification complète :
 *
 *  - elle ne peut PAS interroger la base (`blog_api_clients`) pour vérifier
 *    que le jeton existe et n'est pas révoqué : ce garde s'exécute AVANT le
 *    routage, donc avant même de savoir quelle route (et donc quel scope
 *    éventuel) est visée — une requête asynchrone ici serait de toute façon
 *    dupliquée avec `BlogAuthMiddleware` ;
 *  - elle ne vérifie donc PAS le scope, ni la révocation.
 *
 * Conséquence assumée : un appelant qui forge un en-tête `Authorization:
 * Bearer <n'importe-quoi>` AU BON FORMAT, mais avec un jeton inconnu, révoqué
 * ou sans le bon scope, passe ce garde et fait lire son corps (jusqu'à
 * 15 Mo) avant d'être rejeté par `BlogAuthMiddleware`. Ce n'est pas une
 * régression : SANS ce garde, c'était déjà vrai pour TOUT appelant, y
 * compris ceux qui n'envoient AUCUN en-tête `Authorization`. Ce garde réduit
 * strictement la surface (il élimine le cas — probablement le plus courant en
 * pratique, scans et bruit — d'un appelant qui ne présente même pas un jeton
 * plausible), sans prétendre l'éliminer entièrement : une élimination
 * complète demanderait de dupliquer la logique de `BlogAuthMiddleware` (accès
 * base de données) avant le routage, ce qui n'a pas de sens architectural
 * (elle deviendrait indépendante du scope requis par la route, qu'on ne
 * connaît pas encore à ce stade).
 */

/** 64 Kio — voir le calcul dans le commentaire ci-dessus et dans les tests. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024

const BODYFUL_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// `\S` (pas `.+` seul) après l'espace : « Bearer    » (rien que des espaces)
// n'est pas un jeton, même si `.` matcherait techniquement un espace.
const BEARER_FORMAT = /^Bearer\s+\S+/i

export interface BodySizeGuardInput {
  method: string
  /** Chemin de la requête, SANS la chaîne de requête (`request.url()`). */
  pathname: string
  /**
   * `true` si la requête annonce un corps — même définition que
   * `request.hasBody()` d'AdonisJS (`Transfer-Encoding` présent OU
   * `Content-Length` un nombre valide).
   */
  hasBody: boolean
  /** Valeur brute de l'en-tête `content-length`, si présent. */
  contentLength: string | undefined
  /** Valeur brute de l'en-tête `authorization`, si présent. */
  authorizationHeader: string | undefined
}

export type BodySizeGuardDecision =
  | { action: 'continue' }
  | { action: 'reject'; status: 413; code: 'PAYLOAD_TOO_LARGE'; message: string }
  | { action: 'reject'; status: 411; code: 'LENGTH_REQUIRED'; message: string }
  | { action: 'blog_unauthorized' }

/** Préfixe des routes exemptées de ce garde (limite globale du bodyparser à la place). */
export const BLOG_ROUTE_PREFIX = '/v1/blog/'

/**
 * Décision pure, sans dépendance HTTP — voir le commentaire de tête du
 * fichier pour le raisonnement complet.
 */
export function evaluateBodySizeGuard(
  input: BodySizeGuardInput,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES
): BodySizeGuardDecision {
  if (!BODYFUL_METHODS.has(input.method.toUpperCase())) {
    return { action: 'continue' }
  }

  if (!input.hasBody) {
    // Ni Transfer-Encoding ni Content-Length : aucun corps annoncé, rien à
    // protéger (une requête POST sans corps échouera de toute façon plus
    // loin sur les champs requis, ce n'est pas un vecteur de déni de
    // service).
    return { action: 'continue' }
  }

  if (input.pathname.startsWith(BLOG_ROUTE_PREFIX)) {
    if (!input.authorizationHeader || !BEARER_FORMAT.test(input.authorizationHeader)) {
      return { action: 'blog_unauthorized' }
    }
    return { action: 'continue' }
  }

  if (input.contentLength === undefined) {
    // `hasBody` est vrai sans `Content-Length` : c'est nécessairement
    // `Transfer-Encoding` (chunked) — voir `type-is`, dont dépend
    // `request.hasBody()`. Un corps chunked ne permet pas de connaître sa
    // taille avant de le lire : refusé, plutôt que lu en aveugle.
    return {
      action: 'reject',
      status: 411,
      code: 'LENGTH_REQUIRED',
      message:
        "L'en-tête Content-Length est obligatoire (un corps envoyé en Transfer-Encoding: chunked n'est pas accepté).",
    }
  }

  const length = Number(input.contentLength)
  if (!Number.isFinite(length) || length < 0) {
    return {
      action: 'reject',
      status: 411,
      code: 'LENGTH_REQUIRED',
      message: "L'en-tête Content-Length est invalide.",
    }
  }

  if (length > maxBytes) {
    return {
      action: 'reject',
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: `Corps de requête trop volumineux (maximum ${maxBytes} octets).`,
    }
  }

  return { action: 'continue' }
}
