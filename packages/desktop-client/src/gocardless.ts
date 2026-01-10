import { send } from 'loot-core/platform/client/fetch';
import { type GoCardlessToken } from 'loot-core/types/models';

import { pushModal } from './modals/modalsSlice';
import { type AppDispatch } from './redux/store';

function normalizeGoCardlessAccountsForPlugin(
  accounts: GoCardlessToken['accounts'],
) {
  return accounts.map(account => ({
    ...account,
    institution:
      typeof account.institution === 'string'
        ? account.institution
        : account.institution?.name ?? '',
  }));
}

function _authorize(
  dispatch: AppDispatch,
  {
    onSuccess,
    onClose,
    fileId,
    syncScope,
  }: {
    onSuccess: (data: GoCardlessToken) => Promise<void>;
    onClose?: () => void;
    fileId?: string;
    syncScope?: 'global' | 'file';
  },
) {
  const GOCARDLESS_PLUGIN_SLUG = 'gocardless-bank-sync';

  dispatch(
    pushModal({
      modal: {
        name: 'gocardless-external-msg',
        options: {
          onMoveExternal: async ({ institutionId }) => {
            // Create web token via plugin
            const createTokenResp = await send('bank-sync-plugin-call', {
              providerSlug: GOCARDLESS_PLUGIN_SLUG,
              path: 'create-web-token',
              method: 'POST',
              body: {
                institutionId,
                accessValidForDays: 90,
                host: window.location.origin,
              },
              ...(fileId ? { fileId } : {}),
            });

            if (createTokenResp.status === 'error' || 'error' in createTokenResp) {
              return { error: 'unknown', message: createTokenResp.error };
            }

            const { link, requisitionId } = createTokenResp.data;
            window.Actual.openURLInBrowser(link);

            // Poll for accounts
            return pollForAccounts(requisitionId);
          },
          fileId,
          syncScope,
          onClose,
          onSuccess,
        },
      },
    }),
  );

  async function pollForAccounts(requisitionId: string): Promise<any> {
    const startTime = Date.now();
    const timeout = 1000 * 60 * 10; // 10 minutes

    while (Date.now() - startTime < timeout) {
      try {
        const response = await send('bank-sync-plugin-call', {
          providerSlug: GOCARDLESS_PLUGIN_SLUG,
          path: 'get-accounts',
          method: 'POST',
          body: { requisitionId },
              ...(fileId ? { fileId } : {}),
        });

        if (response.status === 'error' || 'error' in response) {
          return { error: 'unknown', message: response.error };
        }

        // Check if requisition is linked
        if (response.data && response.data.accounts) {
          // Successfully linked
          return { data: response.data };
        }

        // Not yet linked, wait and retry
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (error) {
        return { error: 'unknown', message: String(error) };
      }
    }

    return { error: 'timeout' };
  }
}

export async function authorizeBank(dispatch: AppDispatch) {
  _authorize(dispatch, {
    onSuccess: async data => {
      const externalAccounts = normalizeGoCardlessAccountsForPlugin(data.accounts);
      dispatch(
        pushModal({
          modal: {
            name: 'select-linked-accounts',
            options: {
              externalAccounts,
              requisitionId: data.id,
              syncSource: 'plugin',
              providerSlug: 'gocardless-bank-sync',
              syncScope: 'global',
            },
          },
        }),
      );
    },
  });
}

export async function authorizeBankWithScope(
  dispatch: AppDispatch,
  {
    fileId,
    syncScope,
    upgradingAccountId,
  }: {
    fileId?: string;
    syncScope: 'global' | 'file';
    upgradingAccountId?: string;
  },
) {
  _authorize(dispatch, {
    fileId: syncScope === 'file' ? fileId : undefined,
    syncScope,
    onSuccess: async data => {
      const externalAccounts = normalizeGoCardlessAccountsForPlugin(data.accounts);
      dispatch(
        pushModal({
          modal: {
            name: 'select-linked-accounts',
            options: {
              externalAccounts,
              requisitionId: data.id,
              syncSource: 'plugin',
              providerSlug: 'gocardless-bank-sync',
              syncScope,
              upgradingAccountId,
            },
          },
        }),
      );
    },
  });
}
