import * as React from "react";
import {
  ActualPlugin,
  ActualPluginEntry,
  Button,
  initializePlugin,
  View,
  ModalHeader,
  Text,
  Input,
  Menu,
} from "@actual-app/plugins-core";
import manifest from "./manifest";

// Test Modal Component for e2e testing
const TestModal = ({ onClose, context }: { onClose: () => void; context: any }) => {
  const [testValue, setTestValue] = React.useState("");
  const [dbResult, setDbResult] = React.useState<string>("");

  const testDatabaseOperation = async () => {
    if (context.db) {
      try {
        const result = await context.db.runQuery('SELECT name FROM sqlite_master WHERE type="table"', [], true);
        setDbResult(`Found ${Array.isArray(result) ? result.length : 0} tables`);
      } catch (error) {
        setDbResult(`Error: ${error.message}`);
      }
    } else {
      setDbResult("Database not available");
    }
  };

  return (
    <>
      <ModalHeader title="Test Plugin E2E Modal" />
      <View style={{ padding: 20, gap: 15 }}>
        <Text>This modal is for e2e testing the plugins-core functionality.</Text>
        
        <View data-testid="test-input-section">
          <Text>Test Input:</Text>
          <Input
            data-testid="test-input"
            value={testValue}
            onChange={(e) => setTestValue(e.target.value)}
            placeholder="Enter test value"
          />
          <Text data-testid="test-input-display">Current value: {testValue}</Text>
        </View>

        <View data-testid="test-database-section">
          <Button
            data-testid="test-db-button"
            onPress={testDatabaseOperation}
            variant="primary"
          >
            Test Database Operation
          </Button>
          {dbResult && <Text data-testid="db-result">{dbResult}</Text>}
        </View>

        <View data-testid="test-navigation-section">
          <Button
            data-testid="test-route-button"
            onPress={() => {
              context.navigate('/test-route');
              onClose();
            }}
            variant="normal"
          >
            Test Navigation
          </Button>
        </View>

        <View data-testid="test-close-section">
          <Button
            data-testid="close-modal-button"
            onPress={onClose}
            variant="bare"
          >
            Close Modal
          </Button>
        </View>
      </View>
    </>
  );
};

// Test Route Component
const TestRoute = ({ context }: { context: any }) => {
  const [routeData, setRouteData] = React.useState("Route loaded successfully");

  return (
    <View data-testid="test-route-container" style={{ padding: 20 }}>
      <Text data-testid="test-route-title">Test Route Page</Text>
      <Text data-testid="test-route-data">{routeData}</Text>
      <Button
        data-testid="back-to-main-button"
        onPress={() => context.navigate('/')}
        variant="primary"
      >
        Back to Main
      </Button>
    </View>
  );
};

const pluginEntry: ActualPluginEntry = () => {
  let pluginContext: any;

  const plugin: ActualPlugin = {
    name: manifest.name,
    version: manifest.version,
    uninstall: () => {
      console.log("Test plugin uninstalled");
    },
    activate: (context) => {
      pluginContext = context;
      console.log("Test plugin activated for e2e testing");
      
      // Register test route for navigation testing
      context.registerRoute("/test-route", <TestRoute context={pluginContext} />);
      
      // Register test menu items for different sections
      context.registerMenu("before-accounts",
        <Button
          data-testid="test-plugin-modal-button"
          onPress={() => {
            context.pushModal(<TestModal onClose={() => context.popModal()} context={pluginContext} />);
          }}
          variant="primary"
        >
          Open Test Modal
        </Button>
      );

      context.registerMenu("after-accounts",
        <Button
          data-testid="test-plugin-route-button"
          onPress={() => {
            context.navigate('/test-route');
          }}
          variant="normal"
        >
          Go to Test Route
        </Button>
      );

      // Register test menu for categories section
      context.registerMenu("categories",
        <Menu 
          data-testid="test-plugin-menu"
          onMenuSelect={(item) => console.log("Test plugin menu item selected:", item)}
          items={[
            {
              name: "Test Action 1",
              text: "Test Action 1",
            },
            {
              name: "Test Action 2", 
              text: "Test Action 2",
            }
          ]}
        />
      );

      // Test event listeners
      context.on("categories", (data) => {
        console.log("Test plugin received categories event:", data);
      });

      context.on("accounts", (data) => {
        console.log("Test plugin received accounts event:", data);
      });

      // Test theme registration
      context.addTheme(
        'test-theme',
        'Test E2E Theme',
        {
          colors: {
            primary: '#007acc',
            secondary: '#ff6b35',
            background: '#f8f9fa',
            text: '#212529'
          }
        },
        {
          baseTheme: 'light',
          description: 'Theme for e2e testing'
        }
      );

      // Test dashboard widget if available
      if (context.registerDashboardWidget) {
        context.registerDashboardWidget(
          'test-widget',
          'Test E2E Widget',
          <View data-testid="test-dashboard-widget" style={{ padding: 10 }}>
            <Text>Test Widget for E2E</Text>
            <Button
              data-testid="test-widget-button"
              onPress={() => console.log("Test widget button clicked")}
              variant="primary"
            >
              Widget Action
            </Button>
          </View>,
          {
            defaultWidth: 3,
            defaultHeight: 2,
            minWidth: 2,
            minHeight: 1
          }
        );
      }
    },
  };

  return initializePlugin(plugin);
};

export default pluginEntry; 