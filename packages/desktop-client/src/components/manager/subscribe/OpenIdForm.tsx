import type { ReactNode } from 'react';
import { useState } from 'react';

import { theme, styles } from '../../../style';
import { ButtonWithLoading } from '../../common/Button';
import { Input } from '../../common/Input';
import { Stack } from '../../common/Stack';
import { FormField, FormLabel } from '../../forms';
import { useServerURL } from '../../ServerContext';

export type OpenIdConfig = {
  issuer: string;
  client_id: string;
  client_secret: string;
  server_hostname: string;
};

type OpenIdCallback = (config: OpenIdConfig) => Promise<void>;

type OpenIdFormProps = {
  onSetOpenId: OpenIdCallback;
  otherButtons?: ReactNode[];
};

export function OpenIdForm({ onSetOpenId, otherButtons }: OpenIdFormProps) {
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const serverUrl = useServerURL();

  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    if (loading) {
      return;
    }

    setLoading(true);
    await onSetOpenId({
      issuer: issuer ?? '',
      client_id: clientId ?? '',
      client_secret: clientSecret ?? '',
      server_hostname: serverUrl ?? '',
    });
    setLoading(false);
  }

  return (
    <Stack direction="column" style={{ marginTop: 10 }}>
      <FormField style={{ flex: 1 }}>
        <FormLabel title="OpenID provider" htmlFor="provider-field" />
        <Input
          placeholder="https://accounts.openid-provider.tld"
          type="text"
          value={issuer}
          onChangeValue={newValue => setIssuer(newValue)}
        />
        <label
          style={{
            ...styles.verySmallText,
            color: theme.pageTextLight,
            marginTop: 5,
          }}
        >
          The OpenID provider URL.
        </label>
      </FormField>
      <FormField style={{ flex: 1 }}>
        <FormLabel title="Client ID" htmlFor="clienid-field" />
        <Input
          type="text"
          value={clientId}
          onChangeValue={newValue => setClientId(newValue)}
        />
        <label
          style={{
            ...styles.verySmallText,
            color: theme.pageTextLight,
            marginTop: 5,
          }}
        >
          The Client ID generated by the OpenID provider.
        </label>
      </FormField>
      <FormField style={{ flex: 1 }}>
        <FormLabel title="Client secret" htmlFor="cliensecret-field" />
        <Input
          type="text"
          value={clientSecret}
          onChangeValue={newValue => setClientSecret(newValue)}
        />
        <label
          style={{
            ...styles.verySmallText,
            color: theme.pageTextLight,
            marginTop: 5,
          }}
        >
          The client secret associated with the ID generated by the OpenID
          provider.
        </label>
      </FormField>

      <Stack
        direction="row"
        justify="flex-end"
        align="center"
        style={{ marginTop: 20 }}
      >
        {otherButtons}
        <ButtonWithLoading type="primary" loading={loading} onClick={onSubmit}>
          OK
        </ButtonWithLoading>
      </Stack>
    </Stack>
  );
}
