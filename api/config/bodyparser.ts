import { defineConfig } from '@adonisjs/core/bodyparser'

const bodyParserConfig = defineConfig({
  /**
   * The bodyparser middleware will parse the request body
   * for the following HTTP methods.
   */
  allowedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],

  /**
   * Config for the "application/x-www-form-urlencoded"
   * content-type parser
   */
  form: {
    convertEmptyStringsToNull: true,
    types: ['application/x-www-form-urlencoded'],
  },

  /**
   * Config for the JSON parser
   */
  json: {
    /**
     * §2.6, point 2 : « payload borné ». Cette limite est GLOBALE (le
     * bodyparser ne se configure pas par route) — elle doit donc couvrir le
     * plus gros corps JSON légitime de toute l'API : `POST /v1/blog/articles`
     * peut porter une image en base64 (specs/blog-automatisation-ia.md, C1-C4 :
     * jusqu'à 10 Mo DÉCODÉS, donc ~13,3 Mo encodés, plus le frontmatter). Elle
     * remplace l'ancienne limite de 4 Ko, redevenue insuffisante avec ce
     * module.
     *
     * Cette limite de 15 Mo n'est PAS la seule protection en dehors du blog :
     * `BodySizeGuardMiddleware` (`app/middleware/body_size_guard_middleware.ts`,
     * enregistré dans `server.use([...])`, donc AVANT le bodyparser) rejette
     * déjà, sans lire un octet, tout corps déclaré au-delà de
     * `DEFAULT_MAX_BODY_BYTES` sur toute route hors `/v1/blog/**` — 15 Mo
     * n'est donc atteignable, en pratique, que sur le blog (authentifié) ou
     * par un client qui ment sur son `Content-Length` (borné dans tous les
     * cas par CETTE limite globale — voir le commentaire de tête de
     * `app/lib/body_size_guard.ts`). `/v1/estimations` garde en plus sa
     * propre limite de 4 Ko, appliquée par `MaxBodySizeMiddleware`
     * (`start/routes.ts`).
     */
    limit: '15mb',
    convertEmptyStringsToNull: true,
    types: [
      'application/json',
      'application/json-patch+json',
      'application/vnd.api+json',
      'application/csp-report',
    ],
  },

  /**
   * Config for the "multipart/form-data" content-type parser.
   * File uploads are handled by the multipart parser.
   */
  multipart: {
    /**
     * Enabling auto process allows bodyparser middleware to
     * move all uploaded files inside the tmp folder of your
     * operating system
     */
    autoProcess: true,
    convertEmptyStringsToNull: true,
    processManually: [],

    /**
     * Maximum limit of data to parse including all files
     * and fields
     */
    limit: '20mb',
    types: ['multipart/form-data'],
  },
})

export default bodyParserConfig
