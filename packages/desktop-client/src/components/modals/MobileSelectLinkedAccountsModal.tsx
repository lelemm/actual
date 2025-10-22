import React, { useMemo, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import {
  type AccountEntity,
  type SyncServerGoCardlessAccount,
  type SyncServerPluggyAiAccount,
  type SyncServerSimpleFinAccount,
} from 'loot-core/types/models';

import {
  linkAccount,
  linkAccountPluggyAi,
  linkAccountSimpleFin,
  unlinkAccount,
} from '@desktop-client/accounts/accountsSlice';
import {
  Modal,
  ModalCloseButton,
  ModalHeader,
} from '@desktop-client/components/common/Modal';
import { PrivacyFilter } from '@desktop-client/components/PrivacyFilter';
import { useAccounts } from '@desktop-client/hooks/useAccounts';
import { closeModal } from '@desktop-client/modals/modalsSlice';
import { useDispatch } from '@desktop-client/redux';

function useAddBudgetAccountOptions() {
  const { t } = useTranslation();

  const addOnBudgetAccountOption = {
    id: 'new-on',
    name: t('Create new account'),
  };
  const addOffBudgetAccountOption = {
    id: 'new-off',
    name: t('Create new account (off budget)'),
  };

  return { addOnBudgetAccountOption, addOffBudgetAccountOption };
}

export type MobileSelectLinkedAccountsModalProps =
  | {
      requisitionId: string;
      externalAccounts: SyncServerGoCardlessAccount[];
      syncSource: 'goCardless';
    }
  | {
      requisitionId?: undefined;
      externalAccounts: SyncServerSimpleFinAccount[];
      syncSource: 'simpleFin';
    }
  | {
      requisitionId?: undefined;
      externalAccounts: SyncServerPluggyAiAccount[];
      syncSource: 'pluggyai';
    };

export function MobileSelectLinkedAccountsModal({
  requisitionId = undefined,
  externalAccounts,
  syncSource,
}: MobileSelectLinkedAccountsModalProps) {
  const propsWithSortedExternalAccounts =
    useMemo<MobileSelectLinkedAccountsModalProps>(() => {
      const toSort = externalAccounts ? [...externalAccounts] : [];
      toSort.sort(
        (a, b) =>
          getInstitutionName(a)?.localeCompare(getInstitutionName(b)) ||
          a.name.localeCompare(b.name),
      );
      switch (syncSource) {
        case 'simpleFin':
          return {
            syncSource: 'simpleFin',
            externalAccounts: toSort as SyncServerSimpleFinAccount[],
          };
        case 'pluggyai':
          return {
            syncSource: 'pluggyai',
            externalAccounts: toSort as SyncServerPluggyAiAccount[],
          };
        case 'goCardless':
          return {
            syncSource: 'goCardless',
            requisitionId: requisitionId!,
            externalAccounts: toSort as SyncServerGoCardlessAccount[],
          };
      }
    }, [externalAccounts, syncSource, requisitionId]);

  const { t } = useTranslation();
  const dispatch = useDispatch();
  const localAccounts = useAccounts().filter(a => a.closed === 0);
  const [chosenAccounts, setChosenAccounts] = useState<Record<string, string>>(
    () => {
      return Object.fromEntries(
        localAccounts
          .filter(acc => acc.account_id)
          .map(acc => [acc.account_id, acc.id]),
      );
    },
  );
  const { addOnBudgetAccountOption, addOffBudgetAccountOption } =
    useAddBudgetAccountOptions();

  async function onNext() {
    const chosenLocalAccountIds = Object.values(chosenAccounts);

    // Unlink accounts that were previously linked, but the user
    // chose to remove the bank-sync
    localAccounts
      .filter(acc => acc.account_id)
      .filter(acc => !chosenLocalAccountIds.includes(acc.id))
      .forEach(acc => dispatch(unlinkAccount({ id: acc.id })));

    // Link new accounts
    Object.entries(chosenAccounts).forEach(
      ([chosenExternalAccountId, chosenLocalAccountId]) => {
        const externalAccountIndex =
          propsWithSortedExternalAccounts.externalAccounts.findIndex(
            account => account.account_id === chosenExternalAccountId,
          );
        const offBudget = chosenLocalAccountId === addOffBudgetAccountOption.id;

        // Skip linking accounts that were previously linked with
        // a different bank.
        if (externalAccountIndex === -1) {
          return;
        }

        // Finally link the matched account
        if (propsWithSortedExternalAccounts.syncSource === 'simpleFin') {
          dispatch(
            linkAccountSimpleFin({
              externalAccount:
                propsWithSortedExternalAccounts.externalAccounts[
                  externalAccountIndex
                ],
              upgradingId:
                chosenLocalAccountId !== addOnBudgetAccountOption.id &&
                chosenLocalAccountId !== addOffBudgetAccountOption.id
                  ? chosenLocalAccountId
                  : undefined,
              offBudget,
            }),
          );
        } else if (propsWithSortedExternalAccounts.syncSource === 'pluggyai') {
          dispatch(
            linkAccountPluggyAi({
              externalAccount:
                propsWithSortedExternalAccounts.externalAccounts[
                  externalAccountIndex
                ],
              upgradingId:
                chosenLocalAccountId !== addOnBudgetAccountOption.id &&
                chosenLocalAccountId !== addOffBudgetAccountOption.id
                  ? chosenLocalAccountId
                  : undefined,
              offBudget,
            }),
          );
        } else {
          dispatch(
            linkAccount({
              requisitionId: propsWithSortedExternalAccounts.requisitionId,
              account:
                propsWithSortedExternalAccounts.externalAccounts[
                  externalAccountIndex
                ],
              upgradingId:
                chosenLocalAccountId !== addOnBudgetAccountOption.id &&
                chosenLocalAccountId !== addOffBudgetAccountOption.id
                  ? chosenLocalAccountId
                  : undefined,
              offBudget,
            }),
          );
        }
      },
    );

    dispatch(closeModal());
  }

  const unlinkedAccounts = localAccounts.filter(
    account => !Object.values(chosenAccounts).includes(account.id),
  );

  function onSetLinkedAccount(
    externalAccount:
      | SyncServerGoCardlessAccount
      | SyncServerSimpleFinAccount
      | SyncServerPluggyAiAccount,
    localAccountId: string | null | undefined,
  ) {
    setChosenAccounts(accounts => {
      const updatedAccounts = { ...accounts };

      if (localAccountId) {
        updatedAccounts[externalAccount.account_id] = localAccountId;
      } else {
        delete updatedAccounts[externalAccount.account_id];
      }

      return updatedAccounts;
    });
  }

  return (
    <Modal
      name="select-linked-accounts"
      containerProps={{ style: { width: '95vw', maxWidth: 500 } }}
    >
      {({ state: { close } }) => (
        <>
          <ModalHeader
            title={t('Link Accounts')}
            rightContent={<ModalCloseButton onPress={close} />}
          />
          <View style={{ padding: 16 }}>
            <Text style={{ marginBottom: 16 }}>
              <Trans>
                We found the following accounts. Select which ones you want to
                add:
              </Trans>
            </Text>

            <View style={{ gap: 16, overflowY: 'auto' }}>
              {propsWithSortedExternalAccounts.externalAccounts.map(
                (account, index) => (
                  <MobileAccountRow
                    key={account.account_id}
                    externalAccount={account}
                    chosenAccount={
                      chosenAccounts[account.account_id] ===
                      addOnBudgetAccountOption.id
                        ? addOnBudgetAccountOption
                        : chosenAccounts[account.account_id] ===
                            addOffBudgetAccountOption.id
                          ? addOffBudgetAccountOption
                          : localAccounts.find(
                              acc =>
                                chosenAccounts[account.account_id] === acc.id,
                            )
                    }
                    unlinkedAccounts={unlinkedAccounts}
                    onSetLinkedAccount={onSetLinkedAccount}
                  />
                ),
              )}
            </View>

            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'flex-end',
                marginTop: 24,
              }}
            >
              <Button
                variant="primary"
                onPress={onNext}
                isDisabled={!Object.keys(chosenAccounts).length}
              >
                <Trans>Link accounts</Trans>
              </Button>
            </View>
          </View>
        </>
      )}
    </Modal>
  );
}

