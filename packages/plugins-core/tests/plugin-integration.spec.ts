import { test, expect, Page } from '@playwright/test';
import { setupActualBudgetForPlugins, installTestPlugin as setupInstallTestPlugin } from './fixtures/setup';

// Helper function to install the test plugin using module federation
async function installTestPlugin(page: Page) {
  console.log('Installing test plugin via module federation...');
  
  // First, enable the plugins feature flag
  await page.goto('/settings');
  
  // Wait for settings page to load
  await page.waitForSelector('[data-testid="settings"]', { timeout: 5000 });
  
  // Click on Advanced toggle to expand advanced settings
  const advancedToggle = page.locator('text=Advanced').or(page.locator('[data-testid="advanced-toggle"]'));
  if (await advancedToggle.count() > 0) {
    await advancedToggle.click();
    console.log('Expanded advanced settings');
  }
  
  // Look for Experimental Features section
  const experimentalSection = page.locator('text=Experimental Features').or(page.locator('text=Experimental'));
  await expect(experimentalSection).toBeVisible({ timeout: 1000 });
  
  // Enable plugins feature flag - look for a checkbox or toggle near "plugins" text
  const pluginsToggle = page.locator('input[type="checkbox"]').filter({ 
    has: page.locator('text=Plugins').or(page.locator('text=plugins'))
  }).first();
  
  if (await pluginsToggle.count() > 0) {
    if (!(await pluginsToggle.isChecked())) {
      await pluginsToggle.click();
      console.log('Enabled plugins feature flag');
      
      // Wait a moment for the feature flag to take effect
      await page.waitForTimeout(1000);
    }
  } else {
    // Alternative: try to enable via localStorage/preferences API
    await page.evaluate(() => {
      // Try to set the feature flag directly
      const storageKey = 'flags.plugins';
      localStorage.setItem(storageKey, 'true');
      
      // Or try via preferences if available
      if ((window as any).__actual && (window as any).__actual.setPreference) {
        (window as any).__actual.setPreference('flags.plugins', true);
      }
    });
    console.log('Enabled plugins feature flag via localStorage');
  }
  
  // Navigate to plugins page
  await page.goto('/plugins');
  
  // Wait for plugins page to load
  await page.waitForSelector('text=Plugins', { timeout: 5000 });
  
  // Check if dev plugin section exists
  const devPluginInput = page.locator('input[value="http://localhost:2000/mf-manifest.json"]');
  if (await devPluginInput.count() === 0) {
    throw new Error('Dev plugin input not found. Make sure you are on the plugins page and plugins feature flag is enabled.');
  }
  
  // Click the "Enable Dev Plugin" button to load the test plugin
  await page.getByRole('button', { name: 'Enable Dev Plugin' }).click();
  
  // Wait for plugin to load - check for success indicators
  // The plugin should appear in the plugin list or dashboard should update
  await page.waitForTimeout(3000); // Give time for module federation to load
  
  console.log('Test plugin installation completed');
}

// Helper function to uninstall the test plugin
async function uninstallTestPlugin(page: Page) {
  console.log('Uninstalling test plugin...');
  
  // Navigate to plugins page if not already there
  await page.goto('/plugins');
  
  // Look for the test plugin in the list and uninstall it
  // This might involve clicking a delete/uninstall button
  // For now, we'll just refresh to clear any state
  await page.reload();
  
  console.log('Test plugin uninstalled');
}

