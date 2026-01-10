import { useMemo, useState, useCallback } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';

import {
  type BankSyncProviders,
  type AccountEntity,
} from 'loot-core/types/models';
import { send } from 'loot-core/platform/client/fetch';

import { AccountsHeader } from './AccountsHeader';
import { AccountsList } from './AccountsList';
import { ProviderScopeButton, type BankSyncScope } from './ProviderScopeButton';
import { ProviderSetupGrid } from './ProviderSetupGrid';
import { useProviderStatusMap } from './useProviderStatusMap';

import { MOBILE_NAV_HEIGHT } from '@desktop-client/components/mobile/MobileNavTabs';
import { Page } from '@desktop-client/components/Page';
import { Permissions } from '@desktop-client/auth/types';
import { useAuth } from '@desktop-client/auth/AuthProvider';
import { Warning } from '@desktop-client/components/alerts';
import { authorizeBankWithScope } from '@desktop-client/gocardless';
import { useAccounts } from '@desktop-client/hooks/useAccounts';
import { useBankSyncProviders } from '@desktop-client/hooks/useBankSyncProviders';
import { useGlobalPref } from '@desktop-client/hooks/useGlobalPref';
import { useMetadataPref } from '@desktop-client/hooks/useMetadataPref';
import { useMultiuserEnabled } from '@desktop-client/components/ServerContext';
import { pushModal } from '@desktop-client/modals/modalsSlice';
import { addNotification } from '@desktop-client/notifications/notificationsSlice';
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
  const [budgetId] = useMetadataPref('id');
  const { hasPermission } = useAuth();
  const multiuserEnabled = useMultiuserEnabled();
  const canConfigureProviders =
    !multiuserEnabled || hasPermission(Permissions.ADMINISTRATOR);

  const { providers: pluginProviders } = useBankSyncProviders();
  const { statusMap, refetch: refetchProviderStatuses } = useProviderStatusMap({
    providers: pluginProviders,
    fileId: budgetId,
  });

  const [hoveredAccount, setHoveredAccount] = useState<
    AccountEntity['id'] | null
  >(null);

  const groupedAccounts = useMemo(() => {
    const unsorted = accounts
      .filter(a => !a.closed)
      .reduce(
        (acc, a) => {
          const syncSource = a.account_sync_source ?? 'unlinked';
          (acc as Record<string, AccountEntity[]>)[syncSource] =
            (acc as Record<string, AccountEntity[]>)[syncSource] || [];
          (acc as Record<string, AccountEntity[]>)[syncSource].push(a);
          return acc;
        },
        {} as Record<string, AccountEntity[]>,
      );

    const sortedKeys = Object.keys(unsorted).sort((keyA, keyB) => {
      if (keyA === 'unlinked') return 1;
      if (keyB === 'unlinked') return -1;
      return keyA.localeCompare(keyB);
    });

    return sortedKeys.reduce(
      (sorted, key) => {
        (sorted as Record<string, AccountEntity[]>)[key] =
          (unsorted as Record<string, AccountEntity[]>)[key];
        return sorted;
      },
      {} as Record<string, AccountEntity[]>,
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
      default:
        break;
    }
  };

  const onHover = useCallback((id: AccountEntity['id'] | null) => {
    setHoveredAccount(id);
  }, []);

  async function configureProvider({
    providerSlug,
    providerDisplayName,
    scope,
  }: {
    providerSlug: string;
    providerDisplayName: string;
    scope: BankSyncScope;
  }) {
    dispatch(
      pushModal({
        modal: {
          name: 'bank-sync-init',
          options: {
            providerSlug,
            providerDisplayName:
              scope === 'file'
                ? `${providerDisplayName} (${t('Scoped')})`
                : `${providerDisplayName} (${t('Global')})`,
            onSuccess: async (credentials: Record<string, string>) => {
              try {
                // Prefer POST /status as the canonical setup route.
                const result = await send('bank-sync-plugin-call', {
                  providerSlug,
                  path: 'status',
                  method: 'POST',
                  body: credentials,
                  ...(scope === 'file' && budgetId ? { fileId: budgetId } : {}),
                });

                // Fallback for plugins that only persist credentials via /accounts
                if ((result as any)?.status === 'error' || 'error' in (result as any)) {
                  await send('bank-sync-accounts', {
                    providerSlug,
                    credentials,
                    ...(scope === 'file' && budgetId ? { fileId: budgetId } : {}),
                  });
                }

                refetchProviderStatuses();
              } catch (err) {
                dispatch(
                  addNotification({
                    notification: {
                      type: 'error',
                      title: t('Failed to configure provider'),
                      message: err instanceof Error ? err.message : String(err),
                      timeout: 5000,
                    },
                  }),
                );
              }
            },
          },
        },
      }),
    );
  }

  async function openProviderAccounts({
    providerSlug,
    scope,
    upgradingAccountId,
  }: {
    providerSlug: string;
    scope: BankSyncScope;
    upgradingAccountId?: AccountEntity['id'];
  }) {
    try {
      if (providerSlug === 'gocardless-bank-sync') {
        authorizeBankWithScope(dispatch, {
          fileId: budgetId ?? undefined,
          syncScope: scope,
          upgradingAccountId,
        });
        return;
      }

      const result = (await send('bank-sync-accounts', {
        providerSlug,
        ...(scope === 'file' && budgetId ? { fileId: budgetId } : {}),
      })) as any;

      if (result?.error_code) {
        throw new Error(result.reason || result.error_code);
      }

      dispatch(
        pushModal({
          modal: {
            name: 'select-linked-accounts',
            options: {
              externalAccounts: result.accounts || [],
              syncSource: 'plugin' as const,
              providerSlug,
              syncScope: scope,
              upgradingAccountId,
            },
          },
        }),
      );
    } catch (err) {
      dispatch(
        addNotification({
          notification: {
            type: 'error',
            title: t('Error fetching accounts'),
            message: err instanceof Error ? err.message : String(err),
            timeout: 5000,
          },
        }),
      );
    }
  }

  return (
    <Page
      header={t('Bank Sync')}
      style={{
        marginInline: floatingSidebar && !isNarrowWidth ? 'auto' : 0,
        paddingBottom: MOBILE_NAV_HEIGHT,
      }}
    >
      <View style={{ marginTop: '1em' }}>
        {pluginProviders.length > 0 && (
          <View style={{ gap: 12, marginBottom: 24 }}>
            <Text style={{ fontWeight: 600, fontSize: 18 }}>
              <Trans>Providers</Trans>
            </Text>
            <ProviderSetupGrid
              providers={pluginProviders}
              statusMap={statusMap}
              canConfigure={canConfigureProviders}
              onConfigure={({ provider, scope }) =>
                configureProvider({
                  providerSlug: provider.slug,
                  providerDisplayName: provider.displayName,
                  scope,
                })
              }
            />
            {!canConfigureProviders && (
              <Warning>
                <Trans>
                  You don&apos;t have the required permissions to configure bank
                  sync providers. Please contact an Admin to configure them.
                </Trans>
              </Warning>
            )}
          </View>
        )}

        {pluginProviders.length > 0 && (
          <View style={{ marginBottom: 18, alignItems: 'flex-start' }}>
            <ProviderScopeButton
              label={t('Add bank sync account')}
              providers={pluginProviders}
              statusMap={statusMap}
              onSelect={({ providerSlug, scope }) =>
                openProviderAccounts({ providerSlug, scope })
              }
            />
          </View>
        )}

        {accounts.length === 0 && (
          <Text style={{ fontSize: '1.1rem' }}>
            <Trans>
              To use the bank syncing features, you must first add an account.
            </Trans>
          </Text>
        )}
        {Object.entries(groupedAccounts).map(([syncProvider, accounts]) => {
          const providerDisplayName =
            syncProvider === 'unlinked'
              ? t('Unlinked')
              : pluginProviders.find(p => p.slug === syncProvider)?.displayName ||
                syncSourceReadable[syncProvider as SyncProviders] ||
                syncProvider;

          return (
            <View key={syncProvider} style={{ minHeight: 'initial' }}>
              {Object.keys(groupedAccounts).length > 1 && (
                <Text
                  style={{ fontWeight: 500, fontSize: 20, margin: '.5em 0' }}
                >
                  {providerDisplayName}
                </Text>
              )}
              <AccountsHeader unlinked={syncProvider === 'unlinked'} />
              <AccountsList
                accounts={accounts}
                hoveredAccount={hoveredAccount}
                onHover={onHover}
                onAction={onAction}
                renderLinkButton={account => (
                  <ProviderScopeButton
                    label={t('Link account')}
                    providers={pluginProviders}
                    statusMap={statusMap}
                    isDisabled={pluginProviders.length === 0}
                    onSelect={({ providerSlug, scope }) =>
                      openProviderAccounts({
                        providerSlug,
                        scope,
                        upgradingAccountId: account.id,
                      })
                    }
                  />
                )}
              />
            </View>
          );
        })}
      </View>
    </Page>
  );
}
