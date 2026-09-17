#!/usr/bin/env node
import { startServer } from './server.js'

/*
 * Point d'entrée du binaire `estimer-blog-mcp` (specs/blog-automatisation-ia.md
 * §7). Toute erreur de configuration (variables d'environnement absentes)
 * doit être visible IMMÉDIATEMENT sur stderr, sans jamais faire figurer le
 * contenu d'ESTIMER_BLOG_TOKEN dans le message (cf. `config.ts`).
 */
startServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[estimer-blog-mcp] Démarrage impossible : ${message}`)
  process.exit(1)
})
