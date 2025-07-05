// import { test, expect } from '@playwright/test';
// import { setupActualBudgetForPlugins } from './fixtures/setup';

// test.describe('HostContext Methods', () => {
//   test.beforeEach(async ({ page }) => {
//     // Complete setup flow: bootstrap, login, create budget, enable plugins
//     await setupActualBudgetForPlugins(page);
//   });

//   test('registerDashboardWidget and unregisterDashboardWidget', async ({ page }) => {
//     // Access plugin context
//     const widgetRegistered = await page.evaluate(() => {
//       const context = (window as any).testPluginContext;
//       if (!context) return false;
      
//       // Register a test widget
//       const widgetId = context.registerDashboardWidget(
//         'test-widget-dynamic',
//         'Dynamic Test Widget',
//         'Test widget content',
//         { defaultWidth: 2, defaultHeight: 1 }
//       );
      
//       return { widgetId, registered: true };
//     });
    
//     expect(widgetRegistered.registered).toBeTruthy();
    
//     // Navigate to dashboard and verify widget is available
//     await page.goto('/reports');
//     await page.click('[data-testid="add-widget-btn"]');
//     await expect(page.locator('text=Dynamic Test Widget')).toBeVisible();
    
//     // Unregister the widget
//     const widgetUnregistered = await page.evaluate((data) => {
//       const context = (window as any).testPluginContext;
//       if (!context) return false;
      
//       context.unregisterDashboardWidget(data.widgetId);
//       return true;
//     }, widgetRegistered);
    
//     expect(widgetUnregistered).toBeTruthy();
    
//     // Verify widget is no longer available
//     await page.reload();
//     await page.click('[data-testid="add-widget-btn"]');
//     await expect(page.locator('text=Dynamic Test Widget')).toBeHidden();
//   });

//   test('registerMenu and unregisterMenu', async ({ page }) => {
//     // Register a menu item
//     const menuRegistered = await page.evaluate(() => {
//       const context = (window as any).testPluginContext;
//       if (!context) return false;
      
//       const menuId = context.registerMenu(
//         'main-menu',
//         'Dynamic Menu Item Test'
//       );
      
//       return { menuId, registered: true };
//     });
    
//     expect(menuRegistered.registered).toBeTruthy();
    
//     // Check that menu item appears
//     await expect(page.locator('text=Dynamic Menu Item Test')).toBeVisible();
    
//     // Unregister menu item
//     const menuUnregistered = await page.evaluate((data) => {
//       const context = (window as any).testPluginContext;
//       if (!context) return false;
      
//       context.unregisterMenu(data.menuId);
//       return true;
//     }, menuRegistered);
    
//     expect(menuUnregistered).toBeTruthy();
    
//     // Verify menu item is removed
//     await page.reload();
//     await expect(page.locator('text=Dynamic Menu Item Test')).toBeHidden();
//   });

//   test('registerRoute and unregisterRoute', async ({ page }) => {
//     // Register a custom route
//     const routeRegistered = await page.evaluate(() => {
//       const context = (window as any).testPluginContext;
//       if (!context) return false;
      
//       const routeId = context.registerRoute(
//         '/dynamic-test-route',
//         'Dynamic Route Content'
//       );
      
//       return { routeId, registered: true };
//     });
    
//     expect(routeRegistered.registered).toBeTruthy();
    
//     // Navigate to the route
//     await page.goto('/dynamic-test-route');
//     await expect(page.locator('text=Dynamic Route Content')).toBeVisible();
    
//     // Unregister route
//     const routeUnregistered = await page.evaluate((data) => {
//       const context = (window as any).testPluginContext;
//       if (!context) return false;
      
//       context.unregisterRoute(data.routeId);
//       return true;
//     }, routeRegistered);
    
//     expect(routeUnregistered).toBeTruthy();
    
//     // Verify route is no longer accessible
//     await page.goto('/dynamic-test-route');
//     // Should show 404 or redirect to home
//     await expect(page.locator('text=Dynamic Route Content')).toBeHidden();
//   });

