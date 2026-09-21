import { useCallback, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Cluster,
  EmptyState,
  FormActions,
  FormField,
  Grid,
  Input,
  Modal,
  Page,
  PageHeader,
  Section,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { foreman, type IssuedToken, type TokenRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { Pill, StatCard } from '../ui/viz';
import { relativeDay } from '../ui/tone';

/**
 * Scoped API tokens (FRM-REQ-025, FRM-REQ-026, FRM-REQ-027).
 *
 * The routes have existed since P2 and nothing in the console reached them, so the only way to
 * mint a token was `issue-token` over SSH on the host. That made the one credential the audit and
 * planning skills need — `FOREMAN_WRITE_TOKEN` — something you could not obtain from the tool that
 * issues it, which is the same shape of gap as Bindery's Phase 20 shipping its provider settings
 * only as a compose file to edit over SSH.
 *
 * Three rules the screen is built around, each of them the API's rule made visible:
 *
 * - **The secret is shown once.** No route returns it again. The dialog says so before you close
 *   it, and closing it is the only way out — there is no "show me again" to look for later.
 * - **Read is the default.** Write is a deliberate tick, because a token that can write is a
 *   token that can rewrite the plan, and the path of least resistance should not be the powerful
 *   one.
 * - **Revoked is a state, not a deletion.** A revoked row stays visible: "this token existed and
 *   was turned off" is what you want to read six months later, and a row that vanishes tells you
 *   nothing about whether it was ever there.
 */

const SCOPES = [
  { value: 'read', label: 'Read', detail: 'Answer questions. Every GET.' },
  { value: 'write', label: 'Write', detail: 'Create and change records.' },
  { value: 'admin', label: 'Admin', detail: 'Manage tokens and accounts.' },
];

function scopeTone(scope: string) {
  return scope === 'admin' ? 'danger' : scope === 'write' ? 'warning' : 'neutral';
}

/** Live, revoked, or expired — the three states a row can be in, decided in one place. */
function stateOf(row: TokenRow): { label: string; tone: 'success' | 'neutral' | 'warning' } {
  if (row.revokedAt !== null) return { label: 'revoked', tone: 'neutral' };
  if (row.expiresAt !== null && new Date(row.expiresAt).getTime() < Date.now()) {
    return { label: 'expired', tone: 'warning' };
  }
  return { label: 'active', tone: 'success' };
}

export function Tokens() {
  const { state, reload } = useAsync(() => foreman.tokens(), []);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<IssuedToken | null>(null);

  const rows = state.status === 'ready' ? state.value.items : [];
  const active = rows.filter((row) => stateOf(row).label === 'active');
  const writers = active.filter((row) => row.scopes.includes('write') || row.scopes.includes('admin'));

  const onIssued = useCallback(
    (token: IssuedToken) => {
      setCreating(false);
      setIssued(token);
      reload();
    },
    [reload],
  );

  return (
    <Page>
      <PageHeader
        title="API tokens"
        description="For the MCP shim, the audit skills, and anything that talks to Foreman without a browser."
        {...(state.status === 'ready'
          ? { count: active.length, countNoun: { one: 'active token', other: 'active tokens' } }
          : {})}
        actions={
          <Button variant="primary" onClick={() => { setCreating(true); }}>
            Issue a token
          </Button>
        }
      />

      <Stack gap="24">
        <Grid minItemWidth="sm">
          <StatCard label="Active" value={active.length} detail="Usable right now" />
          <StatCard
            label="Can write"
            value={writers.length}
            tone={writers.length === 0 ? 'neutral' : 'warning'}
            detail="Able to change the plan"
          />
          <StatCard
            label="Revoked or expired"
            value={rows.length - active.length}
            detail="Kept, so the history reads"
          />
        </Grid>

        <Section title="Every token" surface="card">
          {state.status === 'loading' ? (
            <Skeleton lines={4} />
          ) : state.status === 'error' ? (
            <EmptyState kind="error" heading="The tokens did not load">
              {state.message}
            </EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState kind="empty" size="inline" heading="No tokens yet">
              Issue one for the MCP shim, or for the audit skills to write findings with.
            </EmptyState>
          ) : (
            <Stack gap="8">
              {rows.map((row) => {
                const here = stateOf(row);
                return (
                  <Card key={row.id} padding="sm">
                    <Cluster gap="12" align="center" justify="between">
                      <Stack gap="4">
                        <Cluster gap="8" align="center">
                          <span className="fm-card__title">{row.name}</span>
                          <Pill tone={here.tone} dot>
                            {here.label}
                          </Pill>
                        </Cluster>
                        <Cluster gap="8" align="center">
                          <code className="fm-card__code">{row.prefix}…</code>
                          {row.scopes.map((scope) => (
                            <Pill key={scope} tone={scopeTone(scope)}>
                              {scope}
                            </Pill>
                          ))}
                        </Cluster>
                        <span className="fm-muted">
                          {/* "Never used" is worth saying plainly: it is how you find the token
                              you issued, pasted wrong, and replaced without revoking. */}
                          {row.lastUsedAt === null
                            ? 'never used'
                            : `last used ${relativeDay(row.lastUsedAt)}`}
                          {' · '}
                          issued {relativeDay(row.createdAt)}
                          {row.expiresAt === null ? '' : ` · expires ${relativeDay(row.expiresAt)}`}
                        </span>
                      </Stack>
                      {row.revokedAt === null && (
                        <Button
                          onClick={() => {
                            void foreman.revokeToken(row.id).then(reload);
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                    </Cluster>
                  </Card>
                );
              })}
            </Stack>
          )}
        </Section>
      </Stack>

      <IssueDialog open={creating} onClose={() => { setCreating(false); }} onIssued={onIssued} />
      <ShownOnceDialog issued={issued} onClose={() => { setIssued(null); }} />
    </Page>
  );
}

function IssueDialog({
  open,
  onClose,
  onIssued,
}: {
  open: boolean;
  onClose: () => void;
  onIssued: (token: IssuedToken) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (scope: string, on: boolean) => {
    setScopes((current) =>
      on ? [...new Set([...current, scope])] : current.filter((s) => s !== scope),
    );
  };

  const submit = () => {
    setBusy(true);
    setError(null);
    foreman
      .issueToken({ name: name.trim(), scopes })
      .then((token) => {
        setName('');
        setScopes(['read']);
        onIssued(token);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => { setBusy(false); });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Issue an API token"
      description="Named, scoped, and shown exactly once."
    >
      <Stack gap="16">
        <FormField label="What is it for" help="Named so you can tell two apart a year from now.">
          <Input
            value={name}
            onChange={(event) => { setName(event.target.value); }}
            placeholder="matt's laptop — MCP shim"
          />
        </FormField>

        <Stack gap="8">
          <span className="fm-part__label">Scopes</span>
          {SCOPES.map((scope) => (
            <Stack key={scope.value} gap="2">
              <Checkbox
                checked={scopes.includes(scope.value)}
                onCheckedChange={(next) => { toggle(scope.value, next === true); }}
                label={scope.label}
              />
              <span className="fm-scope__detail">{scope.detail}</span>
            </Stack>
          ))}
        </Stack>

        {scopes.includes('write') || scopes.includes('admin') ? (
          <Alert tone="warning" title="This token will be able to change the plan">
            Give it only to something that should. Revoking takes effect on the next request.
          </Alert>
        ) : null}

        {error !== null && <Alert tone="danger" title="It was not issued">{error}</Alert>}

        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || name.trim().length === 0 || scopes.length === 0}
            onClick={submit}
          >
            {busy ? 'Issuing…' : 'Issue'}
          </Button>
        </FormActions>
      </Stack>
    </Modal>
  );
}

/**
 * The secret, once.
 *
 * Deliberately not auto-dismissed and not copied for you: the one irreversible moment in this
 * screen is closing this dialog, so it says what is about to be lost and makes closing the
 * deliberate act.
 */
function ShownOnceDialog({
  issued,
  onClose,
}: {
  issued: IssuedToken | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={issued !== null}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={issued === null ? '' : `“${issued.name}” is ready`}
      description="This is the only time it is shown. No route returns it again."
    >
      {issued !== null && (
        <Stack gap="16">
          <pre className="fm-secret">{issued.token}</pre>
          <Alert tone="warning" title="Copy it before you close this">
            Foreman stores only a hash. If you lose it, issue another and revoke this one.
          </Alert>
          <Stack gap="4">
            <span className="fm-part__label">For the audit and planning skills</span>
            <pre className="fm-secret fm-secret--quiet">
              {`export FOREMAN_URL=${window.location.origin}\nexport FOREMAN_WRITE_TOKEN=${issued.token}`}
            </pre>
          </Stack>
          <FormActions>
            <Button variant="primary" onClick={onClose}>
              I have copied it
            </Button>
          </FormActions>
        </Stack>
      )}
    </Modal>
  );
}
