import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { BlogApiClient } from '../src/blog_api_client.js'
import { registerBlogTools } from '../src/tools.js'
import { startFakeApiServer, type FakeApiServer } from './helpers/fake_api_server.js'

/**
 * Double minimal de `McpServer` : n'implémente que `registerTool`, seule
 * méthode utilisée par `registerBlogTools`. Permet d'invoquer directement
 * les handlers enregistrés, sans démarrer un vrai transport stdio.
 */
class FakeMcpServer {
  readonly tools = new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>()

  registerTool(
    name: string,
    _config: unknown,
    handler: (args: Record<string, unknown>) => Promise<CallToolResult>
  ): unknown {
    this.tools.set(name, handler)
    return {}
  }
}

const TOKEN = 'jeton-tres-secret'

async function setupFake(): Promise<{ apiServer: FakeApiServer; fakeMcp: FakeMcpServer }> {
  const apiServer = await startFakeApiServer()
  const fakeMcp = new FakeMcpServer()
  const client = new BlogApiClient({ apiUrl: apiServer.url, token: TOKEN })
  registerBlogTools(fakeMcp as unknown as McpServer, client)
  return { apiServer, fakeMcp }
}

function textOf(result: CallToolResult): string {
  const first = result.content[0]
  if (!first || first.type !== 'text') throw new Error('Résultat de test inattendu : pas de bloc texte.')
  return first.text
}

test('create_or_update_article envoie le jeton en Authorization et une Idempotency-Key générée', async () => {
  const { apiServer, fakeMcp } = await setupFake()
  try {
    apiServer.setResponse(201, {
      slug: 'mon-article',
      statut: 'brouillon',
      job: { id: 'job-1', status: 'pr_open' },
      prUrl: 'https://github.com/x/pull/1',
    })
    const handler = fakeMcp.tools.get('create_or_update_article')
    assert.ok(handler)
    const result = await handler!({ categorie: 'conseils', title: 'Mon article', contenu: 'Contenu.' })
    assert.equal(result.isError, undefined)

    const recorded = apiServer.lastRequest()
    assert.equal(recorded?.headers['authorization'], `Bearer ${TOKEN}`)
    assert.ok(recorded?.headers['idempotency-key'], "une Idempotency-Key doit être générée si aucune n'est fournie")
    assert.equal((recorded?.body as Record<string, unknown>).categorie, 'conseils')
  } finally {
    await apiServer.close()
  }
})

test('create_or_update_article réutilise la idempotencyKey fournie par l\'appelant', async () => {
  const { apiServer, fakeMcp } = await setupFake()
  try {
    apiServer.setResponse(200, {
      slug: 'mon-article',
      statut: 'brouillon',
      job: { id: 'job-1', status: 'pr_open' },
      prUrl: 'https://github.com/x/pull/1',
    })
    const handler = fakeMcp.tools.get('create_or_update_article')!
    await handler({ categorie: 'conseils', title: 'Mon article', contenu: 'Contenu.', idempotencyKey: 'ma-cle-123' })
    assert.equal(apiServer.lastRequest()?.headers['idempotency-key'], 'ma-cle-123')
  } finally {
    await apiServer.close()
  }
})

