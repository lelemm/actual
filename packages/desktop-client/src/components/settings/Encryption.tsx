import React, { useEffect, useState } from 'react';
import { Trans } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { send } from '@actual-app/core/platform/client/connection';

import { Link } from '#components/common/Link';
import { useServerURL } from '#components/ServerContext';
import { useMetadataPref } from '#hooks/useMetadataPref';
import { pushModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

import { Setting } from './UI';

export function EncryptionSettings() {
  const dispatch = useDispatch();
  const serverURL = useServerURL();
  const [encryptKeyId] = useMetadataPref('encryptKeyId');

  const missingCryptoAPI = !(window.crypto && crypto.subtle);

  function onChangeKey() {
    dispatch(
      pushModal({
        modal: { name: 'create-encryption-key', options: { recreate: true } },
      }),
    );
  }

  return encryptKeyId ? (
    <Setting
      primaryAction={
        <Button onPress={onChangeKey}>
          <Trans>Generate new key</Trans>
        </Button>
      }
    >
      <Text>
        <Text style={{ color: theme.noticeTextLight, fontWeight: 600 }}>
          <Trans>End-to-end Encryption is turned on.</Trans>
        </Text>{' '}
        <Trans>
          Your budget data is encrypted with a key that only you have before
          sending it out to the cloud. Local data remains unencrypted so if you
          forget your password you can re-encrypt it. Note: bank sync operations
          and secrets stored on the server are not covered by end-to-end
          encryption.
        </Trans>{' '}
        <Link
          variant="external"
          to="https://actualbudget.org/docs/getting-started/sync/#end-to-end-encryption"
          linkColor="purple"
        >
          <Trans>Learn more</Trans>
        </Link>
      </Text>
    </Setting>
  ) : missingCryptoAPI ? (
    <Setting
      primaryAction={
        <Button isDisabled>
          <Trans>Enable encryption</Trans>
        </Button>
      }
    >
      <Text>
        <Trans>
          <strong>End-to-end encryption</strong> is not available when making an
          unencrypted connection to a remote server. You'll need to enable HTTPS
          on your server to use end-to-end encryption. This problem may also
          occur if your browser is too old to work with Actual.
        </Trans>{' '}
        <Link
          variant="external"
          to="https://actualbudget.org/docs/config/https"
          linkColor="purple"
        >
          <Trans>Learn more</Trans>
        </Link>
      </Text>
    </Setting>
  ) : serverURL ? (
    <Setting
      primaryAction={
        <Button
          onPress={() =>
            dispatch(
              pushModal({
                modal: { name: 'create-encryption-key', options: {} },
              }),
            )
          }
        >
          <Trans>Enable encryption</Trans>
        </Button>
      }
    >
      <Text>
        <Trans>
          <strong>End-to-end encryption</strong> is not enabled. Any data on the
          server is still protected by the server password, but it's not
          end-to-end encrypted which means the server owners have the ability to
          read it. If you want, you can use an additional password to encrypt
          your data on the server.
        </Trans>{' '}
        <Link
          variant="external"
          to="https://actualbudget.org/docs/getting-started/sync/#end-to-end-encryption"
          linkColor="purple"
        >
          <Trans>Learn more</Trans>
        </Link>
      </Text>
    </Setting>
  ) : (
    <Setting
      primaryAction={
        <Button isDisabled>
          <Trans>Enable encryption</Trans>
        </Button>
      }
    >
      <Text>
        <Trans>
          <strong>End-to-end encryption</strong> is not available when running
          without a server. Budget files are always kept unencrypted locally,
          and encryption is only applied when sending data to a server.
        </Trans>{' '}
        <Link
          variant="external"
          to="https://actualbudget.org/docs/getting-started/sync/#end-to-end-encryption"
          linkColor="purple"
        >
          <Trans>Learn more</Trans>
        </Link>
      </Text>
    </Setting>
  );
}

type ServerAccessState = {
  available: boolean;
  status: 'disabled' | 'starting' | 'ready' | 'degraded';
  fingerprint?: string;
};

export function ServerAccessSettings() {
  const serverURL = useServerURL();
  const [state, setState] = useState<ServerAccessState>({
    available: false,
    status: 'disabled',
  });
  const [isSaving, setIsSaving] = useState(false);
  const [hasError, setHasError] = useState(false);

  async function refresh() {
    try {
      setState(await send('server-access/get'));
    } catch {
      setState({ available: false, status: 'disabled' });
      setHasError(true);
    }
  }

  useEffect(() => {
    if (serverURL) void refresh();
  }, [serverURL]);

  async function toggle() {
    setIsSaving(true);
    setHasError(false);
    try {
      const result =
        state.status === 'disabled'
          ? await send('server-access/enable', {
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            })
          : await send('server-access/disable');
      setHasError(Boolean(result?.error));
      await refresh();
    } catch {
      setHasError(true);
    } finally {
      setIsSaving(false);
    }
  }

  const isEnabled = state.status !== 'disabled';
  return (
    <div data-testid="server-access-settings" style={{ width: '100%' }}>
      <Setting
        primaryAction={
          <Button
            isDisabled={isSaving || (!state.available && !isEnabled)}
            onPress={toggle}
            data-testid="server-access-toggle"
          >
            {isEnabled ? (
              <Trans>Disable server access</Trans>
            ) : (
              <Trans>Allow server access</Trans>
            )}
          </Button>
        }
      >
        <Text style={{ fontWeight: 600 }}>
          <Trans>Server API and schedule automation</Trans>
        </Text>
        <Text>
          <Trans>
            Allowing server access lets this server decrypt this budget, keep an
            encrypted database mirror, expose the budget API, and automatically
            post scheduled transactions. This budget is no longer end-to-end
            encrypted while access is enabled. Only enable this on a server you
            trust and control.
          </Trans>{' '}
          <Link
            variant="external"
            to="https://actualbudget.org/docs/getting-started/sync/#server-access"
            linkColor="purple"
          >
            <Trans>Learn more</Trans>
          </Link>
        </Text>
        {!serverURL && (
          <Text style={{ color: theme.noticeTextLight }}>
            <Trans>
              Connect this budget to a sync server to use this feature.
            </Trans>
          </Text>
        )}
        {serverURL && !state.available && !isEnabled && (
          <Text style={{ color: theme.noticeTextLight }}>
            <Trans>This server has not configured server access.</Trans>
          </Text>
        )}
        {isEnabled && (
          <Text style={{ color: theme.noticeTextLight }}>
            <Trans>Server mirror status: {state.status}</Trans>
          </Text>
        )}
        {hasError && (
          <Text style={{ color: theme.errorText }}>
            <Trans>Actual could not change server access. Try again.</Trans>
          </Text>
        )}
      </Setting>
    </div>
  );
}
