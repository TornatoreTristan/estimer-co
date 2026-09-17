/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| Validation des variables d'environnement de l'API (spec §6.4).
| Toute variable manquante fait échouer le démarrage : on préfère un service
| qui ne démarre pas à un service qui démarre mal configuré (CORS ouvert,
| proxy non déclaré, sel HMAC vide…).
|
*/

import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  APP_KEY: Env.schema.string(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),

  /*
  |--------------------------------------------------------------------------
  | Base de données (PostgreSQL 16 + PostGIS)
  |--------------------------------------------------------------------------
  */
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),

  /*
  |--------------------------------------------------------------------------
  | Sécurité de l'endpoint public (spec §2.5 et §2.6)
  |--------------------------------------------------------------------------
  |
  | CORS_ORIGINS : liste CSV d'origines autorisées. Piloté par l'environnement
  | pour pouvoir ajouter une preview sans reconstruire l'image.
  |
  | TRUSTED_PROXY : liste CSV de CIDR. `X-Forwarded-For` n'est lu QUE si la
  | connexion vient d'une de ces plages. Sans cela l'en-tête se forge et le
  | rate limiting est contournable en une ligne de cURL.
  |
  */
  CORS_ORIGINS: Env.schema.string(),
  TRUSTED_PROXY: Env.schema.string.optional(),

  /*
  |--------------------------------------------------------------------------
  | Sources de données externes
  |--------------------------------------------------------------------------
  */
  BAN_API_URL: Env.schema.string(),
  DVF_BASE_URL: Env.schema.string(),
  ADEME_API_URL: Env.schema.string.optional(),
  COG_COMMUNES_URL: Env.schema.string.optional(),

  /*
  |--------------------------------------------------------------------------
  | Anonymisation et cache
  |--------------------------------------------------------------------------
  |
  | IP_HASH_SALT : sel du HMAC-SHA256 appliqué aux IP dans `estimations_log`
  | (§8.3). Jamais commité, jamais journalisé.
  |
  */
  IP_HASH_SALT: Env.schema.string(),
  ESTIMATION_CACHE_TTL: Env.schema.number.optional(),
  GEOCODE_CACHE_TTL_DAYS: Env.schema.number.optional(),

  /*
  |--------------------------------------------------------------------------
  | Rate limiting (spec §2.6)
  |--------------------------------------------------------------------------
  |
  | Format « N/durée » accepté par @adonisjs/limiter, ex. « 10/1 minute ».
  |
  */
  LIMITER_STORE: Env.schema.enum(['database', 'memory'] as const),
  RATE_LIMIT_ESTIMATION: Env.schema.string.optional(),
  RATE_LIMIT_ESTIMATION_DAILY: Env.schema.string.optional(),
  RATE_LIMIT_GEOCODE: Env.schema.string.optional(),
  RATE_LIMIT_MARCHE: Env.schema.string.optional(),
  RATE_LIMIT_GLOBAL: Env.schema.string.optional(),
  RATE_LIMIT_LEADS: Env.schema.string.optional(),
  RATE_LIMIT_LEADS_DAILY: Env.schema.string.optional(),

  /*
  |--------------------------------------------------------------------------
  | E-mails transactionnels — Scaleway Transactional Email (TEM)
  |--------------------------------------------------------------------------
  |
  | Toutes ces variables sont déclarées OPTIONNELLES ici, et c'est délibéré :
  | `MAIL_TRANSPORT` vaut `dry-run` par défaut, régime dans lequel aucune
  | d'entre elles n'est nécessaire. Un déploiement existant continue donc de
  | démarrer sans être reconfiguré — il n'enverra simplement aucun e-mail.
  |
  | La cohérence RÉELLE (« si transport = smtp, alors host/user/password/from
  | sont obligatoires ») ne s'exprime pas dans ce schéma, qui valide chaque
  | variable isolément. Elle est contrôlée au démarrage par
  | `assertMailSettings()` (`app/lib/mail_config.ts`), appelé depuis
  | `start/kernel.ts` : en production, une configuration SMTP incomplète fait
  | échouer le démarrage, au même titre qu'une variable manquante ci-dessus.
  |
  | `SMTP_PASSWORD` est la clé API Scaleway : elle vit UNIQUEMENT dans le
  | gestionnaire de secrets de Coolify, jamais dans un fichier commité.
  |
  */
  MAIL_TRANSPORT: Env.schema.enum.optional(['smtp', 'dry-run'] as const),
  SMTP_HOST: Env.schema.string.optional({ format: 'host' }),
  SMTP_PORT: Env.schema.number.optional(),
  SMTP_SECURE: Env.schema.boolean.optional(),
  SMTP_USERNAME: Env.schema.string.optional(),
  SMTP_PASSWORD: Env.schema.string.optional(),
  MAIL_FROM_ADDRESS: Env.schema.string.optional(),
  MAIL_FROM_NAME: Env.schema.string.optional(),
  MAIL_REPLY_TO: Env.schema.string.optional(),
  /** Boîte interne qui reçoit les leads (§ e-mails transactionnels). */
  MAIL_TO: Env.schema.string.optional(),
  /** Délai maximal d'un envoi, en millisecondes. */
  MAIL_TIMEOUT: Env.schema.number.optional(),
  /** Accusé de réception envoyé au prospect. Désactivable sans redéploiement. */
  MAIL_SEND_ACKNOWLEDGEMENT: Env.schema.boolean.optional(),

  /*
  |--------------------------------------------------------------------------
  | Notification Discord des leads (canal accessoire)
  |--------------------------------------------------------------------------
  |
  | Double l'e-mail interne d'une alerte immédiate dans un salon Discord. Ce
  | canal ne remplace rien : l'e-mail reste la trace archivée du lead.
  |
  | `DISCORD_WEBHOOK_URL` vide — le défaut — désactive tout : aucun appel
  | réseau, aucun avertissement. Un déploiement existant n'a rien à changer.
  |
  | Aucune de ces variables ne peut faire échouer le démarrage, à la
  | différence des variables `MAIL_*` : une notification manquée prive
  | l'équipe d'un bip, elle ne perd aucun lead. Les incohérences sont
  | signalées par `inspectDiscordSettings()` sous forme d'avertissements.
  |
  | L'URL du webhook est un SECRET (droit de poster dans le salon) : elle vit
  | dans le gestionnaire de secrets de Coolify, jamais dans un fichier commité.
  |
  */
  DISCORD_WEBHOOK_URL: Env.schema.string.optional(),
  /** Délai maximal de l'appel webhook, en millisecondes (défaut 4000). */
  DISCORD_TIMEOUT: Env.schema.number.optional(),
  /**
   * Coordonnées du prospect dans le message Discord (défaut `true`).
   * `false` produit une alerte sans aucune donnée personnelle.
   */
  DISCORD_INCLUDE_CONTACT: Env.schema.boolean.optional(),
  /** Mention en tête du message : `@here`, `@everyone` ou un identifiant de rôle. */
  DISCORD_MENTION: Env.schema.string.optional(),
  /** Nom d'affichage du bot dans le salon. */
  DISCORD_USERNAME: Env.schema.string.optional(),

  /*
  |--------------------------------------------------------------------------
  | Vignette de carte dans l'accusé de réception
  |--------------------------------------------------------------------------
  |
  | Clé Google Maps **serveur**, distincte de `PUBLIC_GOOGLE_MAPS_API_KEY` du
  | site : celle-ci n'est jamais publiée. L'API va chercher l'image de carte
  | au moment de l'envoi et l'attache au message ; la clé ne traverse donc
  | jamais l'e-mail.
  |
  | C'est ce qui interdit l'autre solution, plus simple en apparence : mettre
  | l'URL Static Maps dans un `<img src>`. Cette URL est fetchée par le proxy
  | d'images de Gmail, sans référent — la clé devrait donc être ouverte à tous
  | les référents, et n'importe qui la lisant dans l'e-mail pourrait la
  | consommer sur notre facture.
  |
  | Absente — le défaut — la carte est simplement omise de l'e-mail. Aucun
  | déploiement existant n'a à changer quoi que ce soit.
  |
  */
  GOOGLE_MAPS_API_KEY: Env.schema.string.optional(),
  /** Délai maximal du téléchargement de la vignette, en ms (défaut 4000). */
  STATIC_MAP_TIMEOUT: Env.schema.number.optional(),

  /*
  |--------------------------------------------------------------------------
  | Automatisation IA du blog (specs/blog-automatisation-ia.md §5)
  |--------------------------------------------------------------------------
  |
  | Toutes optionnelles ici, et c'est délibéré : un déploiement existant qui
  | ignore ce module démarre sans y toucher. C'est le module blog lui-même qui
  | échoue bruyamment (erreur explicite) si on l'appelle sans configuration —
  | jamais le démarrage de tout le service pour une fonctionnalité annexe.
  |
  */
  // PAT fine-grained GitHub, dépôt estimer-co seul, contents:write + pull_requests:write.
  // JAMAIS journalisé, jamais écrit dans .git/config (voir BlogGitService).
  GITHUB_BLOG_BOT_TOKEN: Env.schema.string.optional(),
  // "propriétaire/dépôt", ex. TornatoreTristan/estimer-co.
  GITHUB_REPO: Env.schema.string.optional(),
  // Copie de travail persistante du dépôt Git (spec §1.3) : un volume dédié
  // en production, un dossier temporaire par test.
  BLOG_GIT_WORKDIR: Env.schema.string.optional(),
  BLOG_GIT_AUTHOR_NAME: Env.schema.string.optional(),
  BLOG_GIT_AUTHOR_EMAIL: Env.schema.string.optional(),
  // Point de bascule pour les tests : une URL de remote Git QUELCONQUE (ex.
  // un dépôt local "bare" dans un dossier temporaire), en lieu et place de
  // `https://github.com/<GITHUB_REPO>.git`. Ne sert jamais en production.
  BLOG_GIT_REMOTE_URL: Env.schema.string.optional(),
  // Point de bascule pour les tests : base d'API GitHub, pour rediriger
  // Octokit vers un serveur HTTP local au lieu de `https://api.github.com`.
  GITHUB_API_BASE_URL: Env.schema.string.optional(),
  RATE_LIMIT_BLOG: Env.schema.string.optional(),
})
