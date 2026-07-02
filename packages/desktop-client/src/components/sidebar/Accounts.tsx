import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SvgAdd } from '@actual-app/components/icons/v1';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type { AccountEntity } from '@actual-app/core/types/models';

import { useMoveAccountMutation } from '#accounts';
import { isAccountFailedSync } from '#accounts/syncStatus';
import { useAccounts } from '#hooks/useAccounts';
import { useClosedAccounts } from '#hooks/useClosedAccounts';
import { useLocalPref } from '#hooks/useLocalPref';
import { useOffBudgetAccounts } from '#hooks/useOffBudgetAccounts';
import { useOnBudgetAccounts } from '#hooks/useOnBudgetAccounts';
import { useUpdatedAccounts } from '#hooks/useUpdatedAccounts';
import { replaceModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';
import { useSelector } from '#redux';
import * as bindings from '#spreadsheet/bindings';

import { Account } from './Account';
import { SecondaryButtons } from './SecondaryButtons';
import { SecondaryItem } from './SecondaryItem';

const fontWeight = 600;
const compactAccountStyle = {
  marginTop: 0,
  marginBottom: 0,
  paddingTop: 3,
  paddingBottom: 3,
  paddingLeft: 8,
  paddingRight: 8,
  borderRadius: 4,
  ':hover': { backgroundColor: '#1B3850' },
};

type AccountsProps = {
  showDivider?: boolean;
  showAddAccount?: boolean;
  disableAccountReorder?: boolean;
  compact?: boolean;
  sections?: Array<'all' | 'on-budget' | 'off-budget' | 'closed' | 'add'>;
};

export function Accounts({
  showDivider = true,
  showAddAccount = false,
  disableAccountReorder = false,
  compact = false,
  sections = ['all', 'on-budget', 'off-budget', 'closed'],
}: AccountsProps) {
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const dispatch = useDispatch();
  const { data: accounts = [] } = useAccounts();
  const updatedAccounts = useUpdatedAccounts();
  const { data: offbudgetAccounts = [] } = useOffBudgetAccounts();
  const { data: onBudgetAccounts = [] } = useOnBudgetAccounts();
  const { data: closedAccounts = [] } = useClosedAccounts();
  const syncingAccountIds = useSelector(state => state.account.accountsSyncing);

  const getAccountPath = (account: AccountEntity) => `/accounts/${account.id}`;

  const [showClosedAccounts, setShowClosedAccountsPref] = useLocalPref(
    'ui.showClosedAccounts',
  );

  function onDragChange(drag: { state: string }) {
    setIsDragging(drag.state === 'start');
  }

  const moveAccount = useMoveAccountMutation();

  const makeDropPadding = (i: number) => {
    if (i === 0) {
      return {
        paddingTop: isDragging ? 15 : 0,
        marginTop: isDragging ? -15 : 0,
      };
    }
    return undefined;
  };

  async function onReorder(
    id: string,
    dropPos: 'top' | 'bottom' | null,
    targetId: string,
  ) {
    let targetIdToMove: string | null = targetId;
    if (dropPos === 'bottom') {
      const idx = accounts.findIndex(a => a.id === targetId) + 1;
      targetIdToMove = idx < accounts.length ? accounts[idx].id : null;
    }

    moveAccount.mutate({ id, targetId: targetIdToMove });
  }

  const onToggleClosedAccounts = () => {
    setShowClosedAccountsPref(!showClosedAccounts);
  };

  const onAddAccount = () => {
    dispatch(replaceModal({ modal: { name: 'add-account', options: {} } }));
  };
  const shouldShowAddAccount = showAddAccount || sections.includes('add');
  const shouldCenterCompact =
    compact &&
    sections.length === 1 &&
    (sections.includes('all') || sections.includes('add'));

  return (
    <View
      style={{
        flexGrow: 1,
        height: compact ? '100%' : undefined,
        justifyContent: shouldCenterCompact ? 'center' : undefined,
        '@media screen and (max-height: 480px)': {
          minHeight: 'auto',
        },
      }}
    >
      {showDivider && (
        <View
          style={{
            height: 1,
            backgroundColor: theme.sidebarItemBackgroundHover,
            marginTop: 15,
            flexShrink: 0,
          }}
        />
      )}

      <View
        style={{
          overflow: shouldCenterCompact ? 'visible' : 'auto',
          flexShrink: 0,
        }}
      >
        {sections.includes('all') && (
          <Account
            name={t('All accounts')}
            to="/accounts"
            query={bindings.allAccountBalance()}
            style={
              compact
                ? { ...compactAccountStyle, fontWeight }
                : { fontWeight, marginTop: 15 }
            }
            isExactPathMatch
            balanceTestId="sidebar-all-accounts-balance"
          />
        )}

        {sections.includes('on-budget') && onBudgetAccounts.length > 0 && (
          <>
            <Account
              name={t('On budget')}
              to="/accounts/onbudget"
              query={bindings.onBudgetAccountBalance()}
              style={{
                ...(compact ? compactAccountStyle : null),
                fontWeight,
                marginTop: compact ? 0 : 13,
                marginBottom: compact ? 0 : 5,
              }}
              titleAccount
              balanceTestId="sidebar-on-budget-balance"
            />

            {onBudgetAccounts.map((account, i) => (
              <Account
                key={account.id}
                name={account.name}
                account={account}
                connected={!!account.bank}
                pending={syncingAccountIds.includes(account.id)}
                failed={isAccountFailedSync(account)}
                updated={updatedAccounts.includes(account.id)}
                to={getAccountPath(account)}
                query={bindings.accountBalance(account.id)}
                style={compact ? compactAccountStyle : undefined}
                onDragChange={disableAccountReorder ? undefined : onDragChange}
                onDrop={disableAccountReorder ? undefined : onReorder}
                outerStyle={makeDropPadding(i)}
              />
            ))}
          </>
        )}

        {sections.includes('off-budget') && offbudgetAccounts.length > 0 && (
          <>
            <Account
              name={t('Off budget')}
              to="/accounts/offbudget"
              query={bindings.offBudgetAccountBalance()}
              style={{
                ...(compact ? compactAccountStyle : null),
                fontWeight,
                marginTop: compact ? 0 : 13,
                marginBottom: compact ? 0 : 5,
              }}
              titleAccount
              balanceTestId="sidebar-off-budget-balance"
            />

            {offbudgetAccounts.map((account, i) => (
              <Account
                key={account.id}
                name={account.name}
                account={account}
                connected={!!account.bank}
                pending={syncingAccountIds.includes(account.id)}
                failed={isAccountFailedSync(account)}
                updated={updatedAccounts.includes(account.id)}
                to={getAccountPath(account)}
                query={bindings.accountBalance(account.id)}
                style={compact ? compactAccountStyle : undefined}
                onDragChange={disableAccountReorder ? undefined : onDragChange}
                onDrop={disableAccountReorder ? undefined : onReorder}
                outerStyle={makeDropPadding(i)}
              />
            ))}
          </>
        )}

        {sections.includes('closed') && closedAccounts.length > 0 && (
          <SecondaryItem
            style={{ marginTop: compact ? 0 : 15 }}
            title={
              showClosedAccounts
                ? t('Closed accounts')
                : t('Closed accounts...')
            }
            onClick={onToggleClosedAccounts}
            bold
          />
        )}

        {sections.includes('closed') &&
          showClosedAccounts &&
          closedAccounts.map(account => (
            <Account
              key={account.id}
              name={account.name}
              account={account}
              to={getAccountPath(account)}
              query={bindings.accountBalance(account.id)}
              style={compact ? compactAccountStyle : undefined}
              onDragChange={disableAccountReorder ? undefined : onDragChange}
              onDrop={disableAccountReorder ? undefined : onReorder}
            />
          ))}

        {shouldShowAddAccount && (
          <SecondaryButtons
            style={compact ? { padding: 0 } : undefined}
            buttons={[
              {
                title: t('Add account'),
                Icon: SvgAdd,
                onClick: onAddAccount,
              },
            ]}
          />
        )}
      </View>
    </View>
  );
}
