# @actual-app/plugins-core

This package provides the core functionality and types for Actual Budget plugins. It includes React components, TypeScript interfaces, middleware functions, and utilities that plugins can use to extend the Actual Budget application.

## Features

- **Plugin API Types**: Complete TypeScript interfaces for plugin development
- **UI Components**: Pre-built React components matching Actual Budget's design
- **Query Builder**: Type-safe database query utilities
- **Modal Components**: Ready-to-use modal dialog components
- **Middleware**: Plugin initialization and JSX element handling
- **Theme Support**: Custom theme creation and overrides
- **Spreadsheet Utilities**: Data processing hooks for dashboard widgets

## Development

### Testing

The plugin system includes comprehensive test coverage with both unit tests and integration tests.

### Running Tests

#### Unit Tests (Vitest)
```bash
# Run unit tests once
yarn test

# Run unit tests in watch mode  
yarn test:watch
```

#### Integration Tests (Playwright)
```bash
# Run integration tests
yarn test:integration

# Run all tests (unit + integration)
yarn test:all
```

### Integration Test Setup

The integration tests use Playwright to test the complete plugin system including:
- Plugin installation via module federation
- Dashboard widget registration and interaction
- Database CRUD operations
- Modal components and user interactions
- Theme registration
- Custom route handling
- Plugin uninstallation

#### Prerequisites for Integration Tests

1. **Install plugins-core dependencies:**
   ```bash
   # In packages/plugins-core directory
   yarn install
   ```

That's it! The test runner automatically handles:
- ✅ Starting Actual Budget application (`yarn start:server-dev`)
- ✅ Installing plugin dev server dependencies
- ✅ Building and serving the test plugin
- ✅ Running all integration tests
- ✅ Cleaning up and stopping all servers

No manual setup required!

#### Test Plugin Structure

The integration tests use a comprehensive test plugin located at `tests/fixtures/test-plugin.tsx` that demonstrates all plugin capabilities:

- **Dashboard Widget**: Shows test data with statistics
- **Database Operations**: CRUD operations with SQLite
- **Modal Interface**: Form for adding/editing test items  
- **Menu Integration**: Test menu button in the UI
- **Custom Routes**: Test route at `/test-route`
- **Theme Registration**: Custom test theme
- **Migrations**: Database schema migrations
- **Event Handling**: Listens to app events

#### Plugin Development Server

The integration tests automatically manage a plugin development server that:
1. Auto-installs test server dependencies if needed (npm)
2. Builds the test plugin using webpack and module federation
3. Serves it at `http://localhost:2000` with proper manifest
4. Makes it available for the Actual Budget app to load as a dev plugin
5. Automatically shuts down after tests complete

The server serves:
- `/mf-manifest.json` - Module federation manifest
- `/remoteEntry.js` - Plugin entry point
- Static assets and source maps

#### Integration Test Flow

1. **Server Check**: Verify plugin dev server is running
2. **Plugin Installation**: Use the "Enable Dev Plugin" feature in Actual Budget to load the test plugin via module federation
3. **Feature Testing**: Test all plugin features (widgets, modals, database, etc.)
4. **Cleanup**: Uninstall plugin and reset state

Example test:
```typescript
test('should perform database CRUD operations', async ({ page }) => {
  await installTestPlugin(page);
  
  await page.goto('/');
  
  // Open test modal
  await page.getByTestId('test-menu-button').click();
  const testModal = page.getByTestId('test-modal');
  await expect(testModal).toBeVisible();
  
  // Add new item
  await page.getByTestId('test-item-name').fill('Test Item');
  await page.getByTestId('test-item-value').fill('99.99');
  await page.getByTestId('add-test-item').click();
  
  // Verify item was added
  await expect(testModal).toContainText('Test Item');
  await expect(testModal).toContainText('$99.99');
});
```

### Test Architecture

**Unit Tests** (`tests/unit/`):
- Test individual components and utilities
- Mock external dependencies
- Fast execution, no external services required

**Integration Tests** (`tests/plugin-integration.spec.ts`):
- Test complete plugin workflows
- Use real module federation loading
- Interact with actual database operations
- Test UI integration points

**Test Plugin** (`tests/fixtures/test-plugin.tsx`):
- Comprehensive reference implementation
- Demonstrates all plugin API features
- Based on the dummy plugin structure
- Used as test subject for integration tests

This architecture ensures that both individual components and the complete plugin system are thoroughly tested, providing confidence that plugins will work correctly in the real Actual Budget environment.

### Building

```bash
npm run build
```

#### Running Integration Tests

##### Local Development

Run the plugin integration tests with:

```bash
# In packages/plugins-core directory
yarn test:e2e

# Or to run tests with UI for debugging
yarn test:e2e:ui

# Debug mode (step through tests)
yarn test:e2e:debug
```

##### Docker-based Testing (Recommended for CI/Stable Results)

For consistent, reproducible test results, use the Docker-based approach that runs everything inside a container:

```bash
# From the root directory - runs services and tests inside Docker
yarn test:plugin-e2e:docker

# With additional Playwright arguments
yarn test:plugin-e2e:docker --headed --debug
```

**Benefits of Docker testing:**
- ✅ Consistent test environment across different machines  
- ✅ Better Playwright output visibility in CI/terminal
- ✅ Isolated browser environment  
- ✅ Matches CI testing conditions exactly
- ✅ No interference from local browser state/extensions
- ✅ All services and tests run in the same container
- ✅ Automatic cleanup of services after tests

The Docker approach starts both the main Actual Budget app and the test plugin server inside the Docker container, then runs the Playwright tests in the same environment. This ensures complete isolation and consistency.

##### Manual Testing Setup

If you need to run tests against external services:

```bash
# Start services manually
yarn start:server-dev &  # Main app on port 3000
yarn workspace @actual-app/test-plugin start &  # Test plugin on port 2000

# Then run tests (local or Docker)
yarn workspace @actual-app/plugins-core test:e2e
# OR
yarn test:plugin-e2e:docker --e2e-start-url http://localhost:3000
```

Tests include:
- Plugin installation via the UI
- Plugin functionality verification  
- Plugin uninstallation and cleanup