import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import {
  SvgCheveronDown,
  SvgCheveronRight,
  SvgCog,
  SvgCreditCard,
  SvgReports,
  SvgStoreFront,
  SvgTag,
  SvgTuning,
  SvgWallet,
} from '@actual-app/components/icons/v1';
import { SvgCalendar3 } from '@actual-app/components/icons/v2';
import { View } from '@actual-app/components/view';

import { useIsTestEnv } from '#hooks/useIsTestEnv';
import { useSyncServerStatus } from '#hooks/useSyncServerStatus';

import { Item } from './Item';
import { SecondaryItem } from './SecondaryItem';

const modernPalette = {
  panel: '#102337',
  panelRaised: '#1B3850',
  line: '#2B4861',
};

type PrimaryButtonsProps = {
  modern?: boolean;
};

export function PrimaryButtons({ modern = false }: PrimaryButtonsProps) {
  const { t } = useTranslation();
  const [isOpen, setOpen] = useState(false);
  const onToggle = useCallback(() => setOpen(open => !open), []);
  const location = useLocation();

  const syncServerStatus = useSyncServerStatus();
  const isTestEnv = useIsTestEnv();
  const isUsingServer = syncServerStatus !== 'no-server' || isTestEnv;

  const isActive = [
    '/payees',
    '/rules',
    '/bank-sync',
    '/settings',
    '/tools',
  ].some(route => location.pathname.startsWith(route));

  useEffect(() => {
    if (isActive) {
      setOpen(true);
    }
  }, [isActive, location.pathname]);

  return (
    <View
      style={{
        flexShrink: 0,
        ...(modern && {
          margin: '0 6px 8px',
          padding: 6,
          backgroundColor: modernPalette.panel,
          border: '1px solid ' + modernPalette.line,
          borderRadius: 8,
        }),
      }}
    >
      <Item title={t('Budget')} Icon={SvgWallet} to="/budget" modern={modern} />
      <Item
        title={t('Reports')}
        Icon={SvgReports}
        to="/reports"
        modern={modern}
      />
      <Item
        title={t('Schedules')}
        Icon={SvgCalendar3}
        to="/schedules"
        modern={modern}
      />
      <Item
        title={t('More')}
        Icon={isOpen ? SvgCheveronDown : SvgCheveronRight}
        onClick={onToggle}
        style={{ marginBottom: isOpen ? (modern ? 4 : 8) : 0 }}
        forceActive={!isOpen && isActive}
        modern={modern}
      />
      {isOpen && (
        <>
          <SecondaryItem
            title={t('Payees')}
            Icon={SvgStoreFront}
            to="/payees"
            indent={15}
            modern={modern}
          />
          <SecondaryItem
            title={t('Rules')}
            Icon={SvgTuning}
            to="/rules"
            indent={15}
            modern={modern}
          />
          {isUsingServer && (
            <SecondaryItem
              title={t('Bank Sync')}
              Icon={SvgCreditCard}
              to="/bank-sync"
              indent={15}
              modern={modern}
            />
          )}
          <SecondaryItem
            title={t('Tags')}
            Icon={SvgTag}
            to="/tags"
            indent={15}
            modern={modern}
          />
          <SecondaryItem
            title={t('Settings')}
            Icon={SvgCog}
            to="/settings"
            indent={15}
            modern={modern}
          />
        </>
      )}
    </View>
  );
}
