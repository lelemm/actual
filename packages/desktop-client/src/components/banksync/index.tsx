import { useMemo, useState, useCallback } from 'react';
import { Dialog, DialogTrigger } from 'react-aria-components';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { SvgAdd } from '@actual-app/components/icons/v1';
import { Menu } from '@actual-app/components/menu';
import { Popover } from '@actual-app/components/popover';
import { Stack } from '@actual-app/components/stack';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';

import { send } from 'loot-core/platform/client/fetch';
import {
  type BankSyncProviders,
  type AccountEntity,
} from 'loot-core/types/models';



import { AccountsHeader } from './AccountsHeader';
import { AccountsList } from './AccountsList';

import { BankSyncStatus } from '@desktop-client/components/BankSyncStatus';
import { MOBILE_NAV_HEIGHT } from '@desktop-client/components/mobile/MobileNavTabs';
import { Page } from '@desktop-client/components/Page';
import { useAccounts } from '@desktop-client/hooks/useAccounts';
import { useGlobalPref } from '@desktop-client/hooks/useGlobalPref';
import { useGoCardlessStatus } from '@desktop-client/hooks/useGoCardlessStatus';
import { usePluggyAiStatus } from '@desktop-client/hooks/usePluggyAiStatus';
import { useSimpleFinStatus } from '@desktop-client/hooks/useSimpleFinStatus';
import { pushModal } from '@desktop-client/modals/modalsSlice';
import { useDispatch } from '@desktop-client/redux';

type SyncProviders = BankSyncProviders | 'unlinked';

const useSyncSourceReadable = () => {
  const { t } = useTranslation();

  const syncSourceReadable: Record<SyncProviders, string> = {
    goCardless: 'GoCardless',
    simpleFin: 'SimpleFIN',
    pluggyai: 'Pluggy.ai',
    unlinked: t('Unlinked'),
  };

  return { syncSourceReadable };
};

