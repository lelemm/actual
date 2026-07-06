import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { initializePlugin } from '@actual-app/plugins-core/middleware';
import type {
  ActualPlugin,
  BankSyncProviderExternalAccount,
  BankSyncProviderLinkRenderProps,
} from '@actual-app/plugins-core/types/actualPlugin';
import type { ActualPluginEntry } from '@actual-app/plugins-core/types/actualPluginEntry';

import { manifest } from '#manifest';

const BANK_ID = 'dummy-bank';

type AccountsResponse = {
  data?: {
    accounts?: BankSyncProviderExternalAccount[];
  };
};

let unregisterLink: (() => void) | undefined;

function isAccountsResponse(result: unknown): result is AccountsResponse {
  return typeof result === 'object' && result != null && 'data' in result;
}

function DummyBankLink(props: BankSyncProviderLinkRenderProps) {
  const [isLoading, setIsLoading] = useState(false);
  const { t } = useTranslation();

  async function loadAccounts() {
    try {
      setIsLoading(true);
      const result = await props.callProvider({
        path: 'accounts',
        body: {},
      });
      const accounts =
        isAccountsResponse(result) && Array.isArray(result.data?.accounts)
          ? result.data.accounts
          : [];

      props.selectExternalAccounts({
        externalAccounts: accounts,
        bankId: BANK_ID,
      });
    } catch (error) {
      props.onError(error);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 20,
      }}
    >
      <p style={{ margin: 0 }}>
        Load deterministic dummy accounts from the plugin.
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button disabled={isLoading} onClick={props.close} type="button">
          <Trans>Cancel</Trans>
        </button>
        <button disabled={isLoading} onClick={loadAccounts} type="button">
          {isLoading ? 'Loading...' : t('Load accounts')}
        </button>
      </div>
    </div>
  );
}

export const plugin: ActualPluginEntry = () => {
  const actualPlugin: ActualPlugin = {
    name: manifest.name,
    version: manifest.version,
    activate(context) {
      unregisterLink = context.registerBankSyncProviderLink(
        manifest.name,
        props => <DummyBankLink {...props} />,
        { title: 'Dummy Bank' },
      );
    },
    deactivate() {
      unregisterLink?.();
      unregisterLink = undefined;
    },
  };

  return initializePlugin(actualPlugin);
};
