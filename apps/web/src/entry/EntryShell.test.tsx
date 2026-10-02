import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ForemanMark } from '../brand/ForemanMark';
import { Login } from '../screens/Login';
import { ENTRY_CLAIMS, EntryHeading, EntryShell } from './EntryShell';

/**
 * FRM-T-13.2: the front door's frame. Rendered to static markup — the web workspace has no DOM
 * environment, and what is asserted here is structure, not behaviour: the story is there and
 * labelled, each screen has exactly one h1, and the mark has a name when it stands alone.
 */

const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

describe('the entry shell', () => {
  const html = renderToStaticMarkup(
    <EntryShell>
      <EntryHeading title="Sign in">Welcome back to the ledger.</EntryHeading>
    </EntryShell>,
  );

  it('carries the story as a labelled aside, with an h2 rather than a second h1', () => {
    expect(html).toContain('<aside aria-label="About Foreman"');
    expect(count(html, /<h2\b/g)).toBe(1);
    expect(html).toContain('checked against the code.');
  });

  it('names three claims', () => {
    expect(ENTRY_CLAIMS).toHaveLength(3);
    for (const claim of ENTRY_CLAIMS) expect(html).toContain(claim.title);
  });

  it('has exactly one h1, the form’s', () => {
    expect(count(html, /<h1\b/g)).toBe(1);
    expect(html).toMatch(/<h1[^>]*>Sign in<\/h1>/);
  });

  it('puts the form in the one main landmark', () => {
    expect(count(html, /<main\b/g)).toBe(1);
  });

  it('marks the brand beside the name as decorative, so the name is read once', () => {
    expect(html).not.toContain('role="img"');
    expect(count(html, /aria-hidden="true"[^>]*viewBox="0 0 64 64"|viewBox="0 0 64 64"[^>]*aria-hidden="true"/g)).toBe(2);
  });
});

describe('the Foreman mark', () => {
  it('is an image named Foreman when it stands alone', () => {
    const html = renderToStaticMarkup(<ForemanMark />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Foreman"');
    expect(html).not.toContain('aria-hidden');
  });

  it('is hidden from assistive technology when decorative', () => {
    const html = renderToStaticMarkup(<ForemanMark decorative />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
  });

  it('draws at the site’s icon weight below 72px and its display weight from 72px', () => {
    expect(renderToStaticMarkup(<ForemanMark size={28} />)).toContain('stroke-width="3.5"');
    expect(renderToStaticMarkup(<ForemanMark size={96} />)).toContain('stroke-width="2.2"');
  });
});

describe('Sign in, in the shell', () => {
  const noop = () => undefined;

  it('has one h1, "Sign in", and the story beside it', () => {
    const html = renderToStaticMarkup(<Login oidcAvailable={false} onSignedIn={noop} />);
    expect(count(html, /<h1\b/g)).toBe(1);
    expect(html).toMatch(/<h1[^>]*>Sign in<\/h1>/);
    expect(html).toContain('Welcome back to the ledger.');
    expect(html).toContain('aria-label="About Foreman"');
  });

  it('offers D3 Auth below the form, as a top-level navigation, when the provider is reachable', () => {
    const html = renderToStaticMarkup(<Login oidcAvailable onSignedIn={noop} />);
    expect(html).toMatch(/<a class="fm-entry-sso" href="\/auth\/oidc\/start">.*Sign in with D3 Auth<\/a>/);
    expect(html.indexOf('</form>')).toBeLessThan(html.indexOf('Sign in with D3 Auth'));
  });

  it('says nothing about D3 Auth when the provider is not reachable', () => {
    const html = renderToStaticMarkup(<Login oidcAvailable={false} onSignedIn={noop} />);
    expect(html).not.toContain('Sign in with D3 Auth');
    expect(html).not.toContain('fm-entry-or');
  });
});
