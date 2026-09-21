import { expect, test } from '@playwright/test';

/**
 * Project ideas, from the console (FRM-REQ-159 … FRM-REQ-164, FRM-ADR-015).
 *
 * The screen exists so a project-sized thought has somewhere to live that is not a project. What
 * only this surface can show is the seam between the two: a code is never asked for until the
 * moment somebody converts, and converting keeps the idea rather than consuming it.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

const title = () => `Project idea from an e2e run ${String(Date.now())}`;

/** A code this run invents, short enough to be legal and unlikely to collide with a real one. */
const code = () => `E${String(Date.now()).slice(-4)}`;

test.describe('project ideas (S-28)', () => {
  test('sits beside Projects in the sidebar, not inside one', async ({ page }) => {
    await signIn(page);

    // The distinction the whole entity exists for, made visible in the one place that teaches it.
    await page.getByRole('link', { name: 'Project ideas' }).click();
    await expect(page).toHaveURL(/\/project-ideas$/);
    await expect(page.getByRole('heading', { name: 'Project ideas', level: 1 })).toBeVisible();
  });

  test('takes one without asking for a code', async ({ page }) => {
    await signIn(page);
    await page.goto('/project-ideas');
    const text = title();

    await page.getByRole('button', { name: 'New project idea' }).click();
    // A code is immutable and embedded in every ID the project will have (ADR-008). Asking for
    // one here would be asking a permanent question at the moment of least information.
    await expect(page.getByRole('textbox', { name: 'Code' })).toBeHidden();

    await page.getByRole('textbox', { name: 'Title' }).fill(text);
    await page.getByRole('textbox', { name: 'Pitch' }).fill('What it is, and who it is for.');
    await page.getByRole('button', { name: 'Save' }).click();

    const card = page.getByRole('group', { name: new RegExp(`: ${text}$`) });
    await expect(card).toBeVisible();
    await expect(card.getByText('New', { exact: true })).toBeVisible();
  });

  test('will not park one that does not say why', async ({ page }) => {
    await signIn(page);
    await page.goto('/project-ideas');
    const text = title();

    await page.getByRole('button', { name: 'New project idea' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(text);
    await page.getByRole('button', { name: 'Save' }).click();

    const card = page.getByRole('group', { name: new RegExp(`: ${text}$`) });
    await card.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('combobox', { name: 'Status' }).click();
    await page.getByRole('option', { name: 'Parked' }).click();
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('A project idea that is parked has to say why.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Why' }).fill('Not before Someday Vault ships.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByText('Not before Someday Vault ships.')).toBeVisible();
  });

  test('offers no way to mark one built by hand', async ({ page }) => {
    await signIn(page);
    await page.goto('/project-ideas');
    const text = title();

    await page.getByRole('button', { name: 'New project idea' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(text);
    await page.getByRole('button', { name: 'Save' }).click();

    await page
      .getByRole('group', { name: new RegExp(`: ${text}$`) })
      .getByRole('button', { name: 'Edit' })
      .click();
    await page.getByRole('combobox', { name: 'Status' }).click();

    // `Built` means a project exists. Offering it here would let somebody record that an idea
    // became something, with nothing to point at.
    await expect(page.getByRole('option', { name: 'Parked' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Built' })).toBeHidden();
  });

  test('converts into a project, and keeps the idea as the record of where it began', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/project-ideas');
    const text = title();
    const projectCode = code();

    await page.getByRole('button', { name: 'New project idea' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(text);
    await page.getByRole('textbox', { name: 'Pitch' }).fill('The pitch that should carry across.');
    await page.getByRole('button', { name: 'Save' }).click();

    const card = page.getByRole('group', { name: new RegExp(`: ${text}$`) });
    await card.getByRole('button', { name: 'Convert' }).click();
    await page.getByRole('textbox', { name: 'Code' }).fill(projectCode);
    await page.getByRole('button', { name: 'Convert to project' }).click();

    // Straight to the thing that now exists, with the pitch it was given as an idea.
    await expect(page).toHaveURL(new RegExp(`/projects/${projectCode}$`));
    await expect(page.getByText('The pitch that should carry across.')).toBeVisible();

    // And back on the list the idea is still there, saying what it became.
    await page.goto('/project-ideas');
    const after = page.getByRole('group', { name: new RegExp(`: ${text}$`) });
    await expect(after.getByText('Built', { exact: true })).toBeVisible();
    await expect(after.getByRole('link', { name: new RegExp(projectCode) })).toBeVisible();
    // Frozen: a project now says what this says, so there is nothing here left to edit.
    await expect(after.getByRole('button', { name: 'Edit' })).toBeHidden();
    await expect(after.getByRole('button', { name: 'Convert' })).toBeHidden();
  });
});