test('create_or_update_article encode imagePath en base64 avec le bon mimeType', async () => {
  const { apiServer, fakeMcp } = await setupFake()
  const dir = await mkdtemp(path.join(tmpdir(), 'estimer-blog-mcp-'))
  try {
    apiServer.setResponse(201, {
      slug: 'x',
      statut: 'brouillon',
      job: { id: 'job-1', status: 'pr_open' },
      prUrl: 'https://github.com/x/pull/1',
    })
    const imagePath = path.join(dir, 'photo.jpg')
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    await writeFile(imagePath, bytes)

    const handler = fakeMcp.tools.get('create_or_update_article')!
    const result = await handler({
      categorie: 'conseils',
      title: 'Mon article',
      contenu: 'Contenu.',
      imagePath,
      imageAlt: 'Texte alternatif',
    })
    assert.equal(result.isError, undefined)

    const body = apiServer.lastRequest()?.body as { image: { data: string; mimeType: string }; imageAlt: string }
    assert.equal(body.image.data, bytes.toString('base64'))
    assert.equal(body.image.mimeType, 'image/jpeg')
    assert.equal(body.imageAlt, 'Texte alternatif')
  } finally {
    await apiServer.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('create_or_update_article refuse imagePath et imageBase64 fournis simultanément', async () => {
  const { apiServer, fakeMcp } = await setupFake()
  try {
    const handler = fakeMcp.tools.get('create_or_update_article')!
    const result = await handler({
      categorie: 'conseils',
      title: 'Mon article',
      contenu: 'Contenu.',
      imagePath: '/tmp/x.jpg',
      imageBase64: 'YWJj',
      imageMimeType: 'image/jpeg',
    })
    assert.equal(result.isError, true)
    assert.match(textOf(result), /jamais les deux/)
  } finally {
    await apiServer.close()
  }
})

test('une 422 de champs est renvoyée en isError avec le détail champ par champ', async () => {
  const { apiServer, fakeMcp } = await setupFake()
  try {
    apiServer.setResponse(422, {
      code: 'VALIDATION_ERROR',
      errors: [{ field: 'categorie', rule: 'enum', message: 'catégorie inconnue — valeurs autorisées : conseils.' }],
    })
    const handler = fakeMcp.tools.get('create_or_update_article')!
    const result = await handler({ categorie: 'inconnue', title: 'x', contenu: 'y' })
    assert.equal(result.isError, true)
    const text = textOf(result)
    assert.match(text, /categorie/)
    assert.match(text, /catégorie inconnue/)
  } finally {
    await apiServer.close()
  }
})

test('une 409 operation_in_progress est renvoyée en isError avec le jobId', async () => {
  const { apiServer, fakeMcp } = await setupFake()
  try {
    apiServer.setResponse(409, { error: 'operation_in_progress', jobId: 'job-99' })
    const handler = fakeMcp.tools.get('publish_article')!
    const result = await handler({ slug: 'mon-article' })
    assert.equal(result.isError, true)
    assert.match(textOf(result), /job-99/)
  } finally {
    await apiServer.close()
  }
})

test('create_auteur exige une bio suffisante côté API et remonte le 422 correspondant', async () => {
  const { apiServer, fakeMcp } = await setupFake()
  try {
    apiServer.setResponse(422, {
      code: 'VALIDATION_ERROR',
      errors: [{ field: 'bio', rule: 'minLength', message: 'bio trop courte.' }],
    })
    const handler = fakeMcp.tools.get('create_auteur')!
    const result = await handler({ nom: 'Jean Dupont', fonction: 'Rédacteur', bio: 'Trop court.' })
    assert.equal(result.isError, true)
    assert.match(textOf(result), /bio/)
  } finally {
    await apiServer.close()
  }
})

test("create_auteur crée un id déjà pris → 409 conflict remonté en isError", async () => {
  const { apiServer, fakeMcp } = await setupFake()
  try {
    apiServer.setResponse(409, { error: 'conflict', message: 'Un auteur "jean-dupont" existe déjà.' })
    const handler = fakeMcp.tools.get('create_auteur')!
    const bio = 'Une biographie suffisamment longue pour dépasser les cinquante caractères minimum requis.'
    const result = await handler({ id: 'jean-dupont', nom: 'Jean Dupont', fonction: 'Rédacteur', bio })
    assert.equal(result.isError, true)
    assert.match(textOf(result), /existe déjà/)
  } finally {
    await apiServer.close()
  }
})

test('list_categories et list_auteurs ne prennent aucun argument et renvoient le corps reçu', async () => {
  const { apiServer, fakeMcp } = await setupFake()
  try {
    apiServer.setResponse(200, { categories: [{ slug: 'conseils', label: 'Conseils' }] })
    const categoriesHandler = fakeMcp.tools.get('list_categories')!
    const categories = await categoriesHandler({})
    assert.match(textOf(categories), /conseils/)

    apiServer.setResponse(200, { auteurs: [{ id: 'jean-dupont', nom: 'Jean Dupont', fonction: 'Rédacteur' }] })
    const auteursHandler = fakeMcp.tools.get('list_auteurs')!
    const auteurs = await auteursHandler({})
    assert.match(textOf(auteurs), /jean-dupont/)
  } finally {
    await apiServer.close()
  }
})

test('get_article interroge GET /v1/blog/articles/:slug', async () => {
  const { apiServer, fakeMcp } = await setupFake()
  try {
    apiServer.setResponse(200, { existsOnMain: true, data: { contenu: 'Bonjour.' } })
    const handler = fakeMcp.tools.get('get_article')!
    const result = await handler({ slug: 'mon-article' })
    assert.equal(apiServer.lastRequest()?.method, 'GET')
    assert.equal(apiServer.lastRequest()?.url, '/v1/blog/articles/mon-article')
    assert.match(textOf(result), /présent sur main/)
  } finally {
    await apiServer.close()
  }
})

test('get_job_status interroge GET /v1/blog/jobs/:id', async () => {
  const { apiServer, fakeMcp } = await setupFake()
  try {
    apiServer.setResponse(200, {
      id: 'job-1',
      slug: 'x',
      action: 'article_upsert',
      status: 'pr_open',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const handler = fakeMcp.tools.get('get_job_status')!
    const result = await handler({ jobId: 'job-1' })
    assert.match(textOf(result), /pr_open/)
    assert.equal(apiServer.lastRequest()?.url, '/v1/blog/jobs/job-1')
  } finally {
    await apiServer.close()
  }
})

test("aucune sortie d'outil ne contient jamais le jeton configuré", async () => {
  const { apiServer, fakeMcp } = await setupFake()
  try {
    apiServer.setResponse(422, {
      code: 'VALIDATION_ERROR',
      errors: [{ field: 'categorie', rule: 'enum', message: 'catégorie inconnue.' }],
    })
    const handler = fakeMcp.tools.get('create_or_update_article')!
    const result = await handler({ categorie: 'x', title: 'y', contenu: 'z' })
    assert.doesNotMatch(textOf(result), new RegExp(TOKEN))
  } finally {
    await apiServer.close()
  }
})
