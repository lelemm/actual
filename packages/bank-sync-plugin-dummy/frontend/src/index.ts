import { initializePlugin } from '@actual-app/plugins-core/middleware';
import type { ActualPlugin } from '@actual-app/plugins-core/types/actualPlugin';
import type { ActualPluginEntry } from '@actual-app/plugins-core/types/actualPluginEntry';

import { manifest } from '../../src/manifest';

export const plugin: ActualPluginEntry = () => {
  const actualPlugin: ActualPlugin = {
    name: manifest.name,
    version: manifest.version,
    activate() {
      // The first desktop-runtime PR only proves that frontend plugin code can load.
    },
  };

  return initializePlugin(actualPlugin);
};
