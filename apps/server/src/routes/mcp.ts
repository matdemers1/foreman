import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createMcpServer } from '@d3cloud/foreman-mcp/server';
import { createClient } from '@d3cloud/foreman-mcp/client';
import type { Config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';
import { wwwAuthenticate } from '../auth/resource-server.js';
import { logger } from '../logger.js';

/**
 * The remote MCP endpoint (ADR-013, P-01).
 *
 * **Stateless.** A fresh server and transport per request, with `sessionIdGenerator: undefined`.
 * The 2025-11-25 core needs no handshake and no `Mcp-Session-Id`, so there is nothing to keep
 * between requests — which is the property that lets this run behind the tunnel with no shared
 * storage, and the reason ADR-003 called the remote path "purely additive".
 *
 * **The same tools, reached the same way.** The MCP server here is the one the stdio shim builds,
 * handed a client that loops back to Foreman's own API carrying the caller's token. Every tool call
 * therefore re-enters the ordinary request path and passes the ordinary guards; there is no second
 * authorization surface for a scope check to be missing from.
 */

export interface McpRouteDeps {
  readonly config: Config;
}

export function mcpRoutes({ config }: McpRouteDeps): Router {
  const router = Router();

  // A request with no usable token gets the RFC 9728 challenge, not a bare 401: the challenge is
  // how a client discovers where to authenticate, and without it the connector has nothing to go on.
  router.use((req, res, next) => {
    if (req.auth === undefined) {
      res.setHeader('WWW-Authenticate', wwwAuthenticate(config));
    }
    next();
  }, requireAuth);

  router.post('/', (req, res) => {
    void (async () => {
      // The caller's own token, forwarded to Foreman's API — not exchanged, not upgraded. The
      // loopback call is authenticated as the person who made the MCP request and by nothing else.
      const authorization = req.headers.authorization ?? '';
      // The port this request actually arrived on, not the configured one. They agree in
      // production and differ wherever the server was given port 0 — and a loopback call to the
      // wrong port is a connection refused that looks like the MCP server being broken.
      const port = req.socket.localPort ?? config.PORT;
      const client = createClient({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        token: authorization.replace(/^Bearer /, ''),
      });

      const server = createMcpServer({ client });
      // Stateless mode is selected by passing `sessionIdGenerator` as an explicit `undefined`,
      // which `exactOptionalPropertyTypes` forbids and the SDK's own option type does not admit.
      // Cast rather than drop the key: omitting it selects *stateful* mode, which is the opposite
      // of what this endpoint wants.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);

      // Closed when the response ends, both ways: a transport left open per request is a leak that
      // only shows up under load.
      res.on('close', () => {
        void transport.close();
        void server.close();
      });

      // The SDK's `Transport` declares `onclose?` in a way this repo's stricter optional-property
      // checking rejects; the object is the SDK's own and satisfies it structurally.
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      // `req.auth` is Foreman's own `AuthContext`, declared globally on Express's Request; the SDK
      // wants its own `AuthInfo` on that same property name. Nothing here reads the SDK's version —
      // authorization already happened in `attachAuth` — so the collision is in the types only.
      await transport.handleRequest(
        req as unknown as Parameters<typeof transport.handleRequest>[0],
        res,
        req.body,
      );
    })().catch((error: unknown) => {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'the MCP request failed',
      );
      if (!res.headersSent) {
        res.status(500).json({ error: 'the MCP request could not be handled' });
      }
    });
  });

  // GET is the server-initiated stream, which a stateless server has no use for; DELETE ends a
  // session that was never created. Both answered plainly rather than left to the SPA.
  for (const method of ['get', 'delete'] as const) {
    router[method]('/', (_req, res) => {
      res.status(405).json({ error: 'this MCP endpoint is stateless; use POST' });
    });
  }

  return router;
}
