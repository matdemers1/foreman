import { expect, test } from '@playwright/test';

/**
 * The Phase 0 exit demo, as a suite.
 *
 * The account and password come from the seed, which CI runs immediately before this.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('the console', () => {
  test('serves the built console from the API, at one origin', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-type']).toContain('text/html');
    await expect(page.getByRole('heading', { name: 'Sign in to Foreman' })).toBeVisible();
  });

  test('signs in with a password and lands on the shell', async ({ page }) => {
    await signIn(page);

    await expect(page.getByRole('navigation')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Portfolio' })).toBeVisible();
    // The account menu names who is signed in, which is how you know the session is real.
    await expect(page.getByText(EMAIL)).toBeVisible();
  });

  test('refuses a wrong password without saying which half was wrong', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
    await page.getByRole('textbox', { name: 'Password' }).fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('Those details did not match.')).toBeVisible();
    await expect(page.getByRole('navigation')).toBeHidden();
  });

  test('does not offer a sign-in provider that is not reachable', async ({ page }) => {
    await page.goto('/');
    // Nothing is configured in the dev stack, and the console asks before offering the button.
    await expect(page.getByRole('link', { name: /D3 Auth/ })).toBeHidden();
  });

  test('sets a session cookie that JavaScript cannot read', async ({ page, context }) => {
    await signIn(page);
    await expect(page.getByRole('navigation')).toBeVisible();

    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name.endsWith('foreman_session'));
    expect(session, 'a session cookie should have been set').toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');

    // The whole point of HttpOnly: a script on the page cannot see it.
    const visible = await page.evaluate<string>('document.cookie');
    expect(visible).not.toContain('foreman_session');
  });

  test('signs out, and the session does not come back on reload', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('navigation')).toBeVisible();

    await page.getByRole('button', { name: new RegExp(EMAIL.split('@')[0] ?? 'Developer') }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();

    await expect(page.getByRole('heading', { name: 'Sign in to Foreman' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sign in to Foreman' })).toBeVisible();
  });

  test('renders the shell on a phone, with the navigation reachable', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);

    // Below the shell breakpoint the sidebar is a drawer behind a control, not a missing feature.
    const opener = page.getByRole('button', { name: /menu|navigation/i }).first();
    await expect(opener).toBeVisible();
    await opener.click();
    await expect(page.getByRole('link', { name: 'Portfolio' })).toBeVisible();
  });
});

test.describe('the API', () => {
  test('404s an unknown API path in JSON, never as HTML', async ({ request }) => {
    const res = await request.get('/auth/nope');
    expect(res.status()).toBe(404);
    expect(res.headers()['content-type']).toContain('application/json');
  });

  test('reports its schema revision, which is the standing deploy rule', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { schemaRevision: string | null };
    expect(body.schemaRevision).toMatch(/^\d{14}_/);
  });

  test('is ready, and says so separately from being alive', async ({ request }) => {
    expect((await request.get('/healthz')).ok()).toBe(true);
    expect((await request.get('/readyz')).ok()).toBe(true);
  });
});
