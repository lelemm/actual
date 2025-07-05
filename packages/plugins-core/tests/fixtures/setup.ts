import { type Page, expect } from '@playwright/test';

/**
 * Complete setup flow for plugin tests:
 * 1. Bootstrap (create user/password) 
 * 2. Login
 * 3. Create budget file
 * 4. Enable plugin feature flags
 */

export async function setupActualBudgetForPlugins(page: Page) {
  console.log('🔧 Setting up Actual Budget for plugin tests...');
  
  // Navigate to the main app
  await page.goto('/');
  
  // Wait for page to load
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(5000);
  
  // Check current page state
  const currentUrl = page.url();
  console.log(`📍 Current URL: ${currentUrl}`);
  
  // Check if we need to connect to server first
  const configServerPage = page.getByTestId('config-server-page');
  
  if (await configServerPage.isVisible({ timeout: 10000 })) {
    console.log('🔌 Found server config page - connecting to sync server...');
    await connectToServer(page);
    console.log('✅ Server connection completed');
    
    // Wait for page to potentially redirect after server connection
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(10000);
  } else {
    console.log('ℹ️  No server config page found, checking other states...');
  }
  
  // Check if we need to bootstrap (create user/password) or just login
  const bootstrapPage = page.getByTestId('bootstrap-page');
  const loginPage = page.getByTestId('login-page');
  
  if (await bootstrapPage.isVisible({ timeout: 5000 })) {
    console.log('📝 Bootstrapping - creating user and password...');
    await bootstrap(page);
    // After bootstrap, we're redirected to login, so login immediately
    await login(page);
  } else if (await loginPage.isVisible({ timeout: 5000 })) {
    console.log('🔑 Logging in with existing credentials...');
    await login(page);
  } else {
    console.log('ℹ️  No authentication required, checking if already logged in...');
  }
  
  // Give the application more time to fully load after authentication
  console.log('⏳ Waiting for application to fully load after authentication...');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(5000); // Increased wait time
  
  // Try to navigate to the main page to see the budget selection/creation flow
  console.log('🏠 Navigating to main page to check budget state...');
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  
  // Check if we need to set up budget
  const allAccountsText = page.getByTestId('account-name');
  const startFreshButton = page.getByRole('button', { name: 'Start fresh' });
  const openFileButton = page.getByRole('button', { name: 'Open file' });
  
  if (await allAccountsText.isVisible({ timeout: 5000 })) {
    console.log('✅ Budget already exists');
  } else if (await startFreshButton.isVisible({ timeout: 5000 })) {
    console.log('💰 Creating budget file...');
    await createBudgetFile(page);
  } else if (await openFileButton.isVisible({ timeout: 5000 })) {
    console.log('💰 Found file selection page, creating new budget...');
    await createBudgetFile(page);
  } else {
    // Handle other cases - might be in a different state
    console.log('🔍 Checking current state...');
    const currentUrl = page.url();
    console.log(`📍 Current URL after authentication: ${currentUrl}`);
    
    // Look for any buttons or text that might indicate what state we're in
    const pageContent = await page.textContent('body');
    console.log('📄 Page content preview:', pageContent?.substring(0, 200) + '...');
    await page.waitForTimeout(5000);
  }
  
  // Enable plugin feature flags if needed
  console.log('🔌 Enabling plugin features...');
  await enablePluginFeatures(page);
  
  console.log('✅ Setup complete!');
}

async function connectToServer(page: Page) {
  console.log('🔌 Attempting to connect to server...');
  
  // Enter the server URL (http://localhost:5006)
  const serverUrlInput = page.getByTestId('server-url-input');
  if (await serverUrlInput.isVisible({ timeout: 5000 })) {
    console.log('📝 Found server URL input, filling in server URL...');
    await serverUrlInput.clear();
    await serverUrlInput.fill('http://localhost:5006');
    
    console.log('🖱️  Clicking OK button to connect...');
    // Click the OK button to connect
    const okButton = page.getByRole('button', { name: 'OK' });
    await okButton.click();
    
    console.log('⏳ Waiting for server connection to complete...');
    // Wait for server connection to complete
    await page.waitForLoadState('networkidle');
    
    // Additional wait to ensure connection is established
    await page.waitForTimeout(1000);
    console.log('✅ Server connection process completed');
  } else {
    console.log('❌ Server URL input not found');
  }
}

async function bootstrap(page: Page) {
  // Fill in password fields
  const password = 'testpassword';
  
  await page.getByTestId('password-input').fill(password);
  await page.getByTestId('confirm-password-input').fill(password);
  
  // Click the "Set password" button
  await page.getByTestId('set-password-button').click();
  
  // Wait for redirect to login page
  await page.waitForURL(/.*\/login.*/);
}

async function login(page: Page) {
  const password = 'testpassword';
  
  // Wait for login page to load
  await expect(page.getByTestId('login-page')).toBeVisible();
  
  console.log('🔐 Filling in password and signing in...');
  // Fill password and click sign in  
  const passwordInput = page.getByTestId('password-input');
  await passwordInput.fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  
  // Wait for successful login and redirect - be more patient here
  console.log('⏳ Waiting for login to complete and redirect...');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(7000); // Increased wait time
  
  console.log(`📍 URL after login: ${page.url()}`);
  
  // Wait a bit more to ensure the app is fully loaded
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);
}

