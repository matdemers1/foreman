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

// ─── The read surface the console renders ──────────────────────────────────

export interface PortfolioRow {
  code: string;
  name: string;
  lifecycle: string;
  phase: { humanId: string; number: string; name: string } | null;
  tasks: { open: number; blocked: number; done: number };
  openCriticals: number;
  /** `unknown` is a third state, and renders grey rather than green (S-04). */
  ci: { conclusion: string | null; unknown: boolean };
  drift: { uncoveredRequirements: number; unconfirmedAttributions: number };
  lastActivityAt: string | null;
}

export interface ProjectDetail {
  code: string;
  name: string;
  lifecycle: string;
  pitch: string | null;
  counts: { phases: number; requirements: number; tasks: number; openFindings: number };
}

export interface PhaseRow {
  id: string;
  humanId: string;
  number: string;
  sortOrder: number;
  name: string;
  objective: string | null;
  status: string;
  exitDemo: string | null;
  size: string | null;
}

export interface TaskRow {
  id: string;
  humanId: string;
  title: string;
  status: string;
  blockedReason: string | null;
  size: string | null;
  doneWhen: string | null;
  phaseId: string | null;
  files: string[];
  requirements: string[];
}

export interface Brief {
  project: { code: string; name: string; lifecycle: string; pitch: string | null };
  activePhase: {
    humanId: string;
    number: string;
    name: string;
    objective: string | null;
    exitDemo: string | null;
    tasks: { done: number; total: number };
  } | null;
  nextTasks: { humanId: string; title: string; status: string; size: string | null }[];
  blocked: { humanId: string; title: string; reason: string | null }[];
  openCriticals: { humanId: string; severity: string; title: string; location: string | null }[];
  ci: { conclusion: string | null; commitSha: string | null; at: string | null; unknown: boolean };
  drift: {
    uncoveredRequirements: number;
    unconfirmedAttributions: number;
    firedRisks: number;
  };
  recentCommits: { sha: string; message: string; at: string }[];
}

export interface EntityResult {
  type: string;
  humanId: string;
  projectCode: string;
  entity: Record<string, unknown>;
  backlinks: { fromType: string; humanId: string | null; title: string; kind: string }[];
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number | null;
}

export const foreman = {
  portfolio: () => api.get<Page<PortfolioRow>>('/api/portfolio'),
  project: (code: string) => api.get<ProjectDetail>(`/api/projects/${code}`),
  phases: (code: string) => api.get<Page<PhaseRow>>(`/api/projects/${code}/phases`),
  tasks: (code: string, phaseHumanId?: string) =>
    api.get<Page<TaskRow>>(
      `/api/projects/${code}/tasks?limit=200${phaseHumanId === undefined ? '' : `&phase=${phaseHumanId}`}`,
    ),
  brief: (code: string) => api.get<Brief>(`/api/brief/${code}`),
  entity: (humanId: string) => api.get<EntityResult>(`/api/entities/${humanId}`),
};
