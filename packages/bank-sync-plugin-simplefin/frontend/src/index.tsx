import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';

import { initializePlugin } from '@actual-app/plugins-core/middleware';
import type {
  ActualPlugin,
  PluginContext,
} from '@actual-app/plugins-core/types/actualPlugin';
import type { ActualPluginEntry } from '@actual-app/plugins-core/types/actualPluginEntry';

import { manifest } from '#manifest';

import { SimpleFinSetup } from './SimpleFinSetup';

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

      console.debug('[simplefin-plugin] registering bank-sync setup UI', {
        providerSlug: manifest.name,
      });

      return context.registerBankSyncProviderSetup(
        manifest.name,
        props => {
          console.debug('[simplefin-plugin] rendering setup UI', {
            providerSlug: props.providerSlug,
          });

          return (
            <I18nWrapper>
              <SimpleFinSetup {...props} />
            </I18nWrapper>
          );
        },
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
