# Actual Budget Plugin Development Guide

This guide covers all the plugin development capabilities and features available in Actual Budget's plugin system.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Plugin Structure](#plugin-structure)
3. [Core API Reference](#core-api-reference)
4. [UI Components](#ui-components)
5. [Database & Data Access](#database--data-access)
6. [Dashboard Widgets](#dashboard-widgets)
7. [Modals](#modals)
8. [Navigation & Routing](#navigation--routing)
9. [Sidebar Integration](#sidebar-integration)
10. [Theming](#theming)
11. [Spreadsheets & Reports](#spreadsheets--reports)
12. [Events & Lifecycle](#events--lifecycle)
13. [Migration System](#migration-system)
14. [Installation & Distribution](#installation--distribution)
15. [Best Practices](#best-practices)
16. [Examples](#examples)

## Getting Started

### Plugin Types

Actual Budget supports **client-side plugins** that run in the browser and can extend the user interface, add new features, and integrate with the app's data.

### Prerequisites

- Node.js 18+ 
- Basic knowledge of React and TypeScript
- Understanding of Actual Budget's data model

### Basic Plugin Structure

```typescript
import { ActualPlugin, initializePlugin } from '@actual-app/plugins-core';

const plugin: ActualPlugin = {
  name: 'My Plugin',
  version: '1.0.0',
  
  activate: (context) => {
    // Plugin initialization code
    console.log('Plugin activated!');
  },
  
  uninstall: () => {
    // Cleanup code when plugin is uninstalled
  },
};

export default initializePlugin(plugin);
```

## Plugin Structure

### Manifest File (`manifest.json`)

```json
{
  "url": "https://github.com/username/my-plugin",
  "name": "My Awesome Plugin",
  "version": "1.0.0",
  "description": "A plugin that does awesome things",
  "pluginType": "client",
  "minimumActualVersion": "24.1.0",
  "author": "Your Name"
}
```

### Plugin Entry Point

Your plugin must export a function that returns an `ActualPlugin` object:

```typescript
import { ActualPlugin } from '@actual-app/plugins-core';

export default function(): ActualPlugin {
  return {
    name: 'My Plugin',
    version: '1.0.0',
    
    // Optional: Define database migrations
    migrations: () => [
      [Date.now(), 'initial_setup', 'CREATE TABLE plugin_data (...)', 'DROP TABLE plugin_data']
    ],
    
    activate: (context) => {
      // Plugin logic here
    },
    
    uninstall: () => {
      // Cleanup logic
    }
  };
}
```

## Core API Reference

### Context Object

The `context` object provides access to all plugin capabilities:

```typescript
interface HostContext {
  // Navigation
  navigate: (routePath: string) => void;
  
  // Modals
  pushModal: (element: JSX.Element, modalProps?: BasicModalProps) => void;
  popModal: () => void;
  
  // Routing
  registerRoute: (path: string, element: JSX.Element) => string;
  unregisterRoute: (id: string) => void;
  
  // Sidebar
  registerMenu: (location: SidebarLocations, element: JSX.Element) => string;
  unregisterMenu: (id: string) => void;
  
  // Dashboard Widgets
  registerDashboardWidget: (
    widgetType: string,
    displayName: string,
    element: JSX.Element,
    options?: WidgetOptions
  ) => string;
  unregisterDashboardWidget: (id: string) => void;
  
  // Theming
  addTheme: (themeId: string, displayName: string, colors: ThemeColorOverrides, options?) => void;
  overrideTheme: (themeId: string, colors: ThemeColorOverrides) => void;
  
  // Data Access
  q: HostQueryBuilder; // Query builder for database access
  db: PluginDatabase; // Plugin-specific database
  createSpreadsheet: () => PluginSpreadsheet;
  makeFilters: (conditions: PluginFilterCondition[]) => Promise<PluginFilterResult>;
  
  // Events
  on: <K extends keyof ContextEvent>(
    eventType: K, 
    callback: (data: ContextEvent[K]) => void
  ) => void;
}
```

### Sidebar Locations

```typescript
type SidebarLocations = 
  | 'main-menu'     // Main navigation area
  | 'more-menu'     // "More" submenu
  | 'before-accounts' // Above accounts list
  | 'after-accounts'  // Below accounts list  
  | 'topbar';       // Top navigation bar
```

## UI Components

### Available Components

All Actual Budget UI components are available through `@actual-app/plugins-core`:

```typescript
import {
  Button,
  Card,
  Text,
  View,
  Input,
  Select,
  Stack,
  Popover,
  Menu,
  // ... and many more
} from '@actual-app/plugins-core';
```

### Component Examples

```tsx
import { Card, Text, Button, Stack } from '@actual-app/plugins-core';

function MyPluginComponent() {
  return (
    <Card>
      <Stack spacing={2}>
        <Text style={{ fontSize: 18, fontWeight: 'bold' }}>
          My Plugin Widget
        </Text>
        <Button onPress={() => console.log('Clicked!')}>
          Click Me
        </Button>
      </Stack>
    </Card>
  );
}
```

## Database & Data Access

### Plugin Database

Each plugin gets its own isolated database:

```typescript
// In your activate function
activate: async (context) => {
  const { db } = context;
  
  // Create tables
  await db.runQuery(`
    CREATE TABLE IF NOT EXISTS my_plugin_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      value TEXT
    )
  `);
  
  // Insert data
  await db.runQuery(
    'INSERT INTO my_plugin_data (name, value) VALUES (?, ?)',
    ['setting1', 'value1']
  );
  
  // Query data
  const results = await db.runQuery('SELECT * FROM my_plugin_data');
  console.log(results);
}
```

### Accessing Main App Data

Use the query builder to access Actual Budget's main database:

```typescript
activate: async (context) => {
  const { q } = context;
  
  // Get all accounts
  const accounts = await q('accounts').select('*');
  
  // Get transactions from last month
  const transactions = await q('transactions')
    .filter({ date: { $gte: '2024-01-01' } })
    .select(['id', 'account', 'amount', 'payee']);
    
  // Complex queries
  const spending = await q('transactions')
    .filter({ 
      amount: { $lt: 0 },
      date: { $gte: '2024-01-01', $lte: '2024-01-31' }
    })
    .calculate({ $sum: '$amount' });
}
```

### AQL (Actual Query Language)

For more advanced queries, use AQL:

```typescript
// Plugin database query
const result = await db.aql(
  q('my_plugin_data').filter({ active: true }),
  { target: 'plugin' }
);

// Main app database query  
const result = await db.aql(
  q('transactions').filter({ amount: { $lt: 0 }}).calculate({ $sum: '$amount' }),
  { target: 'host' }
);
```

## Dashboard Widgets

Create custom dashboard widgets that users can add to their dashboard:

```typescript
import { Card, Text, useReport } from '@actual-app/plugins-core';

function MyDashboardWidget() {
  const spreadsheet = useContext(SpreadsheetContext); // From plugin context
  
  const data = useReport('my-widget', async (spreadsheet, setData) => {
    // Calculate your widget data
    const result = await spreadsheet.createQuery('expenses', 'total-expenses', 
      q('transactions').filter({ amount: { $lt: 0 } }).calculate({ $sum: '$amount' })
    );
    setData(result);
  }, spreadsheet);

  return (
    <Card>
      <Text>Total Expenses: ${data?.value || 0}</Text>
    </Card>
  );
}

// Register the widget
activate: (context) => {
  context.registerDashboardWidget(
    'expense-summary',
    'Expense Summary',
    <MyDashboardWidget />,
    {
      defaultWidth: 4,
      defaultHeight: 2,
      minWidth: 2,
      minHeight: 1
    }
  );
}
```

### Widget Options

```typescript
interface WidgetOptions {
  defaultWidth?: number;  // Grid units (1-12)
  defaultHeight?: number; // Grid units  
  minWidth?: number;      // Minimum width
  minHeight?: number;     // Minimum height
}
```

## Modals

Create custom modal dialogs:

```typescript
import { ModalTitle, ModalButtons, Button } from '@actual-app/plugins-core';

function MyModal() {
  return (
    <div>
      <ModalTitle title="My Plugin Modal" />
      <div style={{ padding: 20 }}>
        <Text>Modal content goes here</Text>
      </div>
      <ModalButtons>
        <Button onPress={() => context.popModal()}>
          Close
        </Button>
      </ModalButtons>
    </div>
  );
}

// Show the modal
context.pushModal(<MyModal />, {
  title: 'My Plugin',
  size: { width: 400, height: 300 }
});
```

### Modal Components

- `ModalTitle` - Styled modal title
- `ModalHeader` - Header with logo and navigation
- `ModalButtons` - Button container with proper spacing
- `ModalCloseButton` - Standard close button

## Navigation & Routing

### Register Custom Routes

```typescript
activate: (context) => {
  // Register a new route
  const routeId = context.registerRoute('/my-plugin', <MyPluginPage />);
  
  // Navigate to your route
  context.navigate('/my-plugin');
  
  // Cleanup on uninstall
  return () => {
    context.unregisterRoute(routeId);
  };
}
```

### Route Component Example

```tsx
function MyPluginPage() {
  return (
    <div style={{ padding: 20 }}>
      <h1>My Plugin Page</h1>
      <p>This is a custom page added by my plugin!</p>
    </div>
  );
}
```

## Sidebar Integration

Add custom menu items to various sidebar locations:

```typescript
activate: (context) => {
  // Add to main menu
  const menuId = context.registerMenu(
    'main-menu',
    <Button onPress={() => context.navigate('/my-plugin')}>
      My Plugin
    </Button>
  );
  
  // Add to more menu
  context.registerMenu(
    'more-menu', 
    <MenuButton text="Plugin Settings" onPress={() => openSettings()} />
  );
  
  // Cleanup
  return () => {
    context.unregisterMenu(menuId);
  };
}
```

## Theming

### Create Custom Themes

```typescript
activate: (context) => {
  // Add a new theme
  context.addTheme('my-dark-theme', 'My Dark Theme', {
    pageBackground: '#1a1a1a',
    pageText: '#ffffff',
    cardBackground: '#2d2d2d',
    buttonPrimaryBackground: '#007acc',
    // ... more color overrides
  }, {
    baseTheme: 'dark',
    description: 'A custom dark theme'
  });
}
```

### Override Existing Themes

```typescript
// Modify existing theme colors
context.overrideTheme('light', {
  buttonPrimaryBackground: '#ff6b6b',
  buttonPrimaryBackgroundHover: '#ff5252'
});
```

### Available Theme Colors

The `ThemeColorOverrides` type includes 200+ customizable colors covering:

- Page colors (`pageBackground`, `pageText`, etc.)
- Card colors (`cardBackground`, `cardBorder`, etc.)  
- Button colors (`buttonPrimaryBackground`, etc.)
- Table colors (`tableBackground`, `tableText`, etc.)
- Sidebar colors (`sidebarBackground`, etc.)
- Menu colors (`menuBackground`, `menuItemText`, etc.)
- Form colors (`formInputBackground`, etc.)
- Status colors (`errorBackground`, `warningText`, etc.)
- Custom colors (`custom-myColor`: '#ffffff')

## Spreadsheets & Reports

### Using Spreadsheets for Data

```typescript
import { useReport } from '@actual-app/plugins-core';

function DataDrivenWidget() {
  const spreadsheet = context.createSpreadsheet();
  
  const data = useReport('my-report', async (spreadsheet, setData) => {
    // Create queries
    await spreadsheet.createQuery('expenses', 'monthly-expenses',
      q('transactions')
        .filter({ 
          amount: { $lt: 0 },
          date: { $gte: startOfMonth, $lte: endOfMonth }
        })
        .groupBy('category')
        .select(['category', { amount: { $sum: '$amount' } }])
    );
    
    // Get results
    const results = await spreadsheet.get('expenses', 'monthly-expenses');
    setData(results);
  }, spreadsheet);
  
  return (
    <div>
      {data?.map(item => (
        <div key={item.category}>
          {item.category}: ${Math.abs(item.amount)}
        </div>
      ))}
    </div>
  );
}
```

### Filter Utilities

```typescript
// Create filters from conditions
const conditions: PluginFilterCondition[] = [
  { field: 'amount', op: 'lt', value: 0 },
  { field: 'date', op: 'gte', value: '2024-01-01' }
];

const filterResult = await context.makeFilters(conditions);
// Use filterResult.filters in your queries
```

## Events & Lifecycle

### Available Events

```typescript
activate: (context) => {
  // Listen for data changes
  context.on('accounts', (data) => {
    console.log('Accounts updated:', data.accounts);
  });
  
  context.on('categories', (data) => {
    console.log('Categories updated:', data.categories, data.groups);
  });
  
  context.on('payees', (data) => {
    console.log('Payees updated:', data.payees);
  });
}
```

### Plugin Lifecycle

```typescript
export default function(): ActualPlugin {
  return {
    name: 'My Plugin',
    version: '1.0.0',
    
    // Called when plugin is activated
    activate: (context) => {
      console.log('Plugin starting up');
      
      // Return cleanup function
      return () => {
        console.log('Plugin cleaning up');
      };
    },
    
    // Called when plugin is uninstalled
    uninstall: () => {
      console.log('Plugin being uninstalled');
    }
  };
}
```

## Migration System

Define database migrations for your plugin:

```typescript
export default function(): ActualPlugin {
  return {
    name: 'My Plugin',
    version: '1.0.0',
    
    migrations: () => [
      // [timestamp, name, up_command, down_command]
      [
        1640000000000,
        'create_initial_tables',
        `CREATE TABLE plugin_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT UNIQUE NOT NULL,
          value TEXT
        )`,
        'DROP TABLE plugin_settings'
      ],
      [
        1640000001000,
        'add_user_preferences',
        `CREATE TABLE user_preferences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          preferences TEXT
        )`,
        'DROP TABLE user_preferences'
      ]
    ],
    
    activate: async (context) => {
      // Migrations run automatically before activate is called
      console.log('Plugin activated with migrated database');
    }
  };
}
```

## Installation & Distribution

### GitHub Distribution

1. Create a GitHub repository for your plugin
2. Add a `manifest.json` file in the root
3. Build and package your plugin
4. Create releases with plugin assets
5. Users can install via the Plugin Manager using your GitHub URL

### Manual Installation

Users can also upload plugin ZIP files directly through the Plugin Manager.

### Plugin Package Structure

```
my-plugin/
├── manifest.json
├── index.js (built plugin code)
├── package.json
├── README.md
└── src/
    ├── index.tsx
    └── components/
```

## Best Practices

### 1. Error Handling

```typescript
activate: (context) => {
  try {
    // Plugin initialization
  } catch (error) {
    console.error('Plugin failed to initialize:', error);
    // Graceful degradation
  }
}
```

### 2. Resource Cleanup

```typescript
activate: (context) => {
  const registrations = [];
  
  // Register features
  registrations.push(context.registerRoute(...));
  registrations.push(context.registerMenu(...));
  
  // Return cleanup function
  return () => {
    registrations.forEach(id => {
      // Cleanup registrations
    });
  };
}
```

### 3. Performance

- Use `useReport` for data that needs periodic updates
- Avoid heavy computations in render methods
- Implement proper memoization for expensive operations

### 4. User Experience

- Provide clear error messages
- Use consistent styling with Actual Budget's design
- Make features discoverable through proper menu placement

### 5. Data Safety

- Always validate user inputs
- Use transactions for database operations
- Handle edge cases gracefully

## Examples

### Simple Dashboard Widget

```tsx
import { Card, Text, Button } from '@actual-app/plugins-core';

function ExpenseTracker() {
  const [total, setTotal] = useState(0);
  
  useEffect(() => {
    // Calculate expense total
    context.q('transactions')
      .filter({ amount: { $lt: 0 } })
      .calculate({ $sum: '$amount' })
      .then(result => setTotal(Math.abs(result)));
  }, []);
  
  return (
    <Card>
      <Text style={{ fontSize: 24, fontWeight: 'bold' }}>
        Total Expenses: ${total}
      </Text>
    </Card>
  );
}

// Registration
activate: (context) => {
  context.registerDashboardWidget(
    'expense-tracker',
    'Expense Tracker',
    <ExpenseTracker />,
    { defaultWidth: 4, defaultHeight: 2 }
  );
}
```

### Settings Modal

```tsx
import { ModalTitle, ModalButtons, Button, Input, Stack } from '@actual-app/plugins-core';

function SettingsModal() {
  const [apiKey, setApiKey] = useState('');
  
  const handleSave = async () => {
    await context.db.runQuery(
      'INSERT OR REPLACE INTO plugin_settings (key, value) VALUES (?, ?)',
      ['api_key', apiKey]
    );
    context.popModal();
  };
  
  return (
    <div>
      <ModalTitle title="Plugin Settings" />
      <Stack spacing={3} style={{ padding: 20 }}>
        <Input
          placeholder="API Key"
          value={apiKey}
          onChange={setApiKey}
        />
      </Stack>
      <ModalButtons>
        <Button onPress={() => context.popModal()}>Cancel</Button>
        <Button variant="primary" onPress={handleSave}>Save</Button>
      </ModalButtons>
    </div>
  );
}
```

### Custom Theme

```typescript
activate: (context) => {
  context.addTheme('ocean-blue', 'Ocean Blue', {
    pageBackground: '#f0f8ff',
    pageText: '#2c3e50',
    cardBackground: '#ffffff',
    buttonPrimaryBackground: '#3498db',
    buttonPrimaryBackgroundHover: '#2980b9',
    sidebarBackground: '#34495e',
    sidebarItemText: '#ecf0f1',
  }, {
    baseTheme: 'light',
    description: 'A calming ocean-inspired theme'
  });
}
```

---

This guide covers the comprehensive plugin system added to Actual Budget. The plugin architecture provides extensive capabilities for extending the application with custom functionality, UI components, data access, and integration points. 