import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import type { BudgetPage } from './page-models/budget-page';
import { ConfigurationPage } from './page-models/configuration-page';
import { Navigation } from './page-models/navigation';

async function scrollSidebarOptionsUntilTextVisible(page: Page, text: string) {
  const carousel = page.getByTestId('sidebar-options-carousel');
  await expect
    .poll(async () => {
      await carousel.evaluate(element => {
        element.scrollTop = element.scrollHeight;
      });
      return await page.getByText(text, { exact: true }).count();
    })
    .toBeGreaterThan(0);
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

test.describe('Budget', () => {
  let page: Page;
  let configurationPage: ConfigurationPage;
  let budgetPage: BudgetPage;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    configurationPage = new ConfigurationPage(page);

    await page.goto('/');
    budgetPage = await configurationPage.createTestFile();

    // Move mouse to corner of the screen;
    // sometimes the mouse hovers on a budget element thus rendering an input box
    // and this breaks screenshot tests
    await page.mouse.move(0, 0);
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test('renders the summary information: available funds, overspent, budgeted and for next month', async () => {
    const summary = budgetPage.budgetSummary.first();

    await expect(summary.getByText('Available funds')).toBeVisible({
      timeout: 10000,
    });
    await expect(summary.getByText(/^Overspent in /)).toBeVisible();
    await expect(summary.getByText('Budgeted')).toBeVisible();
    await expect(summary.getByText('For next month')).toBeVisible();
    await expect(page).toMatchThemeScreenshots();
  });

  test('transfer funds to another category', async () => {
    const currentFundsA = await budgetPage.getBalanceForRow(1);
    const currentFundsB = await budgetPage.getBalanceForRow(2);

    await budgetPage.transferAllBalance(1, 2);

    await expect
      .poll(() => budgetPage.getBalanceForRow(2))
      .toEqual(currentFundsA + currentFundsB);
    await expect(page).toMatchThemeScreenshots();
  });

  test('budget table is rendered', async () => {
    await expect(budgetPage.budgetTable).toBeVisible();
    expect(await budgetPage.getTableTotals()).toEqual({
      budgeted: expect.any(Number),
      spent: expect.any(Number),
      balance: expect.any(Number),
    });
  });

  test('clicking on spent amounts opens a transaction page', async () => {
    const accountPage = await budgetPage.clickOnSpentAmountForRow(1);
    expect(page.url()).toContain('/accounts');
    expect(await accountPage.accountName.textContent()).toMatch('All Accounts');
    await page.getByRole('button', { name: 'Back' }).click();
  });

  test('modern budget page keeps core desktop budget interactions behind the feature flag', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await expect(budgetPage.budgetSummary.first()).toContainText(
      'Available funds',
    );
    await expect(page.getByText('Options')).toBeVisible();
    await expect(budgetPage.selectedMonthButton).toHaveAttribute(
      'data-month',
      /\d{4}-\d{2}/,
    );
    expect(await budgetPage.getTableTotals()).toEqual({
      budgeted: expect.any(Number),
      spent: expect.any(Number),
      balance: expect.any(Number),
    });

    const currentFundsA = await budgetPage.getBalanceForRow(1);
    const currentFundsB = await budgetPage.getBalanceForRow(2);
    await budgetPage.transferAllBalance(1, 2);
    await expect
      .poll(() => budgetPage.getBalanceForRow(2))
      .toEqual(currentFundsA + currentFundsB);

    await budgetPage.setBudgetedAmount('Food', '123', 0);
    await expect(
      budgetPage.budgetTable
        .getByTestId('row')
        .filter({ hasText: 'Food' })
        .first()
        .getByTestId('budget')
        .first(),
    ).toContainText('123');

    const usualExpensesRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Usual Expenses' })
      .first();
    await usualExpensesRow
      .getByRole('button', { name: 'Group actions' })
      .click();
    await page.getByText('Add category', { exact: true }).click();
    const newCategoryInput = page.getByPlaceholder('New category name');
    await newCategoryInput.fill('Snacks');
    await newCategoryInput.press('Enter');
    const snacksRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Snacks' });
    await expect(snacksRow.first()).toBeVisible();

    await snacksRow
      .first()
      .getByRole('button', { name: 'Category actions' })
      .click();
    await page.getByText('Hide', { exact: true }).click();
    await expect(snacksRow).toHaveCount(0);

    await budgetPage.budgetTable
      .getByRole('button', { name: 'Category table actions' })
      .click({ force: true });
    await page.getByText('Show hidden categories', { exact: true }).click();
    await expect(snacksRow.first()).toBeVisible();

    await budgetPage.goToNextMonth();
    await expect(budgetPage.selectedMonthButton).toHaveAttribute(
      'data-month',
      '2017-02',
    );
    const febSummaryLane = budgetPage.budgetSummary
      .getByText('Feb 2017')
      .locator('xpath=ancestor::*[.//button[@aria-label="Month actions"]][1]');
    await febSummaryLane.getByRole('button', { name: 'Month actions' }).click();
    await page.getByText('Set budgets to zero', { exact: true }).click();
    await expect(
      budgetPage.budgetTableTotals.getByTestId('total-budgeted'),
    ).toContainText('0.00');

    const accountPage = await budgetPage.clickOnSpentAmountForRow(1);
    expect(page.url()).toContain('/accounts');
    expect(await accountPage.accountName.textContent()).toMatch('All Accounts');
  });

  test('keeps the legacy desktop budget page when modern budget is disabled', async () => {
    const navigation = new Navigation(page);

    budgetPage = await navigation.goToBudgetPage();

    await expect(page.getByText('Options')).toHaveCount(0);
    await expect(page.getByTestId('month-summary-lane')).toHaveCount(0);
    await expect(budgetPage.budgetTable.getByText('Category')).toBeVisible();
    await expect(
      budgetPage.budgetTable.getByText('Balance', { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Add account' }),
    ).toBeVisible();
  });

  test('modern sidebar options canvas seeds account widgets and edit controls', async () => {
    test.setTimeout(90_000);

    const navigation = new Navigation(page);
    await page.evaluate(async () => {
      const $send = (
        window as unknown as {
          $send: (type: string, args?: unknown) => Promise<unknown>;
        }
      ).$send;

      await $send('report/create', {
        id: '',
        name: 'Sidebar Budget Review',
        startDate: '2017-01',
        endDate: '2017-03',
        isDateStatic: true,
        dateRange: 'custom',
        mode: 'total',
        groupBy: 'Category',
        interval: 'Monthly',
        balanceType: 'Expense',
        showEmpty: false,
        showOffBudget: false,
        showHiddenCategories: false,
        includeCurrentInterval: false,
        showUncategorized: false,
        trimIntervals: false,
        showTrendLines: false,
        graphType: 'BarGraph',
        conditions: [],
        conditionsOp: 'and',
      });
    });

    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await expect(page.getByText('Options')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'All accounts' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'On budget' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Off budget' })).toBeVisible();

    await page.getByText('Options').hover();
    await page.getByRole('button', { name: 'Options menu' }).click();
    await page.getByText('Edit Options', { exact: true }).click();

    await expect(page.getByRole('button', { name: 'Add page' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Remove current page' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Add new widget' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Finish editing' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Add new widget' }).click();
    await expect(page.getByText('Add account', { exact: true })).toBeVisible();
    await page.getByText('Sidebar Budget Review', { exact: true }).click();
    await scrollSidebarOptionsUntilTextVisible(page, 'Sidebar Budget Review');

    await page.getByRole('button', { name: 'Add new widget' }).click();
    await page.getByText('New custom report', { exact: true }).click();
    await expect(page).toHaveURL(/\/reports\/custom/);
  });

  test('modern sidebar options account widgets keep account navigation', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await page.getByRole('link', { name: 'On budget' }).click();
    await expect(page).toHaveURL(/\/accounts\/onbudget/);
    await expect(page.getByTestId('account-name')).toHaveText(
      'On Budget Accounts',
    );

    budgetPage = await navigation.goToBudgetPage();

    await page.getByRole('link', { name: 'All accounts' }).click();
    await expect(page).toHaveURL(/\/accounts$/);
    await expect(page.getByTestId('account-name')).toHaveText('All Accounts');
  });

  test('modern sidebar options account widgets keep account reordering', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const carousel = page.getByTestId('sidebar-options-carousel');
    const bank = carousel.getByRole('link', { name: /Bank of America/ });
    const ally = carousel.getByRole('link', { name: /Ally Savings/ });

    await expect(bank).toBeVisible();
    await expect(ally).toBeVisible();
    await expect
      .poll(() =>
        carousel
          .getByRole('link')
          .evaluateAll(links =>
            links.map(link => link.textContent?.trim()).filter(Boolean),
          ),
      )
      .toEqual(
        expect.arrayContaining([
          expect.stringContaining('Bank of America'),
          expect.stringContaining('Ally Savings'),
        ]),
      );

    const allyDragHandle = ally.locator(
      'xpath=ancestor::*[@draggable="true"][1]',
    );
    await expect(allyDragHandle).toBeVisible();

    const allyHandle = await allyDragHandle.elementHandle();
    const bankHandle = await bank.elementHandle();
    if (!allyHandle || !bankHandle) {
      throw new Error('Unable to locate account rows for sidebar reorder.');
    }

    await page.evaluate(
      ({ source, target }) => {
        const dataTransfer = new DataTransfer();
        const targetRect = target.getBoundingClientRect();
        source.dispatchEvent(
          new DragEvent('dragstart', {
            bubbles: true,
            dataTransfer,
          }),
        );
        target.dispatchEvent(
          new DragEvent('dragover', {
            bubbles: true,
            clientY: targetRect.top + 2,
            dataTransfer,
          }),
        );
        target.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            clientY: targetRect.top + 2,
            dataTransfer,
          }),
        );
        source.dispatchEvent(
          new DragEvent('dragend', {
            bubbles: true,
            dataTransfer,
          }),
        );
      },
      { source: allyHandle, target: bankHandle },
    );

    await expect
      .poll(async () => {
        const names = await carousel
          .getByRole('link')
          .evaluateAll(links =>
            links
              .map(link => link.textContent?.trim() ?? '')
              .filter(
                text =>
                  text.includes('Bank of America') ||
                  text.includes('Ally Savings'),
              ),
          );

        return (
          names.findIndex(name => name.includes('Ally Savings')) <
          names.findIndex(name => name.includes('Bank of America'))
        );
      })
      .toBe(true);
  });

  test('modern sidebar options add account widget opens the add account flow', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await page.getByTestId('sidebar-options-carousel').evaluate(element => {
      element.scrollTop = element.scrollHeight;
    });
    await page.getByRole('button', { name: 'Add account' }).click();

    await expect(
      page.getByRole('button', { name: 'Create a local account' }),
    ).toBeVisible();
  });

  test('modern sidebar options canvas manages pages with carousel dots', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await page.getByText('Options').hover();
    await page.getByRole('button', { name: 'Options menu' }).click();
    await page.getByText('Edit Options', { exact: true }).click();

    await expect(
      page.getByRole('button', { name: 'Show options page 1' }),
    ).toHaveCount(0);

    await page.getByRole('button', { name: 'Add page' }).click();
    await expect(
      page.getByRole('button', { name: 'Show options page 1' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Show options page 2' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Show options page 1' }).click();
    await page.getByRole('button', { name: 'Remove current page' }).click();

    await expect(
      page.getByRole('button', { name: 'Show options page 1' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Remove current page' }),
    ).toBeDisabled();
  });

  test('modern sidebar options carousel changes pages by dragging', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await page.getByText('Options').hover();
    await page.getByRole('button', { name: 'Options menu' }).click();
    await page.getByText('Edit Options', { exact: true }).click();
    await page.getByRole('button', { name: 'Add page' }).click();
    await page.getByRole('button', { name: 'Add page' }).click();
    await page.getByRole('button', { name: 'Finish editing' }).click();
    await page.getByRole('button', { name: 'Show options page 3' }).click();

    await expect(
      page.getByRole('button', { name: 'Show options page 3' }),
    ).toHaveAttribute('aria-current', 'page');

    const carousel = page.getByTestId('sidebar-options-carousel');

    let box = await carousel.boundingBox();
    if (!box) {
      throw new Error('Unable to measure sidebar options carousel.');
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, {
      steps: 6,
    });
    await page.mouse.up();

    await expect(
      page.getByRole('button', { name: 'Show options page 2' }),
    ).toHaveAttribute('aria-current', 'page');

    box = await carousel.boundingBox();
    if (!box) {
      throw new Error('Unable to measure sidebar options carousel.');
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 90, box.y + box.height / 2, {
      steps: 6,
    });
    await page.mouse.up();

    await expect(
      page.getByRole('button', { name: 'Show options page 3' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  test('modern sidebar options canvas resets the current page to default widgets', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await page.getByText('Options').hover();
    await page.getByRole('button', { name: 'Options menu' }).click();
    await page.getByText('Edit Options', { exact: true }).click();

    await page.getByRole('button', { name: 'Add new widget' }).click();
    await page.getByText('Text widget', { exact: true }).click();
    await scrollSidebarOptionsUntilTextVisible(page, 'Text Widget');

    await page.getByRole('button', { name: 'Options menu' }).click();
    await page.getByText('Reset to default', { exact: true }).click();

    await expect(page.getByText('Text Widget', { exact: true })).toHaveCount(0);
    await page.getByTestId('sidebar-options-carousel').evaluate(element => {
      element.scrollTop = 0;
    });
    await expect(
      page.getByRole('link', { name: 'All accounts' }),
    ).toBeVisible();
  });

  test('modern sidebar report widgets copy to reports dashboards', async () => {
    test.setTimeout(90_000);

    const targetDashboardId = await page.evaluate(async () => {
      const $send = (
        window as unknown as {
          $send: (type: string, args?: unknown) => Promise<string>;
        }
      ).$send;

      return await $send('dashboard-create', {
        name: 'Sidebar Copy Target',
        kind: 'reports',
      });
    });
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await page.getByText('Options').hover();
    await page.getByRole('button', { name: 'Options menu' }).click();
    await page.getByText('Edit Options', { exact: true }).click();
    await page.getByRole('button', { name: 'Add new widget' }).click();
    await page.getByText('Text widget', { exact: true }).click();

    await scrollSidebarOptionsUntilTextVisible(page, 'Text Widget');
    const textWidget = page
      .getByText('Text Widget', { exact: true })
      .locator('xpath=ancestor::*[contains(@class, "react-grid-item")][1]');
    await expect(textWidget).toBeVisible();

    await textWidget.hover();
    await textWidget.getByRole('button', { name: 'Menu' }).click();
    await page.getByText('Copy to dashboard', { exact: true }).click();
    await page.getByRole('button', { name: 'Sidebar Copy Target' }).click();

    await page.goto(`/reports/${targetDashboardId}`);
    await expect(
      page.getByTestId('reports-page').getByText('Text Widget', {
        exact: true,
      }),
    ).toBeVisible();
  });

  test('modern sidebar options canvas scrolls overflowing widgets', async () => {
    await page.setViewportSize({ width: 1024, height: 520 });

    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await page.getByText('Options').hover();
    await page.getByRole('button', { name: 'Options menu' }).click();
    await page.getByText('Edit Options', { exact: true }).click();

    for (let index = 0; index < 5; index++) {
      await page.getByRole('button', { name: 'Add new widget' }).click();
      await page.getByText('Text widget', { exact: true }).click();
    }

    const carousel = page.getByTestId('sidebar-options-carousel');
    await expect
      .poll(() =>
        carousel.evaluate(
          element => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);
    await expect(carousel).toHaveCSS('overflow-y', 'auto');

    await carousel.evaluate(element => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => carousel.evaluate(element => element.scrollTop))
      .toBeGreaterThan(0);
  });

  test('modern sidebar options canvas resizes widgets in edit mode', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await page.getByText('Options').hover();
    await page.getByRole('button', { name: 'Options menu' }).click();
    await page.getByText('Edit Options', { exact: true }).click();

    const widget = page
      .getByRole('link', { name: 'All accounts' })
      .locator('xpath=ancestor::*[contains(@class, "react-grid-item")][1]');
    await expect(widget).toBeVisible();

    const before = await widget.boundingBox();
    const handle = widget.locator('.react-resizable-handle').first();
    const handleBox = await handle.boundingBox();
    if (!before || !handleBox) {
      throw new Error('Unable to measure sidebar widget resize handle.');
    }

    await page.mouse.move(
      handleBox.x + handleBox.width / 2,
      handleBox.y + handleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      handleBox.x + handleBox.width / 2,
      handleBox.y + handleBox.height / 2 + 90,
      { steps: 6 },
    );
    await page.mouse.up();

    await expect
      .poll(async () => (await widget.boundingBox())?.height ?? 0)
      .toBeGreaterThan(before.height);
  });

  test('modern sidebar options canvas reorders widgets in edit mode', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await page.getByText('Options').hover();
    await page.getByRole('button', { name: 'Options menu' }).click();
    await page.getByText('Edit Options', { exact: true }).click();

    const widget = page
      .getByRole('link', { name: 'On budget' })
      .locator('xpath=ancestor::*[contains(@class, "react-grid-item")][1]');
    await expect(widget).toBeVisible();

    const before = await widget.boundingBox();
    if (!before) {
      throw new Error('Unable to measure sidebar widget before dragging.');
    }

    await page.mouse.move(before.x + before.width / 2, before.y + 12);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2, before.y - 60, {
      steps: 8,
    });
    await page.mouse.up();

    await expect
      .poll(async () => (await widget.boundingBox())?.y ?? before.y)
      .toBeLessThan(before.y);
  });

  test('modern budget page reorders categories by dragging the row header', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const foodRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Food' })
      .first();
    const restaurantsRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Restaurants' })
      .first();
    const dragHandle = foodRow
      .getByTestId('category-name')
      .locator('xpath=ancestor::*[@draggable="true"][1]');
    const sourceBox = await dragHandle.boundingBox();
    const targetBox = await restaurantsRow.boundingBox();

    if (!sourceBox || !targetBox) {
      throw new Error('Unable to locate category drag source or target.');
    }

    await page.mouse.move(
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      targetBox.x + Math.min(targetBox.width / 2, 120),
      targetBox.y + targetBox.height - 2,
      { steps: 8 },
    );
    await page.mouse.up();

    await expect
      .poll(async () => {
        const names = await budgetPage.budgetTable
          .getByTestId('row')
          .evaluateAll(rows =>
            rows
              .map(row =>
                row
                  .querySelector('[data-testid="category-name"]')
                  ?.textContent?.trim(),
              )
              .filter(Boolean),
          );

        return (
          names.indexOf('Restaurants') !== -1 &&
          names.indexOf('Food') > names.indexOf('Restaurants')
        );
      })
      .toBe(true);
  });

  test('modern budget page moves categories between groups by dragging onto a group header', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await budgetPage.budgetTable
      .getByRole('button', { name: 'Category table actions' })
      .click({ force: true });
    await page.getByText('Hide summary', { exact: true }).click();

    const foodRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Food' })
      .first();
    const billsRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Bills') })
      .first();

    await expect(foodRow).toBeVisible();
    await expect(billsRow).toBeVisible();

    const dragHandle = foodRow
      .getByTestId('category-name')
      .locator('xpath=ancestor::*[@draggable="true"][1]');
    const sourceBox = await dragHandle.boundingBox();
    const targetBox = await billsRow.boundingBox();

    if (!sourceBox || !targetBox) {
      throw new Error('Unable to locate category drag source or target.');
    }

    await dragHandle.dragTo(billsRow, {
      sourcePosition: {
        x: sourceBox.width / 2,
        y: sourceBox.height / 2,
      },
      targetPosition: {
        x: Math.min(targetBox.width / 2, 120),
        y: targetBox.height - 2,
      },
    });

    await expect
      .poll(async () => {
        const names = await budgetPage.budgetTable
          .getByTestId('row')
          .evaluateAll(rows =>
            rows
              .map(row =>
                row
                  .querySelector('[data-testid="category-name"]')
                  ?.textContent?.trim(),
              )
              .filter(Boolean),
          );

        return (
          names.indexOf('Bills') !== -1 &&
          names.indexOf('Food') !== -1 &&
          names.indexOf('Cell') !== -1 &&
          names.indexOf('Bills') < names.indexOf('Food') &&
          names.indexOf('Food') < names.indexOf('Cell')
        );
      })
      .toBe(true);
  });

  test('modern budget page reorders groups by dragging the row header', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const usualExpensesRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({
        has: page.getByTestId('category-name').getByText('Usual Expenses'),
      })
      .first();
    const billsRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Bills') })
      .first();

    await usualExpensesRow.getByRole('button', { name: 'Collapse' }).click();
    await billsRow.scrollIntoViewIfNeeded();

    const dragHandle = billsRow.getByTestId('group-header');
    const sourceBox = await dragHandle.boundingBox();
    const targetBox = await usualExpensesRow.boundingBox();

    if (!sourceBox || !targetBox) {
      throw new Error('Unable to locate group drag source or target.');
    }

    await dragHandle.dragTo(usualExpensesRow, {
      sourcePosition: {
        x: sourceBox.width / 2,
        y: sourceBox.height / 2,
      },
      targetPosition: {
        x: Math.min(targetBox.width / 2, 120),
        y: 2,
      },
    });

    await expect
      .poll(async () => {
        const names = await budgetPage.budgetTable
          .getByTestId('group-header')
          .evaluateAll(headers =>
            headers
              .map(header =>
                header
                  .querySelector('[data-testid="category-name"]')
                  ?.textContent?.trim(),
              )
              .filter(Boolean),
          );

        return (
          names.indexOf('Bills') !== -1 &&
          names.indexOf('Usual Expenses') !== -1 &&
          names.indexOf('Bills') < names.indexOf('Usual Expenses')
        );
      })
      .toBe(true);
  });

  test('modern budget page moves groups from row header menus', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const usualExpensesRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({
        has: page.getByTestId('category-name').getByText('Usual Expenses'),
      })
      .first();

    await usualExpensesRow
      .getByRole('button', { name: 'Group actions' })
      .click({ force: true });
    await page.getByText('Move down', { exact: true }).click();

    await expect
      .poll(async () => {
        const names = await budgetPage.budgetTable
          .getByTestId('group-header')
          .evaluateAll(headers =>
            headers
              .map(header =>
                header
                  .querySelector('[data-testid="category-name"]')
                  ?.textContent?.trim(),
              )
              .filter(Boolean),
          );

        return (
          names.indexOf('Bills') !== -1 &&
          names.indexOf('Usual Expenses') !== -1 &&
          names.indexOf('Usual Expenses') > names.indexOf('Bills')
        );
      })
      .toBe(true);

    await usualExpensesRow
      .getByRole('button', { name: 'Group actions' })
      .click({ force: true });
    await page.getByText('Move up', { exact: true }).click();

    await expect
      .poll(async () => {
        const names = await budgetPage.budgetTable
          .getByTestId('group-header')
          .evaluateAll(headers =>
            headers
              .map(header =>
                header
                  .querySelector('[data-testid="category-name"]')
                  ?.textContent?.trim(),
              )
              .filter(Boolean),
          );

        return (
          names.indexOf('Bills') !== -1 &&
          names.indexOf('Usual Expenses') !== -1 &&
          names.indexOf('Usual Expenses') < names.indexOf('Bills')
        );
      })
      .toBe(true);
  });

  test('modern budget page edits category groups from row header menus', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await budgetPage.budgetTable
      .getByRole('button', { name: 'Category table actions' })
      .click({ force: true });
    await page.getByText('Add group', { exact: true }).click();
    const groupInput = page.getByPlaceholder('New group name');
    await groupInput.fill('Weekend');
    await groupInput.press('Enter');

    const groupRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Weekend' })
      .first();
    await expect(groupRow).toBeVisible();

    await groupRow.scrollIntoViewIfNeeded();
    await groupRow.hover();
    await groupRow
      .getByRole('button', { name: 'Group actions' })
      .click({ force: true });
    await page.getByText('Rename', { exact: true }).click();
    const renameInput = page.getByPlaceholder('Group name');
    await renameInput.fill('Weekends');
    await renameInput.press('Enter');
    await expect(
      budgetPage.budgetTable
        .getByTestId('row')
        .filter({ hasText: 'Weekends' })
        .first(),
    ).toBeVisible();

    await budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Weekends' })
      .first()
      .getByRole('button', { name: 'Group actions' })
      .click({ force: true });
    await page.getByText('Add category', { exact: true }).click();
    const categoryInput = page.getByPlaceholder('New category name');
    await categoryInput.fill('Leisure');
    await categoryInput.press('Enter');
    const hiddenGroupCategoryRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Leisure' });
    await expect(hiddenGroupCategoryRow.first()).toBeVisible();

    await budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Weekends' })
      .first()
      .getByRole('button', { name: 'Group actions' })
      .click({ force: true });
    await page.getByText('Hide', { exact: true }).click();
    await expect(
      budgetPage.budgetTable.getByTestId('row').filter({ hasText: 'Weekends' }),
    ).toHaveCount(0);

    await budgetPage.budgetTable
      .getByRole('button', { name: 'Category table actions' })
      .click({ force: true });
    await page.getByText('Show hidden categories', { exact: true }).click();
    await expect(
      budgetPage.budgetTable
        .getByTestId('row')
        .filter({ hasText: 'Weekends' })
        .first(),
    ).toBeVisible();
    await expect(hiddenGroupCategoryRow.first()).toHaveCSS('opacity', '0.5');
  });

  test('modern budget page sorts categories from group row menus', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const usualExpensesRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({
        has: page.getByTestId('category-name').getByText('Usual Expenses'),
      })
      .first();
    await usualExpensesRow
      .getByRole('button', { name: 'Group actions' })
      .click({ force: true });
    await page.getByText('Sort A to Z', { exact: true }).click();

    await expect
      .poll(async () =>
        budgetPage.budgetTable.getByTestId('row').evaluateAll(rows =>
          rows
            .map(row =>
              row
                .querySelector('[data-testid="category-name"]')
                ?.textContent?.trim(),
            )
            .filter(Boolean)
            .slice(1, 9),
        ),
      )
      .toEqual([
        'Clothing',
        'Entertainment',
        'Food',
        'General',
        'Gift',
        'Medical',
        'Restaurants',
        'Savings',
      ]);
  });

  test('modern budget page opens category row context menus', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const foodRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Food' })
      .first();

    await foodRow.getByTestId('category-header').click({ button: 'right' });
    await page.getByText('Rename', { exact: true }).click();
    const renameInput = page.getByPlaceholder('Category name');
    await renameInput.fill('Groceries');
    await renameInput.press('Enter');

    await expect(
      budgetPage.budgetTable
        .getByTestId('row')
        .filter({ hasText: 'Groceries' })
        .first(),
    ).toBeVisible();
  });

  test('modern budget page hides hidden categories again from table actions', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const foodRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Food') });

    await foodRow
      .first()
      .getByRole('button', { name: 'Category actions' })
      .click();
    await page.getByText('Hide', { exact: true }).click();
    await expect(foodRow).toHaveCount(0);

    await budgetPage.budgetTable
      .getByRole('button', { name: 'Category table actions' })
      .click({ force: true });
    await page.getByText('Show hidden categories', { exact: true }).click();
    await expect(foodRow.first()).toBeVisible();

    await budgetPage.budgetTable
      .getByRole('button', { name: 'Category table actions' })
      .click({ force: true });
    await page.getByText('Hide hidden categories', { exact: true }).click();
    await expect(foodRow).toHaveCount(0);
  });

  test('modern budget page moves categories from row header menus', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const foodRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Food') })
      .first();

    await foodRow
      .getByRole('button', { name: 'Category actions' })
      .click({ force: true });
    await page.getByText('Move down', { exact: true }).click();

    await expect
      .poll(async () => {
        const names = await budgetPage.budgetTable
          .getByTestId('row')
          .evaluateAll(rows =>
            rows
              .map(row =>
                row
                  .querySelector('[data-testid="category-name"]')
                  ?.textContent?.trim(),
              )
              .filter(Boolean),
          );

        return (
          names.indexOf('Restaurants') !== -1 &&
          names.indexOf('Food') > names.indexOf('Restaurants')
        );
      })
      .toBe(true);

    await foodRow
      .getByRole('button', { name: 'Category actions' })
      .click({ force: true });
    await page.getByText('Move up', { exact: true }).click();

    await expect
      .poll(async () => {
        const names = await budgetPage.budgetTable
          .getByTestId('row')
          .evaluateAll(rows =>
            rows
              .map(row =>
                row
                  .querySelector('[data-testid="category-name"]')
                  ?.textContent?.trim(),
              )
              .filter(Boolean),
          );

        return (
          names.indexOf('Restaurants') !== -1 &&
          names.indexOf('Food') < names.indexOf('Restaurants')
        );
      })
      .toBe(true);
  });

  test('modern budget page deletes categories through the transfer confirmation', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const foodRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Food' });

    await foodRow
      .first()
      .getByRole('button', { name: 'Category actions' })
      .click({ force: true });
    await page.getByText('Delete', { exact: true }).click();
    await page.getByPlaceholder('Select category...').fill('Restaurants');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Delete' }).click();

    await expect(foodRow).toHaveCount(0);
    await expect(
      budgetPage.budgetTable
        .getByTestId('row')
        .filter({ hasText: 'Restaurants' })
        .first(),
    ).toBeVisible();
  });

  test('modern budget page deletes groups through the transfer confirmation', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const billsGroup = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Bills') });

    await billsGroup
      .first()
      .getByRole('button', { name: 'Group actions' })
      .click({ force: true });
    await page.getByText('Delete', { exact: true }).click();
    await page.getByPlaceholder('Select category...').fill('Food');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Delete' }).click();

    await expect(billsGroup).toHaveCount(0);
    await expect(
      budgetPage.budgetTable
        .getByTestId('row')
        .filter({ has: page.getByTestId('category-name').getByText('Food') })
        .first(),
    ).toBeVisible();
  });

  test('modern budget page sorts categories from the group row menu', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const foodRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Food' })
      .first();
    const savingsRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Savings' })
      .first();

    await expect(foodRow).toBeVisible();
    await expect(savingsRow).toBeVisible();

    const initialFoodBox = await foodRow.boundingBox();
    const initialSavingsBox = await savingsRow.boundingBox();
    expect(initialFoodBox?.y).toBeLessThan(initialSavingsBox?.y ?? 0);

    const usualExpensesRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({
        has: page.getByTestId('category-name').getByText('Usual Expenses'),
      })
      .first();
    await usualExpensesRow
      .getByRole('button', { name: 'Group actions' })
      .click({ force: true });
    await page.getByText('Sort Z to A', { exact: true }).click();

    await expect
      .poll(async () => {
        const sortedFoodBox = await foodRow.boundingBox();
        const sortedSavingsBox = await savingsRow.boundingBox();
        return (sortedSavingsBox?.y ?? 0) < (sortedFoodBox?.y ?? 0);
      })
      .toBe(true);
  });

  test('modern budget page opens category automations from the row header', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');
    await settingsPage.enableExperimentalFeature('Goal templates');
    const uiToggle = page.getByRole('checkbox', {
      name: 'Budget automations UI',
    });
    await uiToggle.waitFor({ state: 'visible' });
    if (!(await uiToggle.isChecked())) {
      await uiToggle.click();
    }

    budgetPage = await navigation.goToBudgetPage();

    const foodRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Food' })
      .first();
    await foodRow.hover();
    await foodRow
      .getByRole('button', { name: 'Change category automations' })
      .click({ force: true });

    await expect(
      page.getByText('Budget automation', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Add an automation' }),
    ).toBeVisible();
  });

  test('modern budget page runs goal template month actions', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');
    await settingsPage.enableExperimentalFeature('Goal templates');

    budgetPage = await navigation.goToBudgetPage();

    const foodCategoryId = await page.evaluate(async () => {
      const $send = (
        window as unknown as {
          $send: (
            type: string,
            args?: unknown,
          ) => Promise<{
            list?: Array<{ id: string; name: string }>;
          }>;
        }
      ).$send;
      const categories = await $send('get-categories');
      const foodCategory = categories.list?.find(
        category => category.name === 'Food',
      );
      if (!foodCategory) {
        throw new Error('Food category not found.');
      }

      await $send('budget/set-category-automations', {
        categoriesWithTemplates: [
          {
            id: foodCategory.id,
            templates: [
              {
                directive: 'template',
                type: 'periodic',
                amount: 100,
                period: { period: 'month', amount: 1 },
                starting: '2017-01-01',
                priority: 1,
              },
            ],
          },
        ],
        source: 'ui',
      });

      return foodCategory.id;
    });
    expect(foodCategoryId).toBeTruthy();

    await budgetPage.setBudgetedAmount('Food', '0', 0);

    const januarySummaryLane = budgetPage.budgetSummary
      .getByText('Jan 2017')
      .locator('xpath=ancestor::*[.//button[@aria-label="Month actions"]][1]');

    await januarySummaryLane
      .getByRole('button', { name: 'Month actions' })
      .click();

    await expect(
      page.getByText('Check templates', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Apply budget template', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Overwrite with budget template', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('End of month cleanup', { exact: true }),
    ).toBeVisible();

    await page
      .getByText('Overwrite with budget template', { exact: true })
      .click();

    await expect(
      budgetPage.budgetTable
        .getByTestId('row')
        .filter({ hasText: 'Food' })
        .first()
        .getByTestId('budget')
        .first(),
    ).toContainText('100');
  });

  test('modern budget page overwrites templates with the keyboard shortcut', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');
    await settingsPage.enableExperimentalFeature('Goal templates');

    await page.evaluate(async () => {
      const $send = (
        window as unknown as {
          $send: (
            type: string,
            args?: unknown,
          ) => Promise<{
            list?: Array<{ id: string; name: string }>;
          }>;
        }
      ).$send;
      const categories = await $send('get-categories');
      const foodCategory = categories.list?.find(
        category => category.name === 'Food',
      );
      if (!foodCategory) {
        throw new Error('Food category not found.');
      }

      await $send('budget/set-category-automations', {
        categoriesWithTemplates: [
          {
            id: foodCategory.id,
            templates: [
              {
                directive: 'template',
                type: 'periodic',
                amount: 100,
                period: { period: 'month', amount: 1 },
                starting: '2017-01-01',
                priority: 1,
              },
            ],
          },
        ],
        source: 'ui',
      });
    });

    budgetPage = await navigation.goToBudgetPage();
    await budgetPage.setBudgetedAmount('Food', '0', 0);
    await page.keyboard.press('Escape');
    await page.getByText('Budget').first().click();
    await page.keyboard.press('Shift+T');

    await expect(
      budgetPage.budgetTable
        .getByTestId('row')
        .filter({ hasText: 'Food' })
        .first()
        .getByTestId('budget')
        .first(),
    ).toContainText('100');
  });

  test('modern budget page runs month average budget actions', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const januarySummaryLane = budgetPage.budgetSummary
      .getByText('Jan 2017')
      .locator('xpath=ancestor::*[.//button[@aria-label="Month actions"]][1]');
    const usualExpensesRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Usual Expenses' })
      .first();
    const previousBudgeted = await usualExpensesRow.textContent();

    await januarySummaryLane
      .getByRole('button', { name: 'Month actions' })
      .click();
    await page
      .getByText('Set budgets to 3 month average', { exact: true })
      .click();

    await expect(usualExpensesRow).not.toContainText(previousBudgeted ?? '');
    await expect(usualExpensesRow).toContainText('804.00');
  });

  test('modern tracking budget hides envelope-only month cleanup action', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.useBudgetType('Tracking');
    await settingsPage.enableExperimentalFeature('Modern budget page');
    await settingsPage.enableExperimentalFeature('Goal templates');

    budgetPage = await navigation.goToBudgetPage();

    const januarySummaryLane = budgetPage.budgetSummary
      .getByText('Jan 2017')
      .locator('xpath=ancestor::*[.//button[@aria-label="Month actions"]][1]');

    await januarySummaryLane
      .getByRole('button', { name: 'Month actions' })
      .click();

    await expect(
      page.getByText('Check templates', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Apply budget template', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Overwrite with budget template', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('End of month cleanup', { exact: true }),
    ).toHaveCount(0);
  });

  test('modern budget page runs category budget cell actions', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await budgetPage.setBudgetedAmount('Food', '123', 0);
    const foodRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Food' })
      .first();
    const foodBudget = foodRow.getByTestId('budget').first();
    await expect(foodBudget).toContainText('123');

    await foodBudget.click({ button: 'right' });
    await page.getByText("Copy last month's budget", { exact: true }).click();

    await expect(foodBudget).not.toContainText('123');

    await budgetPage.setBudgetedAmount('Clothing', '123', 0);
    const clothingRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Clothing' })
      .first();
    const clothingBudget = clothingRow.getByTestId('budget').first();
    await expect(clothingBudget).toContainText('123');

    await clothingBudget.click({ button: 'right' });
    await page.getByText('Set to 3 month average', { exact: true }).click();

    await expect(clothingBudget).toContainText('804.00');
  });

  test('modern budget page moves budget editing to the next category with Enter and Tab', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const foodRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Food' })
      .first();
    const restaurantsRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Restaurants' })
      .first();
    const entertainmentRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Entertainment' })
      .first();
    const foodBudget = foodRow.getByTestId('budget').first();
    const restaurantsBudget = restaurantsRow.getByTestId('budget').first();
    const entertainmentBudget = entertainmentRow.getByTestId('budget').first();

    await foodBudget.click();
    const foodInput = foodBudget.locator('input');
    await foodInput.waitFor({ state: 'visible' });
    await foodInput.fill('111');
    await foodInput.press('Enter');
    await expect(foodBudget).toContainText('111');

    const restaurantsInput = restaurantsBudget.locator('input');
    await restaurantsInput.waitFor({ state: 'visible' });
    await restaurantsInput.fill('222');
    await restaurantsInput.press('Tab');

    await expect(restaurantsBudget).toContainText('222');
    const entertainmentInput = entertainmentBudget.locator('input');
    await entertainmentInput.waitFor({ state: 'visible' });
  });

  test('modern budget page edits category month notes', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const foodRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Food' })
      .first();
    await foodRow.hover();
    const monthNoteButton = foodRow
      .getByRole('button', { name: 'View notes' })
      .nth(1);

    await monthNoteButton.click({ force: true });
    const notesInput = page.getByPlaceholder('Notes (markdown supported)');
    await notesInput.fill('January grocery plan');
    await page.mouse.click(20, 20);

    await page.mouse.move(20, 20);
    await expect(monthNoteButton).toHaveCSS('opacity', '1');

    await monthNoteButton.click({ force: true });
    await expect(notesInput).toHaveValue('January grocery plan');
  });

  test('modern budget page edits category row notes', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const foodRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Food' })
      .first();
    await foodRow.hover();
    const categoryNoteButton = foodRow
      .getByRole('button', { name: 'View notes' })
      .first();

    await categoryNoteButton.click({ force: true });
    const notesInput = page.getByPlaceholder('Notes (markdown supported)');
    await notesInput.fill('General grocery category notes');
    await page.mouse.click(20, 20);

    await categoryNoteButton.click({ force: true });
    await expect(notesInput).toHaveValue('General grocery category notes');
  });

  test('modern budget page edits group row notes', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const usualExpensesRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({
        has: page.getByTestId('category-name').getByText('Usual Expenses'),
      })
      .first();
    await usualExpensesRow.hover();

    const groupNoteButton = usualExpensesRow.getByRole('button', {
      name: 'View notes',
    });
    await groupNoteButton.click({ force: true });

    const notesInput = page.getByPlaceholder('Notes (markdown supported)');
    await notesInput.fill('Usual expenses planning notes');
    await page.mouse.click(20, 20);

    await groupNoteButton.click({ force: true });
    await expect(notesInput).toHaveValue('Usual expenses planning notes');
  });

  test('modern budget page edits month summary notes', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const januarySummaryLane = budgetPage.budgetSummary
      .getByTestId('month-summary-lane')
      .filter({ hasText: 'Jan 2017' });
    const summaryNoteButton = januarySummaryLane.getByRole('button', {
      name: 'View notes',
    });

    await summaryNoteButton.click({ force: true });
    const notesInput = page.getByPlaceholder('Notes (markdown supported)');
    await notesInput.fill('January budget summary notes');
    await page.mouse.click(20, 20);

    await summaryNoteButton.click({ force: true });
    await expect(notesInput).toHaveValue('January budget summary notes');
  });

  test('modern budget page holds available funds for next month', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await budgetPage.setBudgetedAmount('Food', '0', 0);
    const toBudgetButton = budgetPage.budgetSummary
      .getByRole('button', {
        name: '400.00',
      })
      .first();
    await expect(toBudgetButton).toBeVisible();

    await toBudgetButton.click();
    await page.getByText('Hold for next month', { exact: true }).click();
    await page.getByRole('button', { name: 'Hold' }).click();

    await expect(toBudgetButton).not.toBeVisible();
  });

  test("modern budget page resets next month's buffer", async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await budgetPage.setBudgetedAmount('Food', '0', 0);
    const toBudgetButton = budgetPage.budgetSummary
      .getByRole('button', {
        name: '400.00',
      })
      .first();
    await expect(toBudgetButton).toBeVisible();

    await toBudgetButton.click();
    await page.getByText('Hold for next month', { exact: true }).click();
    await page.getByRole('button', { name: 'Hold' }).click();

    const resetButton = budgetPage.budgetSummary
      .getByRole('button', {
        name: '0.00',
      })
      .first();
    await resetButton.click();
    await page.getByText("Reset next month's buffer", { exact: true }).click();

    await expect(
      budgetPage.budgetSummary
        .getByRole('button', {
          name: '411.00',
        })
        .first(),
    ).toBeVisible();
  });

  test('modern budget page moves available funds to a category', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await budgetPage.setBudgetedAmount('Food', '0', 0);
    const restaurantsBalance = await budgetPage.getBalanceForRow(2);
    const toBudgetButton = budgetPage.budgetSummary
      .getByRole('button', {
        name: '400.00',
      })
      .first();
    await expect(toBudgetButton).toBeVisible();

    await toBudgetButton.click();
    await page.getByText('Move to a category', { exact: true }).click();
    await page.getByPlaceholder('(none)').click();
    await page.keyboard.type('Restaurants');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Transfer' }).click();

    await expect
      .poll(() => budgetPage.getBalanceForRow(2))
      .toEqual(restaurantsBalance + 40000);
    await expect(toBudgetButton).not.toBeVisible();
  });

  test('modern budget page covers overbudgeted funds from a category', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await budgetPage.setBudgetedAmount('Food', '900', 0);
    const restaurantsBalance = await budgetPage.getBalanceForRow(2);
    const toBudgetButton = budgetPage.budgetSummary
      .getByRole('button', {
        name: '-500.00',
      })
      .first();
    await expect(toBudgetButton).toBeVisible();

    await toBudgetButton.click();
    await page.getByText('Cover from a category', { exact: true }).click();
    await page.getByPlaceholder('(none)').click();
    await page.keyboard.type('Restaurants');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Transfer' }).click();

    await expect
      .poll(() => budgetPage.getBalanceForRow(2))
      .toEqual(restaurantsBalance - 50000);
    await expect(toBudgetButton).not.toBeVisible();
  });

  test('modern budget page covers category overspending from another category', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const clothingRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Clothing') })
      .first();
    const restaurantsBalance = await budgetPage.getBalanceForRow(2);

    await clothingRow.getByTestId('balance').first().click();
    await page.getByText('Cover overspending', { exact: true }).click();
    await page.getByPlaceholder('(none)').click();
    await page.keyboard.type('Restaurants');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Transfer' }).click();

    await expect(clothingRow.getByTestId('balance').first()).toContainText(
      '0.00',
    );
    await expect
      .poll(() => budgetPage.getBalanceForRow(2))
      .toEqual(restaurantsBalance - 6000);
  });

  test('modern budget page toggles category overspending rollover', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const clothingBalance = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Clothing') })
      .first()
      .getByTestId('balance')
      .first();

    await clothingBalance.click();
    await page.getByText('Rollover overspending', { exact: true }).click();

    await clothingBalance.click();
    await expect(
      page.getByText('Remove overspending rollover', { exact: true }),
    ).toBeVisible();
  });

  test('modern budget page opens income activity from received cells', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();
    await budgetPage.scrollToBottom();

    const incomeRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Misc') })
      .first();
    await expect(incomeRow).toBeVisible();

    await incomeRow.getByTestId('balance').first().click();
    await page.getByText('View transactions', { exact: true }).click();

    expect(page.url()).toContain('/accounts');
  });

  test('modern budget page toggles income auto hold', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();
    await budgetPage.setBudgetedAmount('Food', '0', 0);
    await budgetPage.scrollToBottom();

    const incomeBalance = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Income') })
      .last()
      .getByTestId('balance')
      .first();

    await incomeBalance.click();
    await page.getByText('Enable auto hold', { exact: true }).click();

    await incomeBalance.click();
    await expect(
      page.getByText('Disable auto hold', { exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');

    const januarySummaryLane = budgetPage.budgetSummary
      .getByTestId('month-summary-lane')
      .filter({ hasText: 'Jan 2017' });
    await januarySummaryLane
      .getByRole('button', { name: '-4.00' })
      .last()
      .click();
    await page.getByText('Disable current auto hold', { exact: true }).click();

    await expect(
      januarySummaryLane.getByRole('button', { name: '411.00' }).first(),
    ).toBeVisible();
  });

  test('modern budget page adds categories to the income group', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();
    await budgetPage.scrollToBottom();

    const incomeGroupRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Income') })
      .first();
    await expect(incomeGroupRow).toBeVisible();

    await incomeGroupRow
      .getByRole('button', { name: 'Group actions' })
      .click({ force: true });
    await page.getByText('Add category', { exact: true }).click();

    const newCategoryInput = page.getByPlaceholder('New category name');
    await newCategoryInput.fill('Side Income');
    await newCategoryInput.press('Enter');

    await expect(
      budgetPage.budgetTable
        .getByTestId('row')
        .filter({
          has: page.getByTestId('category-name').getByText('Side Income'),
        })
        .first(),
    ).toBeVisible();
  });

  test('modern budget page deletes income categories from row menus', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();
    await budgetPage.scrollToBottom();

    const incomeGroupRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Income') })
      .first();

    await incomeGroupRow
      .getByRole('button', { name: 'Group actions' })
      .click({ force: true });
    await page.getByText('Add category', { exact: true }).click();

    const newCategoryInput = page.getByPlaceholder('New category name');
    await newCategoryInput.fill('Side Income');
    await newCategoryInput.press('Enter');

    const miscRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Misc') });

    await miscRow.first().scrollIntoViewIfNeeded();
    await miscRow.first().hover();
    await miscRow
      .first()
      .getByRole('button', { name: 'Category actions' })
      .click({ force: true });
    await page.getByText('Delete', { exact: true }).click();

    await expect(miscRow).toHaveCount(0);
    await expect(
      budgetPage.budgetTable
        .getByTestId('row')
        .filter({
          has: page.getByTestId('category-name').getByText('Side Income'),
        })
        .first(),
    ).toBeVisible();
  });

  test('modern tracking budget labels income activity as received', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.useBudgetType('Tracking');
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();
    await budgetPage.scrollToBottom();

    const incomeGroupRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Income') })
      .first();
    const incomeCategoryRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Misc') })
      .first();

    await expect(incomeGroupRow.getByText('Received')).toHaveCount(2);
    await expect(incomeCategoryRow.getByText('Received')).toHaveCount(2);
  });

  test('modern tracking budget keeps expense balance actions rollover-only', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.useBudgetType('Tracking');
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const foodRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Food') })
      .first();

    await foodRow.hover();
    await foodRow.getByTestId('balance').first().click({ force: true });

    await expect(
      page.getByText('Rollover overspending', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Move balance', { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByText('Cover overspending', { exact: true }),
    ).toHaveCount(0);
  });

  test('modern tracking budget copies category budgets through year end', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.useBudgetType('Tracking');
    await settingsPage.enableExperimentalFeature('Modern budget page');
    await settingsPage.enableExperimentalFeature('Goal templates');

    budgetPage = await navigation.goToBudgetPage();

    await expect(
      budgetPage.budgetSummary.getByText(/ of /).first(),
    ).toBeVisible();

    await budgetPage.setBudgetedAmount('Food', '321', 0);
    const foodRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ hasText: 'Food' })
      .first();
    await expect(foodRow.getByTestId('budget').first()).toContainText('321');

    await foodRow.hover();
    await foodRow
      .getByRole('button', { name: 'Budget actions' })
      .first()
      .click({ force: true });
    await page.getByText('Copy until year end', { exact: true }).click();

    await expect(foodRow.getByTestId('budget').nth(1)).toContainText('321');

    const incomeRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Income') })
      .first();
    await incomeRow
      .getByRole('button', { name: 'Group actions' })
      .click({ force: true });
    await expect(
      page.getByText('Overwrite with templates', { exact: true }),
    ).toBeVisible();
  });

  test('modern budget page defaults to two months with progress visible', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await expect(page.getByText('Jan/17')).toBeVisible();
    await expect(page.getByText('Feb/17')).toBeVisible();
    await expect(page.getByText('Mar/17')).toHaveCount(0);
    await expect(budgetPage.budgetTable.getByText('Usage')).toHaveCount(2);
    await expect(budgetPage.budgetTable.getByText('Goal')).toHaveCount(1);
  });

  test('modern budget page shows goal dashes from the rightmost visible month', async () => {
    test.setTimeout(90_000);

    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');
    await settingsPage.enableExperimentalFeature('Goal templates');

    await page.evaluate(async () => {
      const $send = (
        window as unknown as {
          $send: (
            type: string,
            args?: unknown,
          ) => Promise<{
            list?: Array<{ id: string; name: string }>;
          }>;
        }
      ).$send;
      const categories = await $send('get-categories');
      const giftCategory = categories.list?.find(
        category => category.name === 'Gift',
      );
      if (!giftCategory) {
        throw new Error('Gift category not found.');
      }

      await $send('budget/set-category-automations', {
        categoriesWithTemplates: [
          {
            id: giftCategory.id,
            templates: [
              {
                directive: 'goal',
                type: 'goal',
                amount: 100,
              },
            ],
          },
        ],
        source: 'ui',
      });
      await $send('budget/overwrite-goal-template', { month: '2017-02' });
    });

    budgetPage = await navigation.goToBudgetPage();
    await budgetPage.setBudgetedAmount('Gift', '50', 1);

    const giftRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Gift') })
      .first();
    const goalButton = giftRow.getByRole('button', { name: 'Goal details' });

    await expect(goalButton.getByTestId('goal-dash')).toHaveCount(10);
    await expect
      .poll(() =>
        goalButton
          .getByTestId('goal-dash')
          .evaluateAll(
            dashes =>
              dashes.filter(dash => getComputedStyle(dash).opacity === '1')
                .length,
          ),
      )
      .toBeGreaterThan(0);

    await goalButton.click();
    await expect(page.getByText(/of 100\.00/).first()).toBeVisible();

    await page.mouse.click(5, 5);
    await expect(page.getByText(/of 100\.00/)).toHaveCount(0);
  });

  test('modern budget page changes visible month count', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await expect(page.getByText('Mar/17')).toHaveCount(0);
    await budgetPage.budgetTable
      .getByRole('button', { name: 'Category table actions' })
      .click({ force: true });
    await page.getByText('Show 3 months', { exact: true }).click();

    await expect(page.getByText('Mar/17')).toBeVisible();
    await expect(budgetPage.budgetSummary.getByText('Mar 2017')).toBeVisible();
  });

  test('modern budget page pans horizontally by dragging month cells', async () => {
    await page.setViewportSize({ width: 920, height: 720 });

    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await budgetPage.budgetTableScrollContainer.evaluate(element => {
      element.scrollLeft = 0;
    });
    await expect
      .poll(() =>
        budgetPage.budgetTableScrollContainer.evaluate(
          element => element.scrollWidth > element.clientWidth,
        ),
      )
      .toBe(true);

    const monthCell = budgetPage.budgetTable
      .getByTestId('group-month-cell')
      .first();
    const box = await monthCell.boundingBox();
    if (!box) {
      throw new Error('Unable to measure group month cell.');
    }

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 240, box.y + box.height / 2, {
      steps: 8,
    });
    await page.mouse.up();

    await expect.poll(() => budgetPage.getScrollLeft()).toBeGreaterThan(80);
  });

  test('modern budget page highlights the selected month summary', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const januarySummaryLane = budgetPage.budgetSummary
      .getByTestId('month-summary-lane')
      .filter({ hasText: 'Jan 2017' });
    const februarySummaryLane = budgetPage.budgetSummary
      .getByTestId('month-summary-lane')
      .filter({ hasText: 'Feb 2017' });

    const selectedBackground = await januarySummaryLane.evaluate(
      element => getComputedStyle(element).backgroundColor,
    );
    await expect(februarySummaryLane).not.toHaveCSS(
      'background-color',
      selectedBackground,
    );

    await budgetPage.goToNextMonth();

    await expect(februarySummaryLane).toHaveCSS(
      'background-color',
      selectedBackground,
    );
  });

  test('modern budget page collapses and expands month summaries', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const januarySummaryLane = budgetPage.budgetSummary
      .getByTestId('month-summary-lane')
      .filter({ hasText: 'Jan 2017' });

    await expect(
      januarySummaryLane.getByText('Available funds', { exact: true }),
    ).toBeVisible();
    await budgetPage.budgetSummary
      .getByRole('button', { name: 'Collapse month summary' })
      .click();

    await expect(
      januarySummaryLane.getByText('Available funds', { exact: true }),
    ).toHaveCount(0);
    await expect(
      januarySummaryLane.getByText('To budget', { exact: true }),
    ).toBeVisible();

    await budgetPage.budgetSummary
      .getByRole('button', { name: 'Expand month summary' })
      .click();
    await expect(
      januarySummaryLane.getByText('Available funds', { exact: true }),
    ).toBeVisible();
  });

  test('modern tracking budget collapses and expands month summaries', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.useBudgetType('Tracking');
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const januarySummaryLane = budgetPage.budgetSummary
      .getByTestId('month-summary-lane')
      .filter({ hasText: 'Jan 2017' });

    await expect(
      januarySummaryLane.getByText('Income', { exact: true }),
    ).toBeVisible();
    await expect(
      januarySummaryLane.getByText('Expenses', { exact: true }),
    ).toBeVisible();

    await budgetPage.budgetSummary
      .getByRole('button', { name: 'Collapse month summary' })
      .click();

    await expect(
      januarySummaryLane.getByText('Income', { exact: true }),
    ).toHaveCount(0);
    await expect(
      januarySummaryLane.getByText('Expenses', { exact: true }),
    ).toHaveCount(0);
    await expect(januarySummaryLane.getByText(/Projected|Saved/)).toBeVisible();

    await budgetPage.budgetSummary
      .getByRole('button', { name: 'Expand month summary' })
      .click();
    await expect(
      januarySummaryLane.getByText('Income', { exact: true }),
    ).toBeVisible();
    await expect(
      januarySummaryLane.getByText('Expenses', { exact: true }),
    ).toBeVisible();
  });

  test('modern budget page toggles month summaries from table actions', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const januarySummaryLane = budgetPage.budgetSummary
      .getByTestId('month-summary-lane')
      .filter({ hasText: 'Jan 2017' });

    await expect(
      januarySummaryLane.getByText('Available funds', { exact: true }),
    ).toBeVisible();

    await budgetPage.budgetTable
      .getByRole('button', { name: 'Category table actions' })
      .click({ force: true });
    await page.getByText('Hide summary', { exact: true }).click();

    await expect(
      januarySummaryLane.getByText('Available funds', { exact: true }),
    ).toHaveCount(0);

    await budgetPage.budgetTable
      .getByRole('button', { name: 'Category table actions' })
      .click({ force: true });
    await page.getByText('Show summary', { exact: true }).click();

    await expect(
      januarySummaryLane.getByText('Available funds', { exact: true }),
    ).toBeVisible();
  });

  test('modern budget page selects months from the runway cards', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await page.getByRole('button', { name: 'February 2017' }).click();

    await expect(budgetPage.selectedMonthButton).toHaveAttribute(
      'data-month',
      '2017-02',
    );
    await expect(
      page.getByRole('button', { name: 'March 2017' }),
    ).toBeVisible();
  });

  test('modern budget page navigates months with arrow keys', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await page.keyboard.press('ArrowRight');
    await expect(budgetPage.selectedMonthButton).toHaveAttribute(
      'data-month',
      '2017-02',
    );

    await page.keyboard.press('ArrowLeft');
    await expect(budgetPage.selectedMonthButton).toHaveAttribute(
      'data-month',
      '2017-01',
    );
  });

  test('modern budget page jumps to the current month with the today control', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await page.getByRole('button', { name: 'February 2017' }).click();
    await expect(budgetPage.selectedMonthButton).toHaveAttribute(
      'data-month',
      '2017-02',
    );

    await page.getByRole('button', { name: 'Today' }).click();
    await expect(budgetPage.selectedMonthButton).toHaveAttribute(
      'data-month',
      '2017-01',
    );
  });

  test('modern budget page expands and collapses all category groups', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const foodRow = budgetPage.budgetTable
      .getByTestId('row')
      .filter({ has: page.getByTestId('category-name').getByText('Food') });
    await expect(foodRow.first()).toBeVisible();

    await budgetPage.budgetTable
      .getByRole('button', { name: 'Category table actions' })
      .click({ force: true });
    await page.getByText('Collapse all', { exact: true }).click();
    await expect(foodRow).toHaveCount(0);

    await budgetPage.budgetTable
      .getByRole('button', { name: 'Category table actions' })
      .click({ force: true });
    await page.getByText('Expand all', { exact: true }).click();
    await expect(foodRow.first()).toBeVisible();
  });

  test('modern budget page cycles category name width', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    const usualExpensesHeader = budgetPage.budgetTable
      .getByTestId('row')
      .filter({
        has: page.getByTestId('category-name').getByText('Usual Expenses'),
      })
      .first()
      .getByTestId('group-header');
    const initialWidth = (await usualExpensesHeader.boundingBox())?.width;
    if (!initialWidth) {
      throw new Error('Unable to measure category header width.');
    }

    await budgetPage.budgetTable
      .getByRole('button', { name: 'Category table actions' })
      .click({ force: true });
    await page.getByText('Expand names', { exact: true }).click();

    await expect
      .poll(async () => (await usualExpensesHeader.boundingBox())?.width)
      .toBeGreaterThan(initialWidth);
  });

  test('modern budget page toggles progress display', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');

    budgetPage = await navigation.goToBudgetPage();

    await expect(budgetPage.budgetTable.getByText('Usage')).toHaveCount(2);
    await expect(budgetPage.budgetTable.getByText('Goal')).toHaveCount(1);
    await expect(
      budgetPage.budgetTable
        .getByTestId('row')
        .filter({ hasText: 'Usual Expenses' })
        .first()
        .getByTestId('usage-dash'),
    ).toHaveCount(10);

    await budgetPage.budgetTable
      .getByRole('button', { name: 'Category table actions' })
      .click({ force: true });
    await page.getByText('Hide progress bars', { exact: true }).click();

    await expect(budgetPage.budgetTable.getByText('Usage')).toHaveCount(0);
    await expect(budgetPage.budgetTable.getByText('Goal')).toHaveCount(0);
    await expect(
      budgetPage.budgetTable.getByText('Balance').first(),
    ).toBeVisible();
  });
});

