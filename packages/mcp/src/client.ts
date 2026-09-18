/**
 * The shim's HTTP client.
 *
 * The shim holds a scoped Foreman API token and speaks HTTPS to the API (ADR-003). It is the only
 * thing here that knows a network exists — the tools are pure translations of MCP calls into
 * requests, which is what keeps them testable without a server.
 */

export class ForemanApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ForemanApiError';
  }
}

/** What a query parameter may be. The shared schemas produce nothing else. */
export type QueryValue = string | number | boolean | readonly string[] | undefined | null;

export interface ForemanClient {
  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T>;
  post<T>(path: string, body: unknown, query?: Record<string, QueryValue>): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
}

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Swapped in tests. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createClient(options: ClientOptions): ForemanClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl.replace(/\/$/, '');

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    query: Record<string, QueryValue> = {},
  ): Promise<T> {
      const url = new URL(`${base}${path}`);
      for (const [key, value] of Object.entries(query)) {
        // An array parameter is sent comma-joined, which is what the API parses. Everything else
        // is a string, number or boolean by construction: the shared schemas admit nothing else.
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
      }

      // A hung request must not hang the whole session: the shim is in Claude's critical path.
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        const res = await doFetch(url, {
          method,
          headers: {
            authorization: `Bearer ${options.token}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });

        const text = await res.text();
        const answer: unknown = text.length > 0 ? JSON.parse(text) : undefined;

        if (!res.ok) {
          const message =
            typeof answer === 'object' && answer !== null && 'error' in answer
              ? String(answer.error)
              : `Foreman answered ${String(res.status)}`;
          throw new ForemanApiError(res.status, message);
        }
        return answer as T;
      } catch (error) {
        if (error instanceof ForemanApiError) throw error;
        if (error instanceof Error && error.name === 'AbortError') {
          throw new ForemanApiError(504, `Foreman did not answer within ${String(timeoutMs)}ms`);
        }
        throw new ForemanApiError(
          502,
          `could not reach Foreman: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timer);
      }
  }

  return {
    get: <T>(path: string, query?: Record<string, QueryValue>) =>
      request<T>('GET', path, undefined, query),
    post: <T>(path: string, body: unknown, query?: Record<string, QueryValue>) =>
      request<T>('POST', path, body, query),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
    del: <T>(path: string) => request<T>('DELETE', path),
  };
}
