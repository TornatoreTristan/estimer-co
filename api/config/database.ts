import { defineConfig } from '@adonisjs/lucid'
import env from '#start/env'

/**
 * Connexion PostgreSQL 16 / PostGIS.
 *
 * `mutations` est partitionnée par année et les requêtes de comparables
 * s'appuient sur des fonctions PostGIS : elles passent par du SQL brut
 * (spec §5.2). Lucid sert au CRUD d'administration et aux tests.
 */
const dbConfig = defineConfig({
  connection: 'postgres',
  connections: {
    postgres: {
      client: 'pg',
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: env.get('DB_USER'),
        password: env.get('DB_PASSWORD'),
        database: env.get('DB_DATABASE'),
      },
      pool: {
        min: 0,
        max: 10,
      },
      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },
    },
  },
})

export default dbConfig
