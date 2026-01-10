import React from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';

import { type ProviderStatusMap } from './useProviderStatusMap';

import { type BankSyncProvider } from '@desktop-client/hooks/useBankSyncProviders';

type Scope = 'global' | 'file';

export function ProviderSetupGrid({
  providers,
  statusMap,
  onConfigure,
  canConfigure = true,
}: {
  providers: BankSyncProvider[];
  statusMap: ProviderStatusMap;
  onConfigure: (arg: { provider: BankSyncProvider; scope: Scope }) => void;
  canConfigure?: boolean;
}) {
  const { t } = useTranslation();

  if (providers.length === 0) {
    return null;
  }

  return (
    <View style={{ gap: 8 }}>
      <View
        style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 1fr',
          gap: 10,
          alignItems: 'center',
          padding: '6px 10px',
        }}
      >
        <Text style={{ fontWeight: 600 }}>{t('Provider')}</Text>
        <Text style={{ fontWeight: 600 }}>{t('Global')}</Text>
        <Text style={{ fontWeight: 600 }}>{t('Scoped')}</Text>
      </View>

      {providers.map(provider => {
        const statuses = statusMap[provider.slug];
        const globalConfigured = Boolean(statuses?.global?.configured);
        const fileConfigured = Boolean(statuses?.file?.configured);

        return (
          <View
            key={provider.slug}
            style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1fr 1fr',
              gap: 10,
              alignItems: 'center',
              padding: '10px',
              border: '1px solid var(--color-border)',
              borderRadius: 6,
            }}
          >
            <View style={{ gap: 4 }}>
              <Text style={{ fontWeight: 600 }}>{provider.displayName}</Text>
              {provider.description ? (
                <Text style={{ fontSize: 12, color: 'var(--color-pageTextSubdued)' }}>
                  {provider.description}
                </Text>
              ) : null}
            </View>

            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <Text>{globalConfigured ? t('Configured') : t('Not configured')}</Text>
              <Button
                isDisabled={!canConfigure}
                onPress={() => onConfigure({ provider, scope: 'global' })}
              >
                {globalConfigured ? t('Edit') : t('Set up')}
              </Button>
            </View>

            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <Text>{fileConfigured ? t('Configured') : t('Not configured')}</Text>
              <Button
                isDisabled={!canConfigure}
                onPress={() => onConfigure({ provider, scope: 'file' })}
              >
                {fileConfigured ? t('Edit') : t('Set up')}
              </Button>
            </View>
          </View>
        );
      })}
    </View>
  );
}

