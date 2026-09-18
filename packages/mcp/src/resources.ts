import type { ForemanClient } from './client.js';

/**
 * Documents and sections as MCP resources (T-4.9, FRM-REQ-087).
 *
 * `foreman://bindery/architecture#deployment` returns three paragraphs rather than a two-thousand-
 * line document. That is the whole reason long content goes through resources and never through
 * tool output: a tool result is spent context whether or not it was the part anybody needed.
 *
 * The template is `{+rest}` — reserved expansion, which permits `/` and `#` — rather than the
 * `{address}{#section}` it would seem to want. The SDK's matcher splits the latter in the wrong
 * place: `foreman://BND/architecture#deployment` comes back as address `architecture#deploymen`
 * and section `t`. `expand` is correct and `match` is not, so the fragment is split here instead,
 * by `parseUri`, which is what actually resolves a read.
 */

export const RESOURCE_TEMPLATE = 'foreman://{code}/{+rest}';

export interface ResourceEntry {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

export interface ResourceContent {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

/** Everything addressable, listed once at connect time rather than per project. */
export async function listResources(client: ForemanClient): Promise<ResourceEntry[]> {
  const page = await client.get<{ items: ResourceEntry[] }>('/api/resources');
  return page.items;
}

/**
 * Read one URI.
 *
 * The fragment decides which of the two reads happens, and the caller never has to know there are
 * two — which is the point of addressing sections the same way as documents.
 */
export async function readResource(
  client: ForemanClient,
  uri: string,
): Promise<ResourceContent> {
  const parsed = parseUri(uri);
  if (parsed === null) {
    throw new Error(`${uri} is not a Foreman resource URI (expected foreman://<code>/<document>)`);
  }

  const { code, address, section } = parsed;
  const base = `/api/projects/${encodeURIComponent(code)}/documents/at/${encodeURIComponent(address)}`;

  const body =
    section === undefined
      ? await client.get<{ markdown: string }>(base)
      : await client.get<{ markdown: string }>(`${base}/sections/${encodeURIComponent(section)}`);

  return { uri, mimeType: 'text/markdown', text: body.markdown };
}

export interface ParsedResourceUri {
  readonly code: string;
  readonly address: string;
  readonly section?: string | undefined;
}

/**
 * Split `foreman://BND/architecture#deployment`.
 *
 * Hand-parsed rather than handed to `new URL`, for two reasons: it states the accepted shape
 * outright — a project code is 2–8 letters and digits (ADR-008) — and it returns null instead of
 * throwing, so a malformed URI is a message rather than a stack trace. The code is upper-cased on
 * the way out, because project codes are upper-case by construction and a lower-case one in a URI
 * is a person typing, not a different project.
 */
export function parseUri(uri: string): ParsedResourceUri | null {
  const match = /^foreman:\/\/([A-Za-z][A-Za-z0-9]{1,7})\/([^#?]+)(?:#(.+))?$/.exec(uri.trim());
  if (match === null) return null;

  const [, code, address, section] = match;
  if (code === undefined || address === undefined) return null;

  return {
    code: code.toUpperCase(),
    address: decodeURIComponent(address),
    ...(section === undefined ? {} : { section: decodeURIComponent(section) }),
  };
}