function getInstitutionName(
  externalAccount:
    | SyncServerGoCardlessAccount
    | SyncServerSimpleFinAccount
    | SyncServerPluggyAiAccount,
) {
  if (typeof externalAccount?.institution === 'string') {
    return externalAccount?.institution ?? '';
  } else if (typeof externalAccount.institution?.name === 'string') {
    return externalAccount?.institution?.name ?? '';
  }
  return '';
}

type MobileAccountRowProps = {
  externalAccount:
    | SyncServerGoCardlessAccount
    | SyncServerSimpleFinAccount
    | SyncServerPluggyAiAccount;
  chosenAccount: { id: string; name: string } | undefined;
  unlinkedAccounts: AccountEntity[];
  onSetLinkedAccount: (
    externalAccount:
      | SyncServerGoCardlessAccount
      | SyncServerSimpleFinAccount
      | SyncServerPluggyAiAccount,
    localAccountId: string | null | undefined,
  ) => void;
};

function MobileAccountRow({
  externalAccount,
  chosenAccount,
  unlinkedAccounts,
  onSetLinkedAccount,
}: MobileAccountRowProps) {
  const [showOptions, setShowOptions] = useState(false);
  const { addOnBudgetAccountOption, addOffBudgetAccountOption } =
    useAddBudgetAccountOptions();
  const { t } = useTranslation();

  const availableAccountOptions: { id: string; name: string }[] = [
    ...unlinkedAccounts,
  ];
  if (chosenAccount && chosenAccount.id !== addOnBudgetAccountOption.id) {
    availableAccountOptions.push(chosenAccount);
  }
  availableAccountOptions.push(
    addOnBudgetAccountOption,
    addOffBudgetAccountOption,
  );

  return (
    <View
      style={{
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 8,
        padding: 16,
        backgroundColor: theme.tableBackground,
      }}
    >
      {/* Account Info */}
      <View style={{ marginBottom: 12 }}>
        <Text
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: theme.tableText,
            marginBottom: 4,
          }}
        >
          {externalAccount.name}
        </Text>
        <Text
          style={{
            fontSize: 14,
            color: theme.pageTextSubdued,
            marginBottom: 4,
          }}
        >
          {getInstitutionName(externalAccount)}
        </Text>
        <Text
          style={{
            fontSize: 14,
            color: theme.pageTextSubdued,
          }}
        >
          <PrivacyFilter>Balance: {externalAccount.balance}</PrivacyFilter>
        </Text>
      </View>

      {/* Selected Account */}
      <View style={{ marginBottom: 12 }}>
        <Text
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: theme.pageTextLight,
            marginBottom: 4,
          }}
        >
          Linked to:
        </Text>
        <Text
          style={{
            fontSize: 15,
            color: chosenAccount ? theme.tableText : theme.pageTextSubdued,
          }}
        >
          {chosenAccount?.name || t('Not linked')}
        </Text>
      </View>

      {/* Action Buttons */}
      <View
        style={{
          flexDirection: 'row',
          gap: 8,
        }}
      >
        {chosenAccount ? (
          <Button
            onPress={() => {
              onSetLinkedAccount(externalAccount, null);
            }}
            style={{ flex: 1 }}
          >
            <Trans>Remove link</Trans>
          </Button>
        ) : (
          <Button
            variant="primary"
            onPress={() => setShowOptions(true)}
            style={{ flex: 1 }}
          >
            <Trans>Link account</Trans>
          </Button>
        )}
      </View>

      {/* Account Selection Options */}
      {showOptions && (
        <View
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: `1px solid ${theme.tableBorder}`,
          }}
        >
          <Text
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: theme.pageTextLight,
              marginBottom: 8,
            }}
          >
            Choose account to link:
          </Text>
          <View style={{ gap: 8 }}>
            {availableAccountOptions.map(option => (
              <Button
                key={option.id}
                variant="bare"
                onPress={() => {
                  onSetLinkedAccount(externalAccount, option.id);
                  setShowOptions(false);
                }}
                style={{
                  padding: 8,
                  backgroundColor: theme.mobilePageBackground,
                  border: `1px solid ${theme.formInputBorder}`,
                  borderRadius: 4,
                  textAlign: 'left',
                }}
              >
                <Text style={{ fontSize: 14 }}>{option.name}</Text>
              </Button>
            ))}
          </View>
          <Button
            variant="bare"
            onPress={() => setShowOptions(false)}
            style={{ marginTop: 8, alignSelf: 'flex-start' }}
          >
            <Trans>Cancel</Trans>
          </Button>
        </View>
      )}
    </View>
  );
}
