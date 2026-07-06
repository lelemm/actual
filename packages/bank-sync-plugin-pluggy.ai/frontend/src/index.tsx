import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';

import { initializePlugin } from '@actual-app/plugins-core/middleware';
import type {
  ActualPlugin,
  PluginContext,
} from '@actual-app/plugins-core/types/actualPlugin';
import type { ActualPluginEntry } from '@actual-app/plugins-core/types/actualPluginEntry';

import { manifest } from '#manifest';

import { PluggyAiSetup } from './PluggyAiSetup';

export const plugin: ActualPluginEntry = () => {
  const actualPlugin: ActualPlugin = {
    name: manifest.name,
    version: manifest.version,
    install() {
      // No installation work is needed for this MVP plugin.
    },
    uninstall() {
      // No uninstall work is needed for this MVP plugin.
    },
    activate(context: PluginContext) {
      const I18nWrapper = ({ children }: { children: ReactNode }) => (
        <I18nextProvider i18n={context.i18nInstance}>
          {children}
        </I18nextProvider>
      );

      return context.registerBankSyncProviderSetup(
        manifest.name,
        props => (
          <I18nWrapper>
            <PluggyAiSetup {...props} />
          </I18nWrapper>
        ),
        {
          containerProps: {
            style: { width: 300 },
          },
        },
      );
    },
    deactivate() {
      // No deactivation work is needed beyond unregistering during activation cleanup.
    },
  };

  return initializePlugin(actualPlugin);
};
