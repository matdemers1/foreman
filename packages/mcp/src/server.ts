import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ForemanClient } from './client.js';
import { ForemanApiError } from './client.js';
import { TOOLS } from './tools/index.js';

/**
 * The MCP server the shim exposes over stdio.
 *
 * Built on `registerTool` and `registerResource` — the SDK marks the older `tool()` and
 * `resource()` forms deprecated, and a shim written against a deprecated primitive is one that
 * breaks on an SDK upgrade rather than on a decision.
 *
 * **The protocol version is the SDK's, not the plan's.** See ADR-011: the plan specifies MCP
 * 2026-07-28, and no released TypeScript SDK supports it — 1.30.0, the newest, tops out at
 * 2025-11-25. That version carries `elicitation`, which is what Phase 2's confirmation round-trip
 * will use where the plan says MRTR `input_required`.
 */

export const SERVER_NAME = '@d3cloud/foreman-mcp';
export const SERVER_VERSION = '0.1.0';

export interface ServerOptions {
  readonly client: ForemanClient;
  readonly name?: string;
  readonly version?: string;
}

export function createServer({ client, name, version }: ServerOptions): McpServer {
  const server = new McpServer(
    { name: name ?? SERVER_NAME, version: version ?? SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'Foreman holds the plan-of-record for every D3 Cloud project: requirements, phases, ' +
        'tasks, ADRs, findings. Call foreman_brief before starting work on a project.',
    },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema.shape,
        annotations: {
          // Every tool in this phase reads. Saying so lets a client skip a confirmation it would
          // otherwise be right to ask for.
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        try {
          const result = await tool.run(client, args);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            // Advertised cache metadata: how long this answer stays good, and what it covers.
            _meta: { 'io.d3cloud.foreman/cache': tool.cache },
          };
        } catch (error) {
          // An error is returned as a tool result, not thrown: the model can read it and decide,
          // where a protocol error just ends the call.
          const message =
            error instanceof ForemanApiError
              ? `Foreman: ${error.message} (${String(error.status)})`
              : error instanceof Error
                ? error.message
                : String(error);
          return { content: [{ type: 'text' as const, text: message }], isError: true };
        }
      },
    );
  }

  return server;
}
