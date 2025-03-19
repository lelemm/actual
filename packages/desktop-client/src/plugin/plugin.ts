import { init, loadRemote } from '@module-federation/enhanced/runtime';
import { ActualPluginStored } from 'loot-core/types/models/actual-plugin-stored';


export var loadedPlugins: Map<string, any> = new Map();

export async function loadPluginsScript(plugins: ActualPluginStored[]) {
  debugger;
  init({
    name: '@actual/host-app',
    remotes: plugins.map(plugin => ({
      name: plugin.name,
      alias: plugin.name,
      entry: plugin.url,
    })),
    shared: {
        react: {
            strategy: 'loaded-first',
          }
    }
  });

  for (let plugin of plugins) {
    loadedPlugins.set(plugin.name, await loadRemote(plugin.name));
  }
}