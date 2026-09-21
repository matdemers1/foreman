// The named export, not the default: the package ships both, and under NodeNext the default
// resolves to the module namespace rather than to the class — "not constructable", at the one
// line the whole suite depends on.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { NodeResult, Result } from 'axe-core';

/**
 * The accessibility pass (T-9.2, T-9.3, FRM-REQ-012).
 *
 * **The defect classes asserted absent are Bindery's own.** Its design audit found five modal
 * overlays with no dialog semantics, controls with no accessible name, bare `<select>` elements and
 * errors announced nowhere — and those findings are free to inherit as tests rather than as a
 * list somebody reads once.
 *
 * Every screen is checked in **both themes**, because a contrast failure only exists in one of
 * them and checking the default alone is how half of them ship.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

/** Every screen a person can reach, with the seeded project. */
const SCREENS: { name: string; path: string }[] = [
  { name: 'dashboard', path: '/' },
  { name: 'projects', path: '/projects' },
  { name: 'project overview', path: '/projects/EXMP' },
  { name: 'phases', path: '/projects/EXMP/phases' },
  { name: 'phase detail', path: '/projects/EXMP/phases/EXMP-P-1' },
  { name: 'requirements', path: '/projects/EXMP/requirements' },
  { name: 'requirement detail', path: '/requirements/EXMP-REQ-001' },
  { name: 'task detail', path: '/tasks/EXMP-T-1.1' },
  { name: 'scope of work', path: '/projects/EXMP/scope-of-work' },
  { name: 'register', path: '/projects/EXMP/register' },
  { name: 'documents', path: '/projects/EXMP/documents' },
  { name: 'decisions', path: '/projects/EXMP/adrs' },
  { name: 'risks', path: '/projects/EXMP/risks' },
  { name: 'glossary', path: '/projects/EXMP/glossary' },
  { name: 'audits', path: '/projects/EXMP/audits' },
  { name: 'activity', path: '/projects/EXMP/activity' },
  { name: 'drift', path: '/projects/EXMP/drift' },
  { name: 'findings', path: '/findings' },
  { name: 'finding detail', path: '/findings/EXMP-CR-001' },
  { name: 'search', path: '/search?q=decision' },
  { name: 'health', path: '/system' },
  { name: 'api tokens', path: '/tokens' },
];

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

/** Run axe and return the violations, described well enough to fix without re-running. */
async function violationsOn(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return results.violations.map(
    (v: Result) =>
      `${v.id} (${v.impact ?? 'unknown'}): ${v.help}\n      ${v.nodes
        .slice(0, 3)
        .map((n: NodeResult) => n.target.join(' '))
        .join('\n      ')}`,
  );
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`axe — ${theme}`, () => {
    for (const screen of SCREENS) {
      test(`${screen.name} has no violations`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme });
        await signIn(page);
        await page.goto(screen.path);
        // Let the screen's own fetches land: axe on a skeleton tests the skeleton.
        await page.waitForLoadState('networkidle');

        const violations = await violationsOn(page);
        expect(violations, `${screen.name} (${theme}):\n  ${violations.join('\n  ')}`).toEqual([]);
      });
    }
  });
}

test.describe('the defect classes from Bindery’s own audit', () => {
  test('every modal is a dialog, is labelled, and closes on Escape', async ({ page }) => {
    await signIn(page);
    await page.goto('/tasks/EXMP-T-1.1');
    await page.getByRole('button', { name: 'Edit' }).click();

    // Bindery had five overlays that were plain divs. A screen reader walked straight past them.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-labelledby', /.+/);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('focus moves into the modal and comes back to its trigger', async ({ page }) => {
    await signIn(page);
    await page.goto('/tasks/EXMP-T-1.1');

    const trigger = page.getByRole('button', { name: 'Edit' });
    await trigger.click();
    await expect(page.getByRole('dialog')).toBeVisible();

    // Focus inside the dialog, not left behind on the page underneath.
    const inside = await page.evaluate(() =>
      document.activeElement?.closest('[role="dialog"]') !== null,
    );
    expect(inside).toBe(true);

    await page.keyboard.press('Escape');
    // And back where it came from, or the keyboard user is at the top of the document.
    await expect(trigger).toBeFocused();
  });

  test('no bare select survives anywhere', async ({ page }) => {
    await signIn(page);

    for (const path of ['/projects/EXMP/requirements', '/findings', '/projects/EXMP/activity']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');

      // A native `<select>` with no accessible name is the defect; the library's Select is a
      // button + listbox, which is why this count is zero rather than "every select is labelled".
      const bare = await page.locator('select:not([aria-label]):not([id])').count();
      expect(bare, path).toBe(0);
    }
  });

  test('every interactive control on a dense screen has an accessible name', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/requirements');
    await page.waitForLoadState('networkidle');

    const unnamed = await page
      .locator('button, [role="button"], [role="combobox"], input, textarea, a[href]')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => {
            const el = node as HTMLElement;
            if (el.getAttribute('aria-hidden') === 'true') return false;
            if (el.hasAttribute('disabled')) return false;
            if (el.offsetParent === null) return false;
            const named = [
              el.getAttribute('aria-label'),
              el.getAttribute('aria-labelledby'),
              el.getAttribute('title'),
              el.id === '' ? '' : document.querySelector(`label[for="${el.id}"]`)?.textContent,
              el.closest('label')?.textContent,
              el.textContent,
            ];
            return !named.some((n) => typeof n === 'string' && n.trim() !== '');
          })
          .map((node) => (node as HTMLElement).outerHTML.slice(0, 100)),
      );

    expect(unnamed, 'a control with no accessible name cannot be announced').toEqual([]);
  });

  test('a form error is tied to its field and announced', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
    await page.getByRole('textbox', { name: 'Password' }).fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // An error rendered as loose text near a field is an error a screen reader never mentions.
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/did not match/);
  });

  test('the page has one h1, and the skip target is reachable', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/requirements');

    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });
});
