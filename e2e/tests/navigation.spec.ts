import { expect, test, type Page } from '@playwright/test';

/**
 * Every destination in the sidebar has a screen behind it.
 *
 * "Projects" was a static link to `/projects` — a path the router has never matched, because it
 * only ever handled `/projects/:code`. Clicking it rendered "That page does not exist", and no
 * test noticed: the suite navigated by URL, so it exercised the routes that exist rather than the
 * links the person can actually click.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

test.describe('the sidebar', () => {
  test('every link lands on a screen, and none on the not-found', async ({ page }) => {
    await signIn(page);

    const nav = page.getByRole('navigation').first();
    const hrefs = await nav.getByRole('link').evaluateAll((links) =>
      links.map((l) => l.getAttribute('href')).filter((h): h is string => h !== null && h.startsWith('/')),
    );

    // Guard the guard: an empty list would make every assertion below vacuously true.
    expect(hrefs.length).toBeGreaterThan(3);

    for (const href of hrefs) {
      await page.goto(href);
      await expect(page.getByText('That page does not exist'), `${href} has no screen`).toHaveCount(
        0,
      );
    }
  });

  test('lists the projects themselves, and reaches one by clicking', async ({ page }) => {
    await signIn(page);

    // The design is portfolio-first: the sidebar lists projects rather than linking to a list of
    // them, because the portfolio at `/` already is that list.
    const nav = page.getByRole('navigation').first();
    const project = nav.getByRole('link', { name: 'Example Project' });
    await expect(project).toBeVisible();

    await project.click();
    await expect(page).toHaveURL(/\/projects\/EXMP$/);
    await expect(page.getByText('That page does not exist')).toHaveCount(0);
  });

  test('still says so plainly for a path that really is nothing', async ({ page }) => {
    await signIn(page);
    await page.goto('/no-such-screen');

    // The fix is a sidebar that does not link to nowhere, not a router that pretends everything
    // exists.
    await expect(page.getByText('That page does not exist')).toBeVisible();
  });
});
