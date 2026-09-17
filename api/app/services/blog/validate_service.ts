import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ValidationIssue } from '#models/blog_job'

const execFileAsync = promisify(execFile)

export interface ValidationReport {
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

/**
 * Exécute le VRAI `scripts/validate-content.mjs --json` de la copie de
 * travail (spec §0, point 3 : « aucune règle dupliquée »). L'API n'a et ne
 * doit avoir aucune copie de la logique de gate de publication : ce module
 * ne fait qu'appeler le script et interpréter son JSON.
 */
export async function runValidateContent(workdir: string): Promise<ValidationReport> {
  try {
    const { stdout } = await execFileAsync('node', ['scripts/validate-content.mjs', '--json'], {
      cwd: workdir,
      maxBuffer: 32 * 1024 * 1024,
    })
    return JSON.parse(stdout) as ValidationReport
  } catch (error) {
    // Code de sortie 1 (des erreurs bloquantes) : le script écrit quand même
    // son JSON sur stdout avant de sortir en échec — `execFile` le fournit
    // dans `error.stdout` malgré le rejet de la promesse.
    if (error && typeof error === 'object' && 'stdout' in error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? '')
      if (stdout.trim().startsWith('{')) {
        return JSON.parse(stdout) as ValidationReport
      }
    }
    throw error
  }
}
