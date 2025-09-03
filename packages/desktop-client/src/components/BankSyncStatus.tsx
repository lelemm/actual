import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Dialog, DialogTrigger } from 'react-aria-components';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgAdd } from '@actual-app/components/icons/v1';
import { Menu } from '@actual-app/components/menu';
import { Popover } from '@actual-app/components/popover';
import { Stack } from '@actual-app/components/stack';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { send } from 'loot-core/platform/client/fetch';

import { InfiniteScrollWrapper } from './common/InfiniteScrollWrapper';
import { Search } from './common/Search';
import { Cell, Row, TableHeader } from './table';

import { useMetadataPref } from '@desktop-client/hooks/useMetadataPref';
import { pushModal } from '@desktop-client/modals/modalsSlice';
import { useDispatch } from '@desktop-client/redux';

type Provider = 'SimpleFin' | 'GoCardless' | 'Pluggy.ai';

type CredentialEntity = {
  id: string;
  name: string;
  provider: Provider;
  scope: 'global' | 'budget-specific';
  file_id?: string | null;
};

const PROVIDER_SECRETS = {
  SimpleFin: ['simplefin_token', 'simplefin_accessKey'],
  GoCardless: ['gocardless_secretId', 'gocardless_secretKey'],
  'Pluggy.ai': [
    'pluggyai_clientId',
    'pluggyai_clientSecret',
    'pluggyai_itemIds',
  ],
};

const PROVIDER_MENU_ITEMS = [
  {
    name: 'SimpleFin',
    text: 'SimpleFin',
  },
  {
    name: 'GoCardless',
    text: 'GoCardless',
  },
  {
    name: 'Pluggy.ai',
    text: 'Pluggy.ai',
  },
];

