import { expect, test, type Page } from '@playwright/test';

/**
 * A project idea's own page (FRM-ADR-017, FRM-REQ-173 … FRM-REQ-178).
 *
 * The page's claim is that an idea can be grown in place — every section, list and reading saves
 * as it is changed, with no page-level Save to forget. So each test here changes something and
 * then reloads, because a change that only lives in React state until the tab closes is the exact
 * failure this page exists to avoid.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';
const SHOTS = process.env['E2E_SHOTS'];

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

/** A fresh idea to work on, opened on its page — creating one lands there by design. */
async function freshIdea(page: Page): Promise<string> {
  const title = `An idea from an e2e run ${String(Date.now())}`;
  await page.goto('/project-ideas');
  await page.getByRole('button', { name: 'New project idea' }).click();
  await page.getByRole('textbox', { name: 'Title' }).fill(title);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/project-ideas\/PI-\d+$/);
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  return title;
}

test.describe('a project idea’s page (S-29)', () => {
  test('opens from its card', async ({ page }) => {
    await signIn(page);
    const title = await freshIdea(page);

    await page.goto('/project-ideas');
    // The whole card is the link — there is nothing else on it to click.
    await page.getByRole('link', { name: new RegExp(title) }).click();
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  });

  test('shows each blank section as the question it asks', async ({ page }) => {
    await signIn(page);
    await freshIdea(page);

    // An empty section is information — it says what is not known yet — so its prompt is shown
    // rather than an empty box.
    await expect(page.getByText('What is broken, and for whom?')).toBeVisible();
    await expect(page.getByText('0 of 6 written').first()).toBeVisible();
  });

  test('saves a section, renders it as Markdown, and counts it', async ({ page }) => {
    await signIn(page);
    await freshIdea(page);

    const problem = page.getByRole('region', { name: 'The problem' });
    await problem.getByRole('button', { name: 'Write' }).click();
    await problem.getByRole('textbox', { name: 'The problem' }).fill('Prints fail **silently**.');
    await problem.getByRole('button', { name: 'Save' }).click();

    await page.reload();
    const saved = page.getByRole('region', { name: 'The problem' });
    await expect(saved.locator('strong', { hasText: 'silently' })).toBeVisible();
    await expect(page.getByText('1 of 6 written').first()).toBeVisible();
  });

  test('keeps a checklist, and ticking an item survives a reload', async ({ page }) => {
    await signIn(page);
    await freshIdea(page);

    const questions = page.getByRole('region', { name: 'Open questions' });
    await questions.getByRole('textbox', { name: 'Add to open questions' }).fill('Local MQTT or cloud?');
    await questions.getByRole('textbox', { name: 'Add to open questions' }).press('Enter');
    await questions.getByRole('checkbox', { name: 'Local MQTT or cloud?' }).click();

    await page.reload();
    await expect(
      page.getByRole('region', { name: 'Open questions' }).getByRole('checkbox', { name: 'Local MQTT or cloud?' }),
    ).toBeChecked();
  });

  test('records how much you want it, and lets you take that back', async ({ page }) => {
    await signIn(page);
    await freshIdea(page);

    const stars = page.getByRole('group', { name: 'Excitement' });
    await stars.getByRole('button', { name: '4 of 5' }).click();
    await page.reload();
    await expect(page.getByRole('group', { name: 'Excitement' }).getByRole('button', { name: '4 of 5' })).toHaveAttribute('aria-pressed', 'true');

    // Pressing the current value clears it — "not decided" is an answer one star cannot give.
    await page.getByRole('group', { name: 'Excitement' }).getByRole('button', { name: '4 of 5' }).click();
    await page.reload();
    await expect(page.getByRole('group', { name: 'Excitement' }).getByRole('button', { name: '4 of 5' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('keeps a dated thoughts log', async ({ page }) => {
    await signIn(page);
    await freshIdea(page);

    await page.getByRole('textbox', { name: 'Add a thought' }).fill('Two products, not one.');
    await page.getByRole('button', { name: 'Add thought' }).click();
    await page.reload();
    await expect(page.getByRole('region', { name: 'Thoughts' }).getByText('Two products, not one.')).toBeVisible();
  });

  test('places a rated idea on the impact × effort matrix', async ({ page }) => {
    await signIn(page);
    const title = await freshIdea(page);

    await page.getByRole('radiogroup', { name: 'Impact, one to five' }).getByRole('radio', { name: '5' }).click();
    await page.getByRole('radiogroup', { name: 'Effort, one to five' }).getByRole('radio', { name: '1' }).click();
    await expect(page.getByText(/a quick win/)).toBeVisible();

    await page.goto('/project-ideas');
    await page.getByRole('radio', { name: 'Impact × effort' }).click();
    // Each dot is a link named for its idea, so the chart is navigable without seeing it.
    await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  });

  test('captures the page for review', async ({ page }) => {
    test.skip(SHOTS === undefined, 'only when E2E_SHOTS names a directory');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await signIn(page);
    const shots = SHOTS ?? '';

    await page.goto('/project-ideas');
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${shots}/1-list.png`, fullPage: true });

    await page.getByRole('radio', { name: 'Impact × effort' }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/2-matrix.png`, fullPage: true });

    await page.getByRole('radio', { name: 'Cards' }).click();
    await page.getByRole('link', { name: /Bambu print notifier/ }).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${shots}/3-detail.png`, fullPage: true });

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${shots}/4-detail-dark.png`, fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });

    await page.setViewportSize({ width: 400, height: 900 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${shots}/5-detail-narrow.png`, fullPage: true });
  });
});
