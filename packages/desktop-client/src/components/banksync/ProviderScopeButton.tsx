import React, { useMemo } from 'react';
import { DialogTrigger } from 'react-aria-components';
import { useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Menu, type MenuItem } from '@actual-app/components/menu';
import { Popover } from '@actual-app/components/popover';

import { type ProviderStatusMap } from './useProviderStatusMap';

import { type BankSyncProvider } from '@desktop-client/hooks/useBankSyncProviders';

export type BankSyncScope = 'global' | 'file';

function makeKey(providerSlug: string, scope: BankSyncScope) {
  return `${providerSlug}|${scope}`;
}

export function ProviderScopeButton({
  label,
  providers,
  statusMap,
  onSelect,
  isDisabled = false,
}: {
  label: string;
  providers: BankSyncProvider[];
  statusMap: ProviderStatusMap;
  onSelect: (arg: { providerSlug: string; scope: BankSyncScope }) => void;
  isDisabled?: boolean;
}) {
  const { t } = useTranslation();

  const items = useMemo(() => {
    const menuItems: MenuItem<string>[] = [];

    providers.forEach(provider => {
      const statuses = statusMap[provider.slug];

      menuItems.push({
        type: Menu.label,
        name: `label-${provider.slug}`,
        text: provider.displayName,
      });

      const globalConfigured = Boolean(statuses?.global?.configured);
      const fileConfigured = Boolean(statuses?.file?.configured);

      menuItems.push({
        name: makeKey(provider.slug, 'global'),
        text: t('Global'),
        disabled: !globalConfigured,
        tooltip: !globalConfigured ? t('Not configured') : undefined,
      });

      menuItems.push({
        name: makeKey(provider.slug, 'file'),
        text: t('Scoped'),
        disabled: !fileConfigured,
        tooltip: !fileConfigured ? t('Not configured') : undefined,
      });

      menuItems.push(Menu.line);
    });

    // Trim trailing divider
    if (menuItems[menuItems.length - 1] === Menu.line) {
      menuItems.pop();
    }

    return menuItems;
  }, [providers, statusMap, t]);

  return (
    <DialogTrigger>
      <Button isDisabled={isDisabled}>{label}</Button>
      <Popover>
        <Menu
          items={items}
          onMenuSelect={itemId => {
            const [providerSlug, scope] = String(itemId).split('|') as [
              string,
              BankSyncScope,
            ];
            if (providerSlug && (scope === 'global' || scope === 'file')) {
              onSelect({ providerSlug, scope });
            }
          }}
        />
      </Popover>
    </DialogTrigger>
  );
}

