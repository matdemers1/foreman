import { useState, type SyntheticEvent } from 'react';
import {
  Alert,
  AuthLayout,
  Button,
  Card,
  FormActions,
  FormField,
  Input,
  Link,
  PasswordInput,
  Stack,
} from '@d3cloud/ui';
import { ApiError, login } from '../lib/api';

/**
 * Two ways in, side by side (ADR-004).
 *
 * The password form is the primary one and is always present. The D3 Auth button appears only when
 * the server says the provider is **reachable** — a button that leads to a 503 is worse than no
 * button at all, and this screen is what someone reaches when the provider is the thing that is
 * broken.
 */

export interface LoginProps {
  oidcAvailable: boolean;
  onSignedIn: () => void;
}

export function Login({ oidcAvailable, onSignedIn }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  // A refused D3 Auth sign-in comes back as a redirect carrying its reason, because the person is
  // in a browser and never asked for JSON. Read once, then cleared from the URL so a reload or a
  // shared link does not keep re-announcing a failure that already happened.
  const [error, setError] = useState<string | null>(() => {
    const reason = new URLSearchParams(window.location.search).get('signin_error');
    if (reason !== null) window.history.replaceState(null, '', window.location.pathname);
    return reason;
  });
  const [busy, setBusy] = useState(false);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    void login(email, password, needsTotp ? totpCode : undefined)
      .then((result) => {
        if (result.status === 'totp_required') {
          setNeedsTotp(true);
          return;
        }
        onSignedIn();
      })
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 429) {
          setError('Too many attempts. Wait a moment and try again.');
          return;
        }
        // One message for every failure, because the server gives one: which half was wrong is
        // information an attacker is welcome to guess at, not to be told.
        setError(
          needsTotp ? 'That code did not match. Try the current one.' : 'Those details did not match.',
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <AuthLayout
      title="Sign in to Foreman"
      description={needsTotp ? 'One more step: the code from your authenticator.' : undefined}
    >
      <Card>
        <form onSubmit={submit}>
          <Stack gap="16">
            {error === null ? null : (
              <Alert tone="danger" title="Sign-in failed" dynamic>
                {error}
              </Alert>
            )}

            {needsTotp ? (
              <FormField label="Authentication code">
                <Input
                  name="totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  value={totpCode}
                  onChange={(e) => { setTotpCode(e.target.value); }}
                />
              </FormField>
            ) : (
              <>
                <FormField label="Email">
                  <Input
                    name="email"
                    type="email"
                    autoComplete="username"
                    autoFocus
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); }}
                  />
                </FormField>
                <FormField label="Password">
                  <PasswordInput
                    name="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); }}
                  />
                </FormField>
              </>
            )}

            <FormActions>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </FormActions>

            {oidcAvailable ? (
              // A link and not a button, because it is a navigation: the provider's redirect is a
              // top-level one, and a fetch cannot follow it.
              <Link href="/auth/oidc/start">Sign in with D3 Auth instead</Link>
            ) : null}
          </Stack>
        </form>
      </Card>
    </AuthLayout>
  );
}
