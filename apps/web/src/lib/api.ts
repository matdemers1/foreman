/**
 * The console's one way to reach the API.
 *
 * Same origin — the server serves this bundle — so the session cookie travels on its own and there
 * is no CORS, no token in `localStorage`, and nothing for a script on the page to steal.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Headers may legally be an array of pairs, which does not spread into an object — it spreads
  // into indices, and the header silently disappears.
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('content-type', 'application/json');

  const res = await fetch(path, {
    ...init,
    headers,
    // Explicit, though same-origin is the default: this is the whole authentication story.
    credentials: 'same-origin',
  });

  // 204 has no body to parse, and every caller of a 204 route asks for `undefined`.
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String(body.error)
        : `request failed with ${String(res.status)}`;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      // Spread rather than an undefined value: `exactOptionalPropertyTypes` distinguishes
      // "no body" from "a body that is undefined", and `RequestInit` accepts only the first.
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
};

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  status: 'invited' | 'active' | 'suspended';
}

export interface SessionState {
  authenticated: true;
  user: SessionUser;
  totpEnrolled: boolean;
  /** Whether D3 Auth is reachable — not merely configured. A button to a 503 is worse than none. */
  oidcAvailable: boolean;
}

export async function fetchSession(): Promise<SessionState | null> {
  try {
    return await api.get<SessionState>('/auth/session');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export type LoginResult = { status: 'signed_in' } | { status: 'totp_required' };

export function login(email: string, password: string, totpCode?: string): Promise<LoginResult> {
  return api.post<LoginResult>('/auth/login', {
    email,
    password,
    ...(totpCode !== undefined && totpCode.length > 0 ? { totpCode } : {}),
  });
}

export async function logout(): Promise<void> {
  await api.post<undefined>('/auth/logout');
}
