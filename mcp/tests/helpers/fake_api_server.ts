import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Faux serveur HTTP local pour les tests du client `BlogApiClient` et des
 * outils MCP : enregistre la dernière requête reçue (méthode, chemin,
 * en-têtes, corps JSON) et répond avec le statut/corps configuré par le
 * test. Aucune dépendance externe, pur `node:http`.
 */
export interface RecordedRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: unknown
}

export interface FakeApiServer {
  url: string
  close: () => Promise<void>
  setResponse: (status: number, body: unknown) => void
  lastRequest: () => RecordedRequest | undefined
}

export async function startFakeApiServer(): Promise<FakeApiServer> {
  let status = 200
  let responseBody: unknown = {}
  let lastRequest: RecordedRequest | undefined

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsedBody: unknown
      if (raw.length > 0) {
        try {
          parsedBody = JSON.parse(raw)
        } catch {
          parsedBody = raw
        }
      }
      lastRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: parsedBody }
      const payload = JSON.stringify(responseBody)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(payload)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
    setResponse: (newStatus: number, newBody: unknown) => {
      status = newStatus
      responseBody = newBody
    },
    lastRequest: () => lastRequest,
  }
}