export function BankSync() {
  const { t } = useTranslation();
  const [floatingSidebar] = useGlobalPref('floatingSidebar');

  const { syncSourceReadable } = useSyncSourceReadable();

  const accounts = useAccounts();
  const dispatch = useDispatch();
  const { isNarrowWidth } = useResponsive();

  // Get provider statuses
  const { configuredGoCardless } = useGoCardlessStatus();
  const { configuredSimpleFin } = useSimpleFinStatus();
  const { configuredPluggyAi } = usePluggyAiStatus();

  const [hoveredAccount, setHoveredAccount] = useState<
    AccountEntity['id'] | null
  >(null);

  const groupedAccounts = useMemo(() => {
    const unsorted = accounts
      .filter(a => !a.closed)
      .reduce(
        (acc, a) => {
          const syncSource = a.account_sync_source ?? 'unlinked';
          acc[syncSource] = acc[syncSource] || [];
          acc[syncSource].push(a);
          return acc;
        },
        {} as Record<SyncProviders, AccountEntity[]>,
      );

    const sortedKeys = Object.keys(unsorted).sort((keyA, keyB) => {
      if (keyA === 'unlinked') return 1;
      if (keyB === 'unlinked') return -1;
      return keyA.localeCompare(keyB);
    });

    return sortedKeys.reduce(
      (sorted, key) => {
        sorted[key as SyncProviders] = unsorted[key as SyncProviders];
        return sorted;
      },
      {} as Record<SyncProviders, AccountEntity[]>,
    );
  }, [accounts]);

  const onAction = async (account: AccountEntity, action: 'link' | 'edit') => {
    switch (action) {
      case 'edit':
        dispatch(
          pushModal({
            modal: {
              name: 'synced-account-edit',
              options: {
                account,
              },
            },
          }),
        );
        break;
      case 'link':
        dispatch(
          pushModal({
            modal: {
              name: 'add-account',
              options: { upgradingAccountId: account.id },
            },
          }),
        );
        break;
      default:
        break;
    }
  };

  const onHover = useCallback((id: AccountEntity['id'] | null) => {
    setHoveredAccount(id);
  }, []);

  // Create menu items for configured providers
  const availableProviders = useMemo(() => {
    const providers = [];

    if (configuredGoCardless) {
      providers.push({
        name: 'GoCardless',
        text: 'GoCardless',
      });
    }

    if (configuredSimpleFin) {
      providers.push({
        name: 'SimpleFin',
        text: 'SimpleFin',
      });
    }

    if (configuredPluggyAi) {
      providers.push({
        name: 'Pluggy.ai',
        text: 'Pluggy.ai',
      });
    }

    return providers;
  }, [configuredGoCardless, configuredSimpleFin, configuredPluggyAi]);

  const onAddBankSyncAccount = async (provider: string) => {
    switch (provider) {
      case 'GoCardless':
        // Use the same logic as CreateAccountModal for GoCardless
        const { authorizeBank } = await import('@desktop-client/gocardless');
        authorizeBank(dispatch);
        break;
      case 'SimpleFin':
        // Use the same logic as CreateAccountModal for SimpleFin
        try {
          const results = await send('simplefin-accounts');
          if (results.error_code) {
            throw new Error(results.reason);
          }

          const newAccounts = [];

          type NormalizedAccount = {
            account_id: string;
            name: string;
            institution: string;
            orgDomain: string;
            orgId: string;
            balance: number;
          };

          for (const oldAccount of results.accounts ?? []) {
            const newAccount: NormalizedAccount = {
              account_id: oldAccount.id,
              name: oldAccount.name,
              institution: oldAccount.org.name,
              orgDomain: oldAccount.org.domain,
              orgId: oldAccount.org.id,
              balance: oldAccount.balance,
            };

            newAccounts.push(newAccount);
          }

          dispatch(
            pushModal({
              modal: {
                name: 'select-linked-accounts',
                options: {
                  externalAccounts: newAccounts,
                  syncSource: 'simpleFin',
                },
              },
            }),
          );
        } catch (err) {
          console.error(err);
        }
        break;
      case 'Pluggy.ai':
        // Use the same logic as CreateAccountModal for PluggyAi
        try {
          const results = await send('pluggyai-accounts');
          if (results.error_code) {
            throw new Error(results.reason);
          } else if ('error' in results) {
            throw new Error(results.error);
          }

          const newAccounts = [];

          type NormalizedAccount = {
            account_id: string;
            name: string;
            institution: string;
            orgDomain: string | null;
            orgId: string;
            balance: number;
          };

          for (const oldAccount of results.accounts) {
            const newAccount: NormalizedAccount = {
              account_id: oldAccount.id,
              name: `${oldAccount.name.trim()} - ${oldAccount.type === 'BANK' ? oldAccount.taxNumber : oldAccount.owner}`,
              institution: oldAccount.name,
              orgDomain: null,
              orgId: oldAccount.id,
              balance:
                oldAccount.type === 'BANK'
                  ? oldAccount.bankData.automaticallyInvestedBalance +
                    oldAccount.bankData.closingBalance
                  : oldAccount.balance,
            };

            newAccounts.push(newAccount);
          }

          dispatch(
            pushModal({
              modal: {
                name: 'select-linked-accounts',
                options: {
                  externalAccounts: newAccounts,
                  syncSource: 'pluggyai',
                },
              },
            }),
          );
        } catch (err) {
          console.error(err);
        }
        break;
      default:
        break;
    }
  };

  return (
    <Page
      header={t('Bank Sync')}
      style={{
        marginInline: floatingSidebar && !isNarrowWidth ? 'auto' : 0,
        paddingBottom: MOBILE_NAV_HEIGHT,
      }}
    >
      <View style={{ marginTop: '1em' }}>
        <BankSyncStatus />

        {availableProviders.length > 0 && (
          <View style={{ padding: '15px 0', flexShrink: 0 }}>
            <Stack
              direction="row"
              align="center"
              justify="flex-end"
              spacing={2}
            >
              <DialogTrigger>
                <Button variant="primary">
                  <SvgAdd width={10} height={10} style={{ marginRight: 4 }} />
                  <Trans>Add a Bank Sync account</Trans>
                </Button>
                <Popover placement="bottom">
                  <Dialog>
                    <Menu
                      onMenuSelect={provider => {
                        onAddBankSyncAccount(provider);
                      }}
                      items={availableProviders}
                    />
                  </Dialog>
                </Popover>
              </DialogTrigger>
            </Stack>
          </View>
        )}
        {Object.entries(groupedAccounts).map(([syncProvider, accounts]) => {
          return (
            <View key={syncProvider} style={{ minHeight: 'initial' }}>
              {Object.keys(groupedAccounts).length > 1 && (
                <Text
                  style={{ fontWeight: 500, fontSize: 20, margin: '.5em 0' }}
                >
                  {syncSourceReadable[syncProvider as SyncProviders]}
                </Text>
              )}
              <AccountsHeader unlinked={syncProvider === 'unlinked'} />
              <AccountsList
                accounts={accounts}
                hoveredAccount={hoveredAccount}
                onHover={onHover}
                onAction={onAction}
              />
            </View>
          );
        })}
      </View>
    </Page>
  );
}
