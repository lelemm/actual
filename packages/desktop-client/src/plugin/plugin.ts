import { init, loadRemote } from '@module-federation/enhanced/runtime';

type PluginDeclaration = {
  name: string;
  url?: string;
};

export var loadedPlugins: Map<string, any> = new Map();

export async function loadPluginsScript(plugins: PluginDeclaration[]) {
  init({
    name: '@actual/host-app',
    remotes: plugins.map(plugin => ({
      name: plugin.name,
      alias: plugin.name,
      entry: plugin.url,
    })),
  });

  for (let plugin of plugins) {
    loadedPlugins.set(plugin.name, await loadRemote(plugin.name));
  }
}