export function BankSyncStatus() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const [cloudFileId] = useMetadataPref('cloudFileId');

  const [credentials, setCredentials] = useState<CredentialEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  const loadCredentials = useCallback(async () => {
    setLoading(true);

    try {
      // Fetch all secrets (global + current budget)
      const [globalSecretsResponse, budgetSecretsResponse] = await Promise.all([
        send('secrets-list', null), // Global secrets
        send('secrets-list', cloudFileId || null), // Budget-specific secrets
      ]);

      const processedCredentials: CredentialEntity[] = [];

      // Handle API responses
      const globalSecrets =
        globalSecretsResponse &&
        typeof globalSecretsResponse === 'object' &&
        'data' in globalSecretsResponse &&
        !globalSecretsResponse.error
          ? (globalSecretsResponse.data as {
              name: string;
              file_id: string | null;
            }[])
          : [];

      const budgetSecrets =
        budgetSecretsResponse &&
        typeof budgetSecretsResponse === 'object' &&
        'data' in budgetSecretsResponse &&
        !budgetSecretsResponse.error
          ? (budgetSecretsResponse.data as {
              name: string;
              file_id: string | null;
            }[])
          : [];

      // Combine all secrets from both calls
      const allSecrets = [...globalSecrets, ...budgetSecrets];

      // Group secrets by provider and scope
      const providers = Object.keys(PROVIDER_SECRETS) as Provider[];

      providers.forEach(provider => {
        const providerSecrets = PROVIDER_SECRETS[provider];

        // Find secrets for this provider, grouped by file_id
        const providerSecretsData = allSecrets.filter(secret =>
          providerSecrets.includes(secret.name),
        );

        // Group by file_id (null = global, non-null = budget-specific)
        const secretsByScope = providerSecretsData.reduce(
          (acc, secret) => {
            const scope =
              secret.file_id === null ? 'global' : 'budget-specific';
            if (!acc[scope]) {
              acc[scope] = [];
            }
            acc[scope].push(secret);
            return acc;
          },
          {} as Record<string, typeof providerSecretsData>,
        );

        // Add global credentials if they exist
        if (secretsByScope.global && secretsByScope.global.length > 0) {
          processedCredentials.push({
            id: `${provider}-global`,
            name: `${provider} (Global)`,
            provider,
            scope: 'global',
            file_id: null,
          });
        }

        // Add budget-specific credentials if they exist
        if (
          secretsByScope['budget-specific'] &&
          secretsByScope['budget-specific'].length > 0
        ) {
          // Get the file_id from the first secret (they should all have the same file_id)
          const fileId = secretsByScope['budget-specific'][0].file_id;
          processedCredentials.push({
            id: `${provider}-budget`,
            name: `${provider} (Budget-specific)`,
            provider,
            scope: 'budget-specific',
            file_id: fileId,
          });
        }
      });

      setCredentials(processedCredentials);
    } catch (error) {
      console.error('Failed to load credentials:', error);
      setCredentials([]);
    }

    setLoading(false);
  }, [cloudFileId]);

  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  const filteredCredentials = useMemo(() => {
    return credentials.filter(
      cred =>
        cred.name.toLowerCase().includes(filter.toLowerCase()) ||
        cred.provider.toLowerCase().includes(filter.toLowerCase()),
    );
  }, [credentials, filter]);

  const onAddCredential = (
    provider: Provider,
    scope: 'global' | 'budget-specific',
  ) => {
    const modalName =
      provider === 'SimpleFin'
        ? 'simplefin-init'
        : provider === 'GoCardless'
          ? 'gocardless-init'
          : 'pluggyai-init';

    dispatch(
      pushModal({
        modal: {
          name: modalName,
          options: {
            scope: scope === 'global' ? 'global' : 'budget',
            fileId: scope === 'global' ? null : (cloudFileId as string),
            onSuccess: loadCredentials,
          },
        },
      }),
    );
  };

  const onEditCredential = (credential: CredentialEntity) => {
    const modalName =
      credential.provider === 'SimpleFin'
        ? 'simplefin-init'
        : credential.provider === 'GoCardless'
          ? 'gocardless-init'
          : 'pluggyai-init';

    dispatch(
      pushModal({
        modal: {
          name: modalName,
          options: {
            scope: credential.scope === 'global' ? 'global' : 'budget',
            fileId:
              credential.scope === 'global' ? null : (cloudFileId as string),
            onSuccess: loadCredentials,
          },
        },
      }),
    );
  };

  const onDeleteCredential = (credential: CredentialEntity) => {
    dispatch(
      pushModal({
        modal: {
          name: 'confirm-delete',
          options: {
            message: t('Are you sure you want to delete {{credentialName}} credentials?', {
              credentialName: credential.name,
            }),
            onConfirm: async () => {
              setLoading(true);

              try {
                const providerSecrets = PROVIDER_SECRETS[credential.provider];
                const fileId =
                  credential.scope === 'global' ? null : (cloudFileId as string);

                // Delete all secrets for this provider/scope
                await Promise.all(
                  providerSecrets.map(secretName =>
                    send('secret-delete', { name: secretName, fileId }),
                  ),
                );

                await loadCredentials();
              } catch (error) {
                console.error('Failed to delete credentials:', error);
                alert('Failed to delete credentials. Please try again.');
              }

              setLoading(false);
            },
          },
        },
      }),
    );
  };

  return (
    <View style={{ marginBottom: '2em' }}>
      {/* Header with search and actions */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          padding: '0 0 15px',
          flexShrink: 0,
        }}
      >
        <View
          style={{
            color: theme.pageTextLight,
            flexDirection: 'row',
            alignItems: 'center',
            width: '50%',
          }}
        >
          <Text>
            <Trans>
              Manage API credentials for bank sync providers. Choose between
              global (all budgets) or budget-specific settings.
            </Trans>
          </Text>
        </View>
        <View style={{ flex: 1 }} />
        <Search
          placeholder={t('Filter credentials...')}
          value={filter}
          onChange={setFilter}
        />
      </View>

      {/* Table */}
      <View style={{ flex: 1 }}>
        <TableHeader>
          <Cell
            value={t('Provider')}
            width={250}
            style={{ paddingLeft: '10px' }}
          />
          <Cell
            value={t('Scope')}
            width="flex"
            style={{ paddingLeft: '10px' }}
          />
          <Cell value="Actions" width={200} style={{ paddingLeft: '10px' }} />
        </TableHeader>

        <InfiniteScrollWrapper loadMore={() => {}}>
          {loading ? (
            <View style={{ textAlign: 'center', padding: '20px' }}>
              <Text>{t('Loading...')}</Text>
            </View>
          ) : filteredCredentials.length === 0 ? (
            <View
              style={{
                textAlign: 'center',
                color: theme.pageTextSubdued,
                fontStyle: 'italic',
                fontSize: 13,
                marginTop: 15,
              }}
            >
              <Trans>No credentials configured</Trans>
            </View>
          ) : (
            <View>
              {filteredCredentials.map(credential => (
                <Row
                  key={credential.id}
                  height="auto"
                  style={{
                    fontSize: 13,
                    backgroundColor: theme.tableBackground,
                  }}
                  collapsed={true}
                >
                  <Cell
                    name="provider"
                    width={250}
                    plain
                    style={{ color: theme.tableText, padding: '10px' }}
                  >
                    {credential.provider}
                  </Cell>

                  <Cell
                    name="scope"
                    width="flex"
                    plain
                    style={{ color: theme.tableText, padding: '10px' }}
                  >
                    {credential.scope === 'global'
                      ? t('Global')
                      : t('Budget-specific')}
                  </Cell>

                  <Cell
                    name="actions"
                    width={200}
                    plain
                    style={{ padding: '8px 10px', textAlign: 'right' }}
                  >
                    <Stack direction="row" spacing={1} justify="flex-end">
                      <Button
                        variant="menu"
                        onPress={() => onDeleteCredential(credential)}
                      >
                        <Trans>Delete</Trans>
                      </Button>
                    </Stack>
                  </Cell>
                </Row>
              ))}
            </View>
          )}
        </InfiniteScrollWrapper>
      </View>

      {/* Footer with add buttons */}
      <View
        style={{
          paddingBlock: 15,
          paddingInline: 0,
          flexShrink: 0,
        }}
      >
        <Stack direction="row" align="center" justify="flex-end" spacing={2}>
          <DialogTrigger>
            <Button variant="primary">
              <SvgAdd width={10} height={10} style={{ marginRight: 4 }} />
              <Trans>Add Credentials</Trans>
            </Button>
            <Popover>
              <Dialog>
                <Menu
                  onMenuSelect={provider => {
                    onAddCredential(provider as Provider, 'budget-specific');
                  }}
                  items={PROVIDER_MENU_ITEMS}
                />
              </Dialog>
            </Popover>
          </DialogTrigger>
        </Stack>
      </View>
    </View>
  );
}
