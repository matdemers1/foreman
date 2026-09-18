#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from './client.js';
import { createServer } from './server.js';

/**
 * `@d3cloud/foreman-mcp` — the stdio shim (ADR-003).
 *
 * A small process Claude launches. It holds a scoped Foreman API token and translates MCP calls
 * into HTTPS requests, which means **there is no public MCP endpoint to attack** and none of the
 * remote-authorization surface has to exist. The honest cost: it only works where it is installed.
 *
 *   FOREMAN_URL=https://foreman.d3cloud.io FOREMAN_TOKEN=… foreman-mcp
 */

const baseUrl = process.env['FOREMAN_URL'];
const token = process.env['FOREMAN_TOKEN'];

if (baseUrl === undefined || token === undefined) {
  // stderr, never stdout: stdout is the protocol channel, and a stray line there is a parse error
  // at the other end rather than a message anyone reads.
  process.stderr.write(
    'foreman-mcp: set FOREMAN_URL and FOREMAN_TOKEN.\n' +
      '  FOREMAN_URL=https://foreman.d3cloud.io\n' +
      '  FOREMAN_TOKEN=<a scoped token from Foreman>\n',
  );
  process.exit(1);
}

const server = createServer({ client: createClient({ baseUrl, token }) });
await server.connect(new StdioServerTransport());
