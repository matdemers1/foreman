/**
 * Outbound adapters — the complete list of external services Foreman talks to.
 *
 * **No LLM appears here, and none ever may** (FRM-REQ-013, ADR territory: Claude is Foreman's
 * *user*, via MCP, not its dependency). `test/unit/no-llm.test.ts` fails the build if an AI SDK
 * enters any `package.json` or an LLM host enters this list.
 */

export interface AdapterDescriptor {
  readonly name: string;
  /** The single host this adapter is permitted to reach. */
  readonly host: string;
  readonly purpose: string;
}

export const ADAPTERS: readonly AdapterDescriptor[] = [
  {
    name: 'github',
    host: 'api.github.com',
    purpose: 'GitHub App: commits, check runs, releases (ingested reality)',
  },
  {
    name: 'd3auth',
    host: 'auth.d3cloud.io',
    purpose: 'OIDC discovery, token and userinfo — the second login path',
  },
  {
    name: 'mail-relay',
    host: 'mail.d3cloud.io',
    purpose: "Alert email, through D3 Auth's Cloudflare Worker relay",
  },
];

/** Hosts that would mean the server had started calling a model. Checked, never called. */
export const FORBIDDEN_LLM_HOSTS: readonly string[] = [
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.cohere.ai',
  'api.groq.com',
  'openrouter.ai',
  'api.together.xyz',
  'bedrock-runtime.us-east-1.amazonaws.com',
];

export function adapterHosts(): string[] {
  return ADAPTERS.map((a) => a.host);
}
