import path from 'path';

import { config } from '#load-config';

import { createPluginManager } from './plugin-manager.js';
import { arePluginsEnabled } from './server-prefs.js';

const pluginsDir = path.join(config.get('serverFiles'), 'plugins');
const pluginManager = createPluginManager(pluginsDir);

async function bootstrapPlugins(): Promise<void> {
  try {
    if (!arePluginsEnabled()) {
      console.log('Plugins are disabled. Skipping plugin loading.');
      return;
    }

    await pluginManager.loadPlugins();
    const loadedPlugins = pluginManager.getInstalledPluginManifests();
    console.log(`Loaded ${loadedPlugins.length} plugin(s):`, loadedPlugins);
  } catch (error) {
    console.error('Error loading plugins:', error);
  }
}

async function shutdownPlugins(): Promise<void> {
  try {
    await pluginManager.shutdown();
    console.log('Plugins shut down successfully');
  } catch (error) {
    console.error('Error shutting down plugins:', error);
  }
}

export { bootstrapPlugins, shutdownPlugins, pluginManager };