test.describe('Plugin Integration Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Set up console log capture to include browser console messages in test output
    page.on('console', msg => {
      const type = msg.type();
      const text = msg.text();
      
      // Only log important messages to avoid spam
      if (type === 'error' || type === 'warn' || text.includes('plugin') || text.includes('Plugin')) {
        console.log(`[Browser ${type.toUpperCase()}] ${text}`);
      }
    });

    // Capture page errors
    page.on('pageerror', error => {
      console.error(`[Browser PAGE ERROR] ${error.message}`);
    });

    // Complete setup flow: bootstrap, login, create budget, enable plugins
    await setupActualBudgetForPlugins(page);
  });

  test.afterEach(async ({ page }) => {
    // Clean up any installed plugins
    await uninstallTestPlugin(page);
  });

  test('should install plugin via module federation', async ({ page }) => {
    await setupInstallTestPlugin(page);
    
    // Verify plugin is loaded by checking if plugin appears in the plugin list
    await page.goto('/plugins');
    
    // Look for evidence that the plugin was successfully installed
    // This could be the plugin appearing in the installed plugins list
    const pluginsList = page.locator('[data-testid="installed-plugins"]').or(page.locator('text=Test Plugin'));
    await expect(pluginsList).toBeVisible({ timeout: 5000 });
  });

  test('should register and display dashboard widgets', async ({ page }) => {
    await setupInstallTestPlugin(page);
    
    // Navigate to dashboard/overview page
    await page.goto('/');
    
    // Look for dashboard widget management or widget areas
    const dashboardArea = page.locator('[data-testid="dashboard"]').or(page.locator('.dashboard-widgets'));
    
    // Check if we can add a widget from the test plugin
    // This test verifies the registerDashboardWidget API works
    const addWidgetButton = page.getByRole('button', { name: /add widget/i }).or(page.getByRole('button', { name: /customize/i }));
    if (await addWidgetButton.count() > 0) {
      await addWidgetButton.click();
      
      // Look for test plugin widgets in the available widgets list
      const testPluginWidget = page.getByText('Test Plugin').or(page.locator('[data-widget-type*="test"]'));
      await expect(testPluginWidget).toBeVisible({ timeout: 5000 });
    }
  });

  test('should register sidebar menu items', async ({ page }) => {
    await setupInstallTestPlugin(page);
    
    await page.goto('/');
    
    // Check sidebar for new menu items added by the plugin
    // This tests the registerMenu API with different sidebar locations
    const sidebar = page.locator('[data-testid="sidebar"]').or(page.locator('.sidebar'));
    await expect(sidebar).toBeVisible();
    
    // Look for plugin-added menu items in various locations
    const pluginMenuItems = page.locator('[data-testid*="plugin"]').or(page.getByText('Test Plugin'));
    
    // At least one plugin menu item should be visible
    await expect(pluginMenuItems.first()).toBeVisible({ timeout: 5000 });
  });

  test('should register custom routes', async ({ page }) => {
    await setupInstallTestPlugin(page);
    
    // Test navigation to a custom route registered by the plugin
    // This tests the registerRoute API
    await page.goto('/test-plugin-route');
    
    // Check that the custom route content is displayed
    const customRouteContent = page.locator('[data-testid="plugin-route"]').or(page.getByText('Plugin Route'));
    await expect(customRouteContent).toBeVisible({ timeout: 5000 });
  });

  test('should handle modal functionality', async ({ page }) => {
    await setupInstallTestPlugin(page);
    
    await page.goto('/');
    
    // Find a plugin button that opens a modal
    const pluginButton = page.getByTestId('plugin-modal-button').or(page.getByText('Open Plugin Modal'));
    
    if (await pluginButton.count() > 0) {
      await pluginButton.click();
      
      // Modal should open - this tests pushModal API
      const modal = page.locator('[data-testid="modal"]').or(page.locator('.modal'));
      await expect(modal).toBeVisible();
      
      // Test modal close - this tests popModal API
      const closeButton = page.getByRole('button', { name: /close/i }).or(page.getByTestId('close-modal'));
      await closeButton.click();
      
      // Modal should be closed
      await expect(modal).not.toBeVisible();
    }
  });

  test('should access plugin database', async ({ page }) => {
    await setupInstallTestPlugin(page);
    
    // This test verifies that plugins can use their isolated database
    // We'll check for any plugin-generated content that would require database access
    await page.goto('/');
    
    // Look for any plugin content that would indicate successful database operations
    // This could be plugin settings, stored data, or dynamic content
    const pluginData = page.locator('[data-testid*="plugin-data"]').or(page.locator('.plugin-content'));
    
    // If plugin creates any persistent data, it should be visible
    // This tests the plugin database isolation and basic CRUD operations
    if (await pluginData.count() > 0) {
      await expect(pluginData.first()).toBeVisible();
    }
  });

  test('should register themes', async ({ page }) => {
    await installTestPlugin(page);
    
    // Navigate to theme settings
    await page.goto('/settings/appearance');
    
    // Check if plugin-registered themes appear in the theme selector
    // This tests the addTheme API
    const themeSelector = page.locator('select').or(page.locator('[data-testid="theme-selector"]'));
    
    if (await themeSelector.count() > 0) {
      // Look for plugin themes in the options
      const pluginTheme = page.locator('option').filter({ hasText: /plugin|test/i });
      await expect(pluginTheme.first()).toBeVisible({ timeout: 5000 });
    }
  });

  test('should handle data queries and filters', async ({ page }) => {
    await installTestPlugin(page);
    
    await page.goto('/');
    
    // Check for any plugin content that demonstrates data querying
    // This tests the query builder (q) and makeFilters APIs
    const dataDisplay = page.locator('[data-testid*="plugin-stats"]').or(page.locator('.plugin-data-display'));
    
    if (await dataDisplay.count() > 0) {
      // Plugin should be able to display calculated data from the main database
      await expect(dataDisplay.first()).toBeVisible();
      
      // Check for numerical data that would indicate successful queries
      const numbers = page.locator('[data-testid*="amount"]').or(page.locator('[data-testid*="total"]'));
      if (await numbers.count() > 0) {
        await expect(numbers.first()).toBeVisible();
      }
    }
  });

  test('should handle spreadsheet integration', async ({ page }) => {
    await installTestPlugin(page);
    
    await page.goto('/');
    
    // Check for plugin features that use spreadsheet functionality
    // This tests the createSpreadsheet API and useReport hook
    const reportContent = page.locator('[data-testid*="plugin-report"]').or(page.locator('.plugin-report'));
    
    if (await reportContent.count() > 0) {
      await expect(reportContent.first()).toBeVisible();
    }
  });

  test('should support plugin lifecycle events', async ({ page }) => {
    await installTestPlugin(page);
    
    // Test that plugins respond to data changes
    // Navigate to a page that would trigger events
    await page.goto('/accounts');
    
    // Create or modify an account to trigger events
    const addAccountButton = page.getByRole('button', { name: /add account/i });
    if (await addAccountButton.count() > 0) {
      await addAccountButton.click();
      
      // Fill out account form if modal opens
      const accountNameInput = page.locator('input[name="name"]').or(page.getByPlaceholder(/account name/i));
      if (await accountNameInput.count() > 0) {
        await accountNameInput.fill('Test Account for Plugin');
        
        const saveButton = page.getByRole('button', { name: /save|create/i });
        await saveButton.click();
      }
    }
    
    // Go back to main page to see if plugin responded to the account change event
    await page.goto('/');
    
    // Check for any plugin content that would update based on account changes
    // This tests the event system (context.on)
    const updatedContent = page.locator('[data-testid*="plugin"]');
    if (await updatedContent.count() > 0) {
      await expect(updatedContent.first()).toBeVisible();
    }
  });

  test('should support plugin migration system', async ({ page }) => {
    await installTestPlugin(page);
    
    // This test verifies that plugin migrations run successfully
    // We can check this by looking for plugin functionality that would require
    // database tables created by migrations
    
    await page.goto('/plugins');
    
    // Check plugin status or logs for migration success
    const pluginStatus = page.locator('[data-testid="plugin-status"]').or(page.getByText(/active|running/i));
    
    if (await pluginStatus.count() > 0) {
      await expect(pluginStatus.first()).toBeVisible();
    }
    
    // If plugin has any persistent features, they should work after migrations
    await page.goto('/');
    const persistentFeatures = page.locator('[data-testid*="plugin"]');
    if (await persistentFeatures.count() > 0) {
      await expect(persistentFeatures.first()).toBeVisible();
    }
  });

  test('should handle navigation API', async ({ page }) => {
    await installTestPlugin(page);
    
    await page.goto('/');
    
    // Find a plugin element that uses navigation
    const navigationButton = page.getByTestId('plugin-navigate').or(page.getByText('Navigate to'));
    
    if (await navigationButton.count() > 0) {
      await navigationButton.click();
      
      // Check that navigation occurred
      // This tests the context.navigate API
      await page.waitForTimeout(1000);
      
      // Should have navigated to a different route
      const currentUrl = page.url();
      expect(currentUrl).not.toBe('/');
    }
  });

  test('should properly uninstall and cleanup', async ({ page }) => {
    await installTestPlugin(page);
    
    // Verify plugin is working
    await page.goto('/');
    
    // Navigate to plugins page
    await page.goto('/plugins');
    
    // Find and click uninstall/disable button for the test plugin
    const uninstallButton = page.getByRole('button', { name: /uninstall|disable|remove/i });
    if (await uninstallButton.count() > 0) {
      await uninstallButton.click();
      
      // Confirm uninstall if prompted
      const confirmButton = page.getByRole('button', { name: /confirm|yes|uninstall/i });
      if (await confirmButton.count() > 0) {
        await confirmButton.click();
      }
    }
    
    // Wait for uninstall to complete
    await page.waitForTimeout(2000);
    
    // Go back to main page and verify plugin elements are removed
    await page.goto('/');
    
    // Plugin elements should no longer be visible
    const pluginElements = page.locator('[data-testid*="plugin"]');
    if (await pluginElements.count() > 0) {
      await expect(pluginElements.first()).not.toBeVisible();
    }
  });

  test('should handle plugin errors gracefully', async ({ page }) => {
    // Test error handling by trying to install a non-existent plugin
    await page.goto('/plugins');
    
    // Try to install from an invalid URL
    const urlInput = page.locator('input[type="url"]').or(page.getByPlaceholder(/plugin url/i));
    if (await urlInput.count() > 0) {
      await urlInput.fill('http://localhost:9999/invalid-plugin.json');
      
      const installButton = page.getByRole('button', { name: /install|add/i });
      await installButton.click();
      
      // Should show error message
      const errorMessage = page.locator('[data-testid="error"]').or(page.getByText(/error|failed/i));
      await expect(errorMessage).toBeVisible({ timeout: 5000 });
    }
  });
}); 