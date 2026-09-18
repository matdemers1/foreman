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

/**
 * A read that keeps the version with the body.
 *
 * `If-Match` is how a concurrent edit becomes visible instead of silently winning (FRM-REQ-146),
 * and the version is only in the response header — so any screen that intends to write back has to
 * take it at read time or it has nothing to send.
 *
 * Deliberately not generic: the one caller knows what it is reading, and a type parameter used
 * only in the return position is an unchecked cast wearing a signature.
 */
async function requestWithEtag(path: string): Promise<{ body: unknown; etag: string | null }> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const text = await res.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String(body.error)
        : `request failed with ${String(res.status)}`;
    throw new ApiError(res.status, message, body);
  }
  return { body, etag: res.headers.get('etag') };
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
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  getWithEtag: (path: string) => requestWithEtag(path),
  put: <T>(path: string, body: unknown, etag?: string | null) =>
    request<T>(path, {
      method: 'PUT',
      body: JSON.stringify(body),
      ...(etag === undefined || etag === null ? {} : { headers: { 'if-match': etag } }),
    }),
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

export async function fetchSession(): Promise<SessionState | AnonymousState> {
  try {
    return await api.get<SessionState>('/auth/session');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // The body of a 401 is where the login screen learns whether to offer the second path.
      const body = error.body as Partial<AnonymousState> | undefined;
      return { authenticated: false, oidcAvailable: body?.oidcAvailable ?? false };
    }
    throw error;
  }
}

