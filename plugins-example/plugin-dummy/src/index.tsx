import { ActualPlugin, ActualPluginEntry, initializePlugin, View } from '@actual-app/plugins-core';
import manifest from './manifest';

const pluginEntry: ActualPluginEntry = () => {
    const plugin: ActualPlugin = {
      name: manifest.name,
      version: manifest.version,
      uninstall: () => {},
      hooks: {
        components: {
          ComponentTest: () => <View>test</View>
        }
      },
    };
  
    return initializePlugin(plugin);
  };
  export default pluginEntry;