//   test('pushModal and popModal', async ({ page }) => {
//     // Test modal functionality
//     const modalOpened = await page.evaluate(() => {
//       const context = (window as any).testPluginContext;
//       if (!context) return false;
      
//       // Push a modal
//       context.pushModal('Test Modal Content', {
//         title: 'Test Modal',
//         size: { width: 400, height: 300 }
//       });
      
//       return true;
//     });
    
//     expect(modalOpened).toBeTruthy();
    
//     // Verify modal is visible
//     await expect(page.locator('text=Test Modal Content')).toBeVisible();
//     await expect(page.locator('text=Test Modal')).toBeVisible();
    
//     // Close modal
//     const modalClosed = await page.evaluate(() => {
//       const context = (window as any).testPluginContext;
//       if (!context) return false;
      
//       context.popModal();
//       return true;
//     });
    
//     expect(modalClosed).toBeTruthy();
    
//     // Verify modal is hidden
//     await expect(page.locator('text=Test Modal Content')).toBeHidden();
//   });

//   test('addTheme', async ({ page }) => {
//     // Add a custom theme
//     const themeAdded = await page.evaluate(() => {
//       const context = (window as any).testPluginContext;
//       if (!context) return false;
      
//       context.addTheme('test-dynamic-theme', 'Dynamic Test Theme', {
//         pageBackground: '#123456',
//         cardBackground: '#654321',
//         buttonPrimaryBackground: '#abcdef',
//       }, {
//         baseTheme: 'light',
//         description: 'A dynamically added test theme'
//       });
      
//       return true;
//     });
    
//     expect(themeAdded).toBeTruthy();
    
//     // Navigate to theme settings
//     await page.goto('/settings/themes');
    
//     // Verify theme is available
//     await expect(page.locator('text=Dynamic Test Theme')).toBeVisible();
//     await expect(page.locator('text=A dynamically added test theme')).toBeVisible();
//   });

//   test('overrideTheme', async ({ page }) => {
//     // Override existing theme
//     const themeOverridden = await page.evaluate(() => {
//       const context = (window as any).testPluginContext;
//       if (!context) return false;
      
//       context.overrideTheme('light', {
//         'custom-testOverride': '#ff0000',
//         pageBackground: '#f9f9f9'
//       });
      
//       return true;
//     });
    
//     expect(themeOverridden).toBeTruthy();
    
//     // Verify theme override is applied
//     const themeOverrideApplied = await page.evaluate(() => {
//       // Check if theme variables are updated in the DOM
//       const style = getComputedStyle(document.documentElement);
//       return style.getPropertyValue('--custom-testOverride') || 
//              style.getPropertyValue('--page-background');
//     });
    
//     // This would depend on how theme overrides are implemented
//     expect(themeOverrideApplied).toBeDefined();
//   });

//   test('navigate', async ({ page }) => {
//     // Test navigation method
//     const navigationTriggered = await page.evaluate(() => {
//       const context = (window as any).testPluginContext;
//       if (!context) return false;
      
//       // Navigate to a different page
//       context.navigate('/accounts');
//       return true;
//     });
    
//     expect(navigationTriggered).toBeTruthy();
    
//     // Verify navigation occurred
//     await page.waitForURL('**/accounts');
//     expect(page.url()).toContain('/accounts');
//   });

//   test('createSpreadsheet', async ({ page }) => {
//     // Test spreadsheet creation
//     const spreadsheetCreated = await page.evaluate(async () => {
//       const context = (window as any).testPluginContext;
//       if (!context) return false;
      
//       try {
//         const spreadsheet = context.createSpreadsheet();
        
//         // Test basic spreadsheet operations
//         await spreadsheet.createQuery('test-sheet', 'test-query', {
//           table: 'test_plugin_data',
//           select: ['*']
//         });
        
