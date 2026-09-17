import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { loadConfig } from './config.js'
import { BlogApiClient } from './blog_api_client.js'
import { registerBlogTools } from './tools.js'

/**
 * Construit le serveur MCP et l'attache au transport stdio (specs §7 :
 * « transport stdio »). Séparé de `index.ts` pour rester testable sans
 * démarrer réellement le transport (les tests appellent `registerBlogTools`
 * directement sur un `BlogApiClient` bouchonné).
 */
export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadConfig(env)
  const api = new BlogApiClient(config)

  const server = new McpServer({
    name: 'estimer-blog-mcp',
    version: '0.1.0',
  })

  registerBlogTools(server, api)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
