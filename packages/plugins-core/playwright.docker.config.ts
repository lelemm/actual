import { defineConfig, devices } from '@playwright/test';

/**
 * Docker-specific Playwright configuration
 * Assumes servers are running on the host and accessible via network host mode
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests',
  
  /* Run tests in files in parallel */
  fullyParallel: false, // Keep tests sequential since they share plugin state
  
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  
  /* Force sequential execution - critical for plugin tests that share state */
  workers: 1,
  
  /* Reporter to use - list reporter for better Docker output */
  reporter: [
    ['list'], // Better for CI/Docker environments
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results.json' }]
  ],
  
  /* No global setup/teardown - servers are managed by host */
  // globalSetup and globalTeardown are omitted since servers run on host
  
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: process.env.E2E_START_URL || 'http://localhost:3001', // Actual Budget app URL (fallback to 3001)
    
    /* Collect trace for all tests. See https://playwright.dev/docs/trace-viewer */
    trace: 'on',
    
    /* Take screenshot on failure */
    screenshot: 'only-on-failure',
    
    /* Record video on failure */
    video: 'retain-on-failure',
    
    /* Longer timeout for Docker environment */
    actionTimeout: 30000,
    navigationTimeout: 30000,
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { 
        ...devices['Desktop Chrome'],
        // Capture console logs and include them in test results
        launchOptions: {
          args: ['--disable-web-security', '--disable-features=VizDisplayCompositor']
        }
      },
    },

    // Only run Chromium in Docker for consistency and speed
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },

    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],

  /* Timeout for the entire test run */
  globalTimeout: 5 * 60 * 1000, // 5 minutes

  /* Timeout for each test */
  timeout: 2 * 60 * 1000, // 2 minutes per test
}); 