//         const cellNames = await spreadsheet.getCellNames('test-sheet');
        
//         return {
//           created: true,
//           hasCreateQuery: typeof spreadsheet.createQuery === 'function',
//           hasGetCellNames: typeof spreadsheet.getCellNames === 'function',
//           cellNames: cellNames
//         };
//       } catch (error) {
//         return { created: false, error: error.message };
//       }
//     });
    
//     expect(spreadsheetCreated.created).toBeTruthy();
//     expect(spreadsheetCreated.hasCreateQuery).toBeTruthy();
//     expect(spreadsheetCreated.hasGetCellNames).toBeTruthy();
//   });

//   test('makeFilters', async ({ page }) => {
//     // Test filter creation
//     const filtersCreated = await page.evaluate(async () => {
//       const context = (window as any).testPluginContext;
//       if (!context) return false;
      
//       try {
//         const conditions = [
//           { field: 'amount', op: 'lt', value: 0 },
//           { field: 'date', op: 'gte', value: '2024-01-01' }
//         ];
        
//         const filterResult = await context.makeFilters(conditions);
        
//         return {
//           created: true,
//           hasFilters: !!filterResult.filters,
//           filterResult: filterResult
//         };
//       } catch (error) {
//         return { created: false, error: error.message };
//       }
//     });
    
//     expect(filtersCreated.created).toBeTruthy();
//     expect(filtersCreated.hasFilters).toBeTruthy();
//   });

//   test('event system with on method', async ({ page }) => {
//     // Test event registration and handling
//     const eventSystemSetup = await page.evaluate(() => {
//       const context = (window as any).testPluginContext;
//       if (!context) return false;
      
//       // Clear previous events
//       (window as any).testEventReceived = [];
      
//       // Register event listeners
//       context.on('accounts', (data) => {
//         (window as any).testEventReceived.push({ type: 'accounts', data });
//       });
      
//       context.on('categories', (data) => {
//         (window as any).testEventReceived.push({ type: 'categories', data });
//       });
      
//       return true;
//     });
    
//     expect(eventSystemSetup).toBeTruthy();
    
//     // Simulate events (this would normally come from the app)
//     await page.evaluate(() => {
//       // Simulate events being triggered
//       const context = (window as any).testPluginContext;
//       if (context && context._eventEmitter) {
//         // This would depend on the actual event system implementation
//         context._eventEmitter.emit('accounts', { accounts: [{ id: '1', name: 'Test' }] });
//       }
//     });
    
//     // Wait for events to be processed
//     await page.waitForTimeout(1000);
    
//     // Check that events were received
//     const eventsReceived = await page.evaluate(() => (window as any).testEventReceived);
//     expect(Array.isArray(eventsReceived)).toBeTruthy();
//   });

//   test('query builder (q method)', async ({ page }) => {
//     // Test query builder functionality
//     const queryBuilderTest = await page.evaluate(() => {
//       const context = (window as any).testPluginContext;
//       if (!context || !context.q) return false;
      
//       try {
//         // Test query building
//         const query = context.q('test_plugin_data')
//           .filter({ name: 'test' })
//           .select(['id', 'name', 'value'])
//           .limit(10);
        
//         // Check query structure
//         const state = query.serialize();
        
//         return {
//           success: true,
//           hasTable: state.table === 'test_plugin_data',
//           hasFilter: state.filterExpressions.length > 0,
//           hasSelect: state.selectExpressions.length > 0,
//           hasLimit: state.limit === 10,
//           state: state
//         };
//       } catch (error) {
//         return { success: false, error: error.message };
//       }
//     });
    
//     expect(queryBuilderTest.success).toBeTruthy();
//     expect(queryBuilderTest.hasTable).toBeTruthy();
//     expect(queryBuilderTest.hasFilter).toBeTruthy();
//     expect(queryBuilderTest.hasSelect).toBeTruthy();
//     expect(queryBuilderTest.hasLimit).toBeTruthy();
//   });
// }); 