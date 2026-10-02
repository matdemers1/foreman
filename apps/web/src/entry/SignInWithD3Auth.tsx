/**
 * FRM-T-13.2 (ADR-004): the second way in, below the password form.
 *
 * Shown only when the server says the provider is **reachable** — a control that leads to a 503 is
 * worse than none, and this screen is what someone reaches when the provider is the thing that is
 * broken. The password form above it always works.
 *
 * A link and not a button, because it is a navigation: the provider's redirect is a top-level one,
 * and a fetch cannot follow it. `/auth/oidc/start` is a server route the console's router leaves
 * alone.
 */
export const D3AUTH_START = '/auth/oidc/start';
export const D3AUTH_LABEL = 'Sign in with D3 Auth';

export function SignInWithD3Auth({ available }: { available: boolean }) {
  if (!available) return null;
  return (
    <div className="fm-entry-sso-group">
      <div className="fm-entry-or" aria-hidden="true">
        <span />
        or
        <span />
      </div>
      <a className="fm-entry-sso" href={D3AUTH_START}>
        <KeyGlyph />
        {D3AUTH_LABEL}
      </a>
    </div>
  );
}

function KeyGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="fm-entry-sso__glyph"
    >
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M18 12v3M15.5 12v2" />
    </svg>
  );
}