async function createBudgetFile(page: Page) {
  console.log('💰 Starting budget creation process...');
  
  // Look for "Start fresh" button first (this is the new budget option)
  const startFreshButton = page.getByRole('button', { name: 'Start fresh' });
  if (await startFreshButton.isVisible({ timeout: 2000 })) {
    console.log('📄 Found "Start fresh" button, creating new budget...');
    await startFreshButton.click();
  } else {
    // Look for file selection screen - might need to click "Don't use a server" first
    const dontUseServerButton = page.getByRole('button', { name: "Don't use a server" });
    if (await dontUseServerButton.isVisible({ timeout: 2000 })) {
      console.log('🚫 Clicking "Don\'t use a server"...');
      await dontUseServerButton.click();
      await page.waitForTimeout(1000);
      
      // Now look for "Start fresh" button
      const startFreshAfter = page.getByRole('button', { name: 'Start fresh' });
      if (await startFreshAfter.isVisible({ timeout: 2000 })) {
        console.log('📄 Found "Start fresh" button after server selection...');
        await startFreshAfter.click();
      }
    }
  }
  
  // Wait for the budget to be created and loaded
  console.log('⏳ Waiting for budget to load...');
  await expect(page.getByTestId('account-name')).toBeVisible({ timeout: 30000 });
  console.log('✅ Budget created and loaded successfully');
}

async function enablePluginFeatures(page: Page) {
  console.log('🔌 Enabling plugin features...');
  
  // Navigate to settings page directly
  await page.goto('/settings');
  await page.waitForLoadState('networkidle');
  
  // First, click "Show advanced settings" to reveal the advanced toggle section
  const showAdvancedButton = page.getByText('Show advanced settings');
  if (await showAdvancedButton.isVisible({ timeout: 5000 })) {
    console.log('📝 Found "Show advanced settings", clicking...');
    await showAdvancedButton.click();
    await page.waitForTimeout(1000);
    
         // Now look for the experimental features section which should be visible
     const experimentalButton = page.getByTestId('experimental-settings');
     if (await experimentalButton.isVisible({ timeout: 3000 })) {
       console.log('🧪 Found experimental features section, clicking...');
       await experimentalButton.click();
      await page.waitForTimeout(1000);
      
      // Enable Client-Side plugins toggle
      const pluginToggle = page.getByText('Client-Side plugins');
      if (await pluginToggle.isVisible({ timeout: 3000 })) {
        console.log('🔧 Found "Client-Side plugins" toggle, enabling...');
        await pluginToggle.click();
        await page.waitForTimeout(1000);
        console.log('✅ Client-Side plugins enabled');
      } else {
        console.log('❌ Client-Side plugins toggle not found');
      }
    } else {
      console.log('❌ Experimental features section not found after clicking advanced settings');
    }
  } else {
    console.log('❌ "Show advanced settings" button not found');
  }
  
  console.log('✅ Plugin features enabling attempt completed');
}

/**
 * Install a test plugin via the development plugin loader
 */
export async function installTestPlugin(page: Page) {
  console.log('🔌 Installing test plugin...');
  
  // Navigate directly to the plugins page
  await page.goto('/plugins');
  await page.waitForLoadState('networkidle');
  
  console.log(`📍 Current URL: ${page.url()}`);
  
  // Debug: Log what's actually on the plugins page
  const pageContent = await page.textContent('body');
  console.log('📄 Plugins page content preview:', pageContent?.substring(0, 300) + '...');
  
  // Check if we're redirected somewhere else
  const currentUrl = page.url();
  if (!currentUrl.includes('/plugins')) {
    console.log(`🔀 Redirected to: ${currentUrl}`);
    return;
  }
  console.log('✅ Plugins page loaded successfully');
  
  // Look for plugin development features - development plugin loader
  const devPluginInput = page.locator('input[value="http://localhost:2000/mf-manifest.json"]');
  if (await devPluginInput.isVisible({ timeout: 5000 })) {
    console.log('📝 Found dev plugin input, attempting to load plugin...');
    
    const loadPluginButton = page.getByRole('button', { name: 'Enable Dev Plugin' });
    if (await loadPluginButton.isVisible({ timeout: 2000 })) {
      console.log('🔌 Clicking "Enable Dev Plugin" button...');
      await loadPluginButton.click();
      
      // Wait for plugin to load and appear in the list
      await page.waitForTimeout(3000);
      
      console.log('✅ Plugin load attempt completed');
    } else {
      console.log('❌ Enable Dev Plugin button not found');
      
      // Debug: Look for any buttons on the page
      const allButtons = await page.locator('button').allTextContents();
      console.log('🔍 All buttons found on plugins page:', allButtons);
    }
  } else {
    console.log('❌ Development plugin input not found');
    
    // Debug: Look for any input fields on the page
    const allInputs = await page.locator('input').allTextContents();
    console.log('🔍 All inputs found on plugins page:', allInputs);
    
    // Check if there's any mention of experimental features or enabling plugins
    const experimentalText = page.getByText(/experimental|feature|enable/i);
    if (await experimentalText.first().isVisible({ timeout: 2000 })) {
      console.log('🧪 Found experimental features text, investigating...');
      const experimentalContent = await experimentalText.allTextContents();
      console.log('📋 Experimental content:', experimentalContent);
    }
  }
  
  console.log('✅ Test plugin installation attempt completed');
} 