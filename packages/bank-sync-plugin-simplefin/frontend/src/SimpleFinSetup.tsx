import * as React from 'react';
import { useState } from 'react';
import { Trans } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { FormError } from '@actual-app/components/form-error';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';
import {
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
} from '@actual-app/plugins-core/BasicModalComponents';
import type { BankSyncProviderSetupRenderProps } from '@actual-app/plugins-core/client';

export function SimpleFinSetup({
  close,
  onError,
  onSuccess,
  setSecret,
}: BankSyncProviderSetupRenderProps) {
  console.debug('[simplefin-plugin] SimpleFinSetup component render');

  const [token, setToken] = useState('');
  const [isValid, setIsValid] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('It is required to provide a token.');

  async function onSubmit() {
    if (!token) {
      setIsValid(false);
      return;
    }

    setIsLoading(true);

    try {
      await setSecret({ key: 'simplefin_token', value: token });
      setIsValid(true);
      onSuccess();
    } catch (submitError) {
      const message =
        submitError instanceof Error
          ? submitError.message
          : String(submitError);
      setIsValid(false);
      setError(message);
      onError(submitError);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <ModalHeader
        title="Set-up SimpleFIN"
        rightContent={<ModalCloseButton onPress={close} />}
      />
      <View style={{ display: 'flex', gap: 10, padding: 20, minWidth: 360 }}>
        <Text>
          In order to enable bank sync via SimpleFIN (only for North American
          banks), you will need to create a token. This can be done by creating
          an account with{' '}
          <a
            href="https://bridge.simplefin.org/"
            target="_blank"
            rel="noreferrer"
          >
            SimpleFIN
          </a>
          .
        </Text>

        <View style={{ gap: 4 }}>
          <Text>Token:</Text>
          <Input
            id="token-field"
            type="password"
            value={token}
            onChangeValue={value => {
              setToken(value);
              setIsValid(true);
            }}
          />
        </View>

        {!isValid && <FormError>{error}</FormError>}
      </View>

      <ModalButtons>
        <ButtonWithLoading
          variant="primary"
          type="button"
          autoFocus
          isDisabled={isLoading}
          isLoading={isLoading}
          onPress={() => {
            void onSubmit();
          }}
        >
          <Trans>Save and continue</Trans>
        </ButtonWithLoading>
      </ModalButtons>
    </>
  );
}
