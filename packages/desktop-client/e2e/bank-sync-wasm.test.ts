import { expect, test } from '@playwright/test';

import { Navigation } from './page-models/navigation';

test('shows and configures WASM providers without a sync server', async ({
  page,
}) => {
  test.skip(
    process.env.E2E_WASM !== 'true',
    'Requires the standalone WASM build',
  );

  const navigation = new Navigation(page);
  await page.goto('./');
  await page.getByText('Try the demo', { exact: true }).click();
  await expect(page.getByTestId('budget-table')).toBeVisible();
  await navigation.goToBankSyncPage();

  const pluggy = page.getByTestId('bank-sync-provider-pluggyai');
  const akahu = page.getByTestId('bank-sync-provider-akahu');
  await expect(page.getByTestId('bank-sync-provider-simpleFin')).toBeVisible();
  await expect(pluggy).toBeVisible();
  await expect(akahu).toHaveCount(0);
  await expect(page.getByTestId('bank-sync-provider-goCardless')).toHaveCount(
    0,
  );
  await expect(
    page.getByTestId('bank-sync-provider-enableBanking'),
  ).toHaveCount(0);

  await pluggy.getByRole('button', { name: 'Set up', exact: true }).click();
  await expect(
    page.getByText('For this budget only', { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel('Client ID:', { exact: true }).fill('test-client');
  await page.getByLabel('Client Secret:', { exact: true }).fill('test-secret');
  await page
    .getByLabel('Item Ids (comma separated):', { exact: true })
    .fill('test-item');
  await page
    .getByRole('button', { name: 'Save and continue', exact: true })
    .click();
  await expect(pluggy.getByText('Configured', { exact: true })).toBeVisible();
  await page.reload();
  await expect(pluggy.getByText('Configured', { exact: true })).toBeVisible();

  await navigation.goToSettingsPage();
  await page.getByTestId('advanced-settings').click();
  await page.getByTestId('experimental-settings').click();
  const akahuToggle = page.getByRole('checkbox', { name: /Akahu Bank Sync/ });
  await akahuToggle.click();
  await expect(akahuToggle).toBeChecked();
  await navigation.goToBankSyncPage();
  await expect(akahu).toBeVisible();
  await akahu.getByRole('button', { name: 'Set up', exact: true }).click();
  await expect(page.getByText('Set-up Akahu', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  await navigation.goToSettingsPage();
  await page.getByTestId('advanced-settings').click();
  await page.getByTestId('experimental-settings').click();
  await akahuToggle.click();
  await expect(akahuToggle).not.toBeChecked();
  await navigation.goToBankSyncPage();
  await expect(pluggy).toBeVisible();
  await expect(akahu).toHaveCount(0);
});
