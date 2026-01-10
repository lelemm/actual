import React from 'react';
import { Dialog, DialogTrigger } from 'react-aria-components';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { SvgDotsHorizontalTriple } from '@actual-app/components/icons/v1';
import { InitialFocus } from '@actual-app/components/initial-focus';
import { Menu } from '@actual-app/components/menu';
import { Paragraph } from '@actual-app/components/paragraph';
import { Popover } from '@actual-app/components/popover';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { useAuth } from '@desktop-client/auth/AuthProvider';
import { Permissions } from '@desktop-client/auth/types';
import { Warning } from '@desktop-client/components/alerts';
import { Link } from '@desktop-client/components/common/Link';
import {
  Modal,
  ModalCloseButton,
  ModalHeader,
} from '@desktop-client/components/common/Modal';
import { useMultiuserEnabled } from '@desktop-client/components/ServerContext';
import { authorizeBank } from '@desktop-client/gocardless';
import { useSyncServerStatus } from '@desktop-client/hooks/useSyncServerStatus';
import {
  type Modal as ModalType,
  pushModal,
} from '@desktop-client/modals/modalsSlice';
import { addNotification } from '@desktop-client/notifications/notificationsSlice';
import { useDispatch } from '@desktop-client/redux';
import { useNavigate } from '@desktop-client/hooks/useNavigate';
import { send } from 'loot-core/platform/client/fetch';

type CreateAccountModalProps = Extract<
  ModalType,
  { name: 'add-account' }
>['options'];

export function CreateAccountModal({
  upgradingAccountId,
}: CreateAccountModalProps) {
  const { t } = useTranslation();

  const syncServerStatus = useSyncServerStatus();
  const dispatch = useDispatch();
  const { hasPermission } = useAuth();
  const multiuserEnabled = useMultiuserEnabled();
  const navigate = useNavigate();

  const onCreateLocalAccount = () => {
    dispatch(pushModal({ modal: { name: 'add-local-account' } }));
  };

  // Special handler for GoCardless plugin (uses custom UI flow)
  const onConnectGoCardless = () => {
    authorizeBank(dispatch);
  };

  let title = t('Add account');

  if (upgradingAccountId != null) {
    title = t('Link account');
  }

  const canSetSecrets =
    !multiuserEnabled || hasPermission(Permissions.ADMINISTRATOR);

  return (
    <Modal name="add-account">
      {({ state: { close } }) => (
        <>
          <ModalHeader
            title={title}
            rightContent={<ModalCloseButton onPress={close} />}
          />
          <View style={{ maxWidth: 500, gap: 30, color: theme.pageText }}>
            {upgradingAccountId != null ? (
              <View style={{ gap: 10 }}>
                <Text style={{ lineHeight: '1.4em', fontSize: 15 }}>
                  <Trans>
                    Bank sync linking is managed from the <strong>Bank Sync</strong>{' '}
                    page.
                  </Trans>
                </Text>
                <Button
                  variant="primary"
                  isDisabled={syncServerStatus !== 'online'}
                  onPress={() => {
                    close();
                    navigate('/bank-sync');
                  }}
                >
                  <Trans>Go to Bank Sync</Trans>
                </Button>
              </View>
            ) : (
              <>
                <View style={{ gap: 10 }}>
                  <InitialFocus>
                    <Button
                      variant="primary"
                      style={{
                        padding: '10px 0',
                        fontSize: 15,
                        fontWeight: 600,
                      }}
                      onPress={onCreateLocalAccount}
                    >
                      <Trans>Create a local account</Trans>
                    </Button>
                  </InitialFocus>
                  <View style={{ lineHeight: '1.4em', fontSize: 15 }}>
                    <Text>
                      <Trans>
                        <strong>Create a local account</strong> if you want to add
                        transactions manually. You can also{' '}
                        <Link
                          variant="external"
                          to="https://actualbudget.org/docs/transactions/importing"
                          linkColor="muted"
                        >
                          import QIF/OFX/QFX files into a local account
                        </Link>
                        .
                      </Trans>
                    </Text>
                  </View>
                </View>

                <View style={{ gap: 10 }}>
                  <Button
                    variant="primary"
                    isDisabled={syncServerStatus !== 'online'}
                    onPress={() => {
                      close();
                      navigate('/bank-sync');
                    }}
                  >
                    <Trans>Set up bank sync</Trans>
                  </Button>
                  <Paragraph style={{ fontSize: 15 }}>
                    <Trans>
                      Configure providers and link accounts from the Bank Sync page.
                    </Trans>
                  </Paragraph>
                </View>
              </>
            )}
          </View>
        </>
      )}
    </Modal>
  );
}
