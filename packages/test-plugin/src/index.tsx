import * as React from "react";
import {
  ActualPlugin,
  ActualPluginEntry,
  Button,
  initializePlugin,
  View,
} from "@actual-app/plugins-core";
import manifest from "./manifest";
import { ModalHelloWorld } from "./ModalHelloWorld";
import { ModalSchedules } from "./ModalSchedules";
import { ClickMeButton } from "./ClickMeButton";
import { migrations } from "./migrations";
import { sepiaVintageTheme } from "./theme";
import { DummyItemsDashboardWidget } from "./DashboardWidget";

let pluginContext: Parameters<ActualPlugin['activate']>[0];

const pluginEntry: ActualPluginEntry = () => {
  const plugin: ActualPlugin = {
    name: manifest.name,
    version: manifest.version,
    uninstall: () => {},
    migrations: () => migrations,
    activate: (context) => {
      pluginContext = context;

      // Add sepia themed style
      context.addTheme(
        'sepia-vintage',
        'Sepia Vintage',
        sepiaVintageTheme,
        {
          baseTheme: 'light',
          description: 'A warm, vintage sepia-toned theme that evokes the classic look of old photographs'
        }
      );

      // Register dashboard widget
      context.registerDashboardWidget(
        'dummy-items-summary',
        'Dummy Items Summary',
        <DummyItemsDashboardWidget context={pluginContext} />,
        {
          defaultWidth: 4,
          defaultHeight: 3,
          minWidth: 3,
          minHeight: 2
        }
      );

      // Seed initial data if db is available
      if (context.db) {
        seedDummyData(context.db);
      }

      context.on("categories", (data) => {
        console.log("From plugin", data);
      });
      context.registerRoute("/test", <View>Simple JSX 2</View>);
      context.registerMenu("before-accounts",
        <ClickMeButton context={pluginContext} />
      );
      context.registerMenu("after-accounts",
        <Button
          onPress={() => {
            context.pushModal(<ModalHelloWorld text="Database Demo" context={pluginContext} />);
          }}
          variant="primary"
        >
          Show Database Data
        </Button>
      );
      context.registerMenu("after-accounts",
        <Button
          onPress={() => {
            context.pushModal(<ModalSchedules context={pluginContext} />);
          }}
          variant="primary"
        >
          Show Schedules (AQL)
        </Button>
      );
      console.log("Dummy activated");
    },
  };

  return initializePlugin(plugin);
};

// Seed some initial data
async function seedDummyData(db: NonNullable<Parameters<ActualPlugin['activate']>[0]['db']>) {
  try {
    // Check if data already exists
    const existingData = await db.runQuery<{count: number}>('SELECT COUNT(*) as count FROM dummy_items', [], true) as {count: number}[];
    
    if (existingData && Array.isArray(existingData) && existingData[0]?.count === 0) {
      // Insert sample data
      await db.runQuery(
        'INSERT INTO dummy_items (name, description, value) VALUES (?, ?, ?)',
        ['Sample Item 1', 'This is the first dummy item', 29.99]
      );
      
      await db.runQuery(
        'INSERT INTO dummy_items (name, description, value) VALUES (?, ?, ?)',
        ['Sample Item 2', 'This is the second dummy item', 45.50]
      );
      
      await db.runQuery(
        'INSERT INTO dummy_items (name, description, value) VALUES (?, ?, ?)',
        ['Sample Item 3', 'This is the third dummy item', 12.75]
      );
      
      console.log('Dummy data seeded successfully');
    }
  } catch (error) {
    console.error('Error seeding dummy data:', error);
  }
}

export default pluginEntry;