test.describe('Budget scroll position', () => {
  let page: Page;
  let configurationPage: ConfigurationPage;
  let budgetPage: BudgetPage;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    configurationPage = new ConfigurationPage(page);

    await page.goto('/');
    budgetPage = await configurationPage.createTestFile();

    // Add enough categories to make the budget table scrollable.
    const categoryCount = 20;
    await page.evaluate(async count => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const $send = (window as any).$send as (
        type: string,
        args?: unknown,
      ) => Promise<string>;
      const groupId = await $send('category-group-create', {
        name: 'Extra Categories',
      });
      for (let i = 1; i <= count; i++) {
        await $send('category-create', { name: `Category ${i}`, groupId });
      }
      // Invalidate the category query so React re-renders with the new categories.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).__TANSTACK_QUERY_CLIENT__.invalidateQueries({
        queryKey: ['categories', 'lists'],
      });
    }, categoryCount);
    await page
      .getByText(`Category ${categoryCount}`, { exact: true })
      .waitFor({ state: 'visible' });

    await page.mouse.move(0, 0);
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test('scroll position is restored when navigating back from spent transactions page', async () => {
    await budgetPage.scrollToBottom();
    const scrollTopBeforeViewingSpent = await budgetPage.getScrollTop();
    expect(scrollTopBeforeViewingSpent).toBeGreaterThan(0);

    // Click a spent-amount cell that is already visible at the current scroll position so the scroll does not change
    // before the handler captures it.
    await budgetPage.clickOnSpentAmountForLastVisibleRow();
    expect(page.url()).toContain('/accounts');

    await page.getByRole('button', { name: 'Back' }).click();
    await budgetPage.waitFor();

    const scrollTopAfterReturningFromSpent = await budgetPage.getScrollTop();
    expect(scrollTopAfterReturningFromSpent).toBe(scrollTopBeforeViewingSpent);
  });

  test('modern budget page restores scroll position after viewing spent transactions', async () => {
    const navigation = new Navigation(page);
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Modern budget page');
    budgetPage = await navigation.goToBudgetPage();

    await budgetPage.scrollToBottom();
    const scrollTopBeforeViewingSpent = await budgetPage.getScrollTop();
    expect(scrollTopBeforeViewingSpent).toBeGreaterThan(0);

    await budgetPage.clickOnSpentAmountForLastVisibleRow();
    expect(page.url()).toContain('/accounts');

    await page.getByRole('button', { name: 'Back' }).click();
    await budgetPage.waitFor();

    const scrollTopAfterReturningFromSpent = await budgetPage.getScrollTop();
    expect(scrollTopAfterReturningFromSpent).toBe(scrollTopBeforeViewingSpent);
  });
});