/** What the 401 carries: no session, but enough to render the right login screen. */
export interface AnonymousState {
  authenticated: false;
  oidcAvailable: boolean;
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

export interface RequirementRow {
  id: string;
  humanId: string;
  statement: string;
  priority: string;
  source: string | null;
  acceptanceTest: string | null;
  earsPattern: string;
  earsLintOk: boolean;
  earsLintNote: string | null;
  phase: { humanId: string; name: string } | null;
  /** How many live tasks cite it. Zero is the coverage hole, and the screen says so. */
  coveredBy: number;
  satisfiedBy: { humanId: string; status: string }[];
}

/** What S-13's four filters compile to. Every one of them is applied by the server. */
export interface RequirementFilters {
  priority?: string;
  /** A phase human ID, or `none` for the backlog. */
  phase?: string;
  uncovered?: boolean;
  earsLint?: 'ok' | 'warned';
  limit?: number;
  cursor?: string;
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

export interface Coverage {
  project: string;
  requirements: { total: number; covered: number; musts: number; mustsCovered: number };
  uncoveredMusts: { humanId: string; statement: string; priority: string }[];
  uncovered: { humanId: string; statement: string; priority: string }[];
  withoutAcceptanceTest: { humanId: string; statement: string }[];
  tasksWithoutRequirements: { humanId: string; title: string }[];
  earsWarnings: { humanId: string; statement: string; note: string }[];
}

export interface MatrixRow {
  humanId: string;
  statement: string;
  priority: string;
  earsPattern: string;
  earsLintOk: boolean;
  acceptanceTest: string | null;
  phase: { humanId: string; number: string; name: string } | null;
  satisfiedBy: { humanId: string; title: string; status: string }[];
}

export interface ScopeOfWorkTask {
  humanId: string;
  title: string;
  status: string;
  size: string | null;
  blockedReason: string | null;
  doneWhen: string | null;
  satisfies: string[];
}

export interface ScopeOfWork {
  project: { code: string; name: string };
  phases: {
    humanId: string;
    number: string;
    name: string;
    objective: string | null;
    status: string;
    exitDemo: string | null;
    size: string | null;
    tasks: ScopeOfWorkTask[];
    done: number;
    uncoveredMusts: string[];
  }[];
  unphased: ScopeOfWorkTask[];
  generatedAt: string;
}

export interface GateResult {
  phase: string;
  passed: boolean;
  failures: { kind: string; humanId: string; detail: string }[];
}

export interface DocumentSection {
  id: string;
  key: string;
  heading: string;
  bodyMd: string;
  sortOrder: number;
  updatedAt: string;
}

export interface DocumentDetail {
  id: string;
  kind: string;
  title: string;
  sourcePath: string | null;
  phase: { humanId: string; name: string } | null;
  sections: DocumentSection[];
  updatedAt: string;
}

export interface DocumentRow {
  id: string;
  kind: string;
  title: string;
  phase: { humanId: string; name: string } | null;
  sections: { key: string; heading: string; sortOrder: number }[];
  updatedAt: string;
}

export interface Revision {
  revisionNo: number;
  actor: string;
  actorKind: string;
  note: string | null;
  createdAt: string;
}

export interface DiffResult {
  from: number;
  to: number;
  sections: {
    key: string;
    heading: string;
    status: 'added' | 'removed' | 'changed' | 'unchanged';
    lines: { kind: 'added' | 'removed' | 'same'; text: string }[];
  }[];
}

export interface AdrRow {
  id: string;
  humanId: string;
  number: number;
  title: string;
  status: string;
  decisionAbstract: string | null;
  contextMd: string | null;
  decisionMd: string | null;
  consequencesMd: string | null;
  rejectedMd: string | null;
  decidedOn: string | null;
  relations: { kind: string; relatedAdr: { humanId: string; title: string } }[];
}

export interface AdrGraph {
  nodes: { humanId: string; title: string; status: string }[];
  edges: { from: string; to: string; kind: string }[];
  cycle: string[] | null;
}

export interface RiskRow {
  id: string;
  humanId: string;
  title: string;
  likelihood: string;
  impact: string;
  mitigation: string | null;
  tripwire: string | null;
  status: string;
  firedAt: string | null;
  phase: { humanId: string; name: string } | null;
}

export interface DecisionRow {
  id: string;
  humanId: string;
  statement: string;
  value: string;
  rationale: string | null;
  lockedAt: string | null;
}

export interface TermRow {
  id: string;
  term: string;
  definition: string;
  aliases: string[];
  scope: 'project' | 'ecosystem';
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
  requirements: (code: string, filters: RequirementFilters = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) query.set(key, String(value));
    }
    return api.get<Page<RequirementRow>>(
      `/api/projects/${code}/requirements?${query.toString()}`,
    );
  },
  coverage: (code: string) => api.get<Coverage>(`/api/projects/${code}/coverage`),
  matrix: (code: string) => api.get<Page<MatrixRow>>(`/api/projects/${code}/matrix`),
  scopeOfWork: (code: string) => api.get<ScopeOfWork>(`/api/projects/${code}/scope-of-work`),
  gate: (code: string, phaseHumanId: string) =>
    api.get<GateResult>(`/api/projects/${code}/phases/${phaseHumanId}/gate`),
  documents: (code: string) => api.get<Page<DocumentRow>>(`/api/projects/${code}/documents`),
  /** Read with the version, because this screen writes back to it. */
  document: async (code: string, id: string) => {
    const { body, etag } = await api.getWithEtag(`/api/projects/${code}/documents/${id}`);
    return { body: body as DocumentDetail, etag };
  },
  saveSection: (
    code: string,
    id: string,
    key: string,
    body: { bodyMd: string; heading?: string; note?: string },
    etag: string | null,
  ) =>
    api.put<DocumentSection>(
      `/api/projects/${code}/documents/${id}/sections/${key}`,
      body,
      etag,
    ),
  revisions: (code: string, id: string) =>
    api.get<Page<Revision>>(`/api/projects/${code}/documents/${id}/revisions`),
  diff: (code: string, id: string, from: number, to: number) =>
    api.get<DiffResult>(
      `/api/projects/${code}/documents/${id}/diff?from=${String(from)}&to=${String(to)}`,
    ),
  adrs: (code: string) => api.get<Page<AdrRow>>(`/api/projects/${code}/adrs`),
  adrGraph: (code: string) => api.get<AdrGraph>(`/api/projects/${code}/adrs-graph`),
  risks: (code: string) => api.get<Page<RiskRow>>(`/api/projects/${code}/risks`),
  decisions: (code: string) => api.get<Page<DecisionRow>>(`/api/projects/${code}/decisions`),
  glossary: (code: string) => api.get<Page<TermRow>>(`/api/projects/${code}/glossary`),
  brief: (code: string) => api.get<Brief>(`/api/brief/${code}`),
  entity: (humanId: string) => api.get<EntityResult>(`/api/entities/${humanId}`),
};
