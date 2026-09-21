import { useState, type SyntheticEvent } from 'react';
import {
  Alert,
  AuthLayout,
  Button,
  Card,
  FormActions,
  FormField,
  PasswordInput,
  Stack,
} from '@d3cloud/ui';
import { foreman, ApiError } from '../lib/api';

/**
 * Accepting an invitation (FRM-ADR-016).
 *
 * Rendered before the login branch, because the person following this link has no account yet —
 * which is the entire point of the link. The token rides in the query string, where the email put
 * it, and is spent the moment a password is chosen.
 *
 * **Accepting does not sign anybody in.** It sets a password and then asks for it. A forwarded
 * invitation email must not be a session, and the extra step is the difference.
 */
export function AcceptInvite() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const tooShort = password.length > 0 && password.length < 12;
  const mismatch = again.length > 0 && again !== password;

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (password !== again) {
      setError('Those two do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    void foreman
      .acceptInvite({ token, password })
      .then(() => { setDone(true); })
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError ? caught.message : 'That invitation could not be accepted.',
        );
      })
      .finally(() => { setBusy(false); });
  };

  if (token.length === 0) {
    return (
      <AuthLayout title="That link is incomplete">
        <Card padding="md">
          <p>
            The invitation link needs the token it was sent with. Open it from the email rather
            than retyping it, or ask for a new invitation.
          </p>
        </Card>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout title="Your account is ready">
        <Card padding="md">
          <Stack gap="16">
            <p>Sign in with the password you just set.</p>
            <Button variant="primary" onClick={() => { window.location.assign('/'); }}>
              Go to sign in
            </Button>
          </Stack>
        </Card>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a password">
      <Card padding="md">
        <form onSubmit={submit}>
          <Stack gap="16">
            {error !== null && (
              <Alert tone="danger" title="That did not work" dynamic>
                {error}
              </Alert>
            )}

            <FormField
              label="Password"
              help="At least 12 characters. Length beats cleverness — a passphrase is fine."
              {...(tooShort ? { error: 'A little longer.' } : {})}
            >
              <PasswordInput
                name="password"
                value={password}
                autoComplete="new-password"
                onChange={(e) => { setPassword(e.target.value); }}
              />
            </FormField>

            <FormField
              label="And again"
              {...(mismatch ? { error: 'These do not match.' } : {})}
            >
              <PasswordInput
                name="again"
                value={again}
                autoComplete="new-password"
                onChange={(e) => { setAgain(e.target.value); }}
              />
            </FormField>

            <FormActions>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || password.length < 12 || password !== again}
              >
                {busy ? 'Setting…' : 'Set password'}
              </Button>
            </FormActions>
          </Stack>
        </form>
      </Card>
    </AuthLayout>
  );
}
