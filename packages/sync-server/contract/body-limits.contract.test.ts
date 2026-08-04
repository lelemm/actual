import { inject } from 'vitest';

const serverUrl = inject('contractServerUrl');
const megabyte = 1024 * 1024;

describe.runIf(process.env.ACTUAL_CONTRACT_VARIANT === 'body-limits')(
  'request body-limit contract',
  () => {
    it('keeps separate JSON, protobuf, and encrypted-file limits', async () => {
      const bootstrap = await fetch(serverUrl + '/account/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'contract-password' }),
      });
      const token = ((await bootstrap.json()) as { data: { token: string } })
        .data.token;

      const oversizedJson = await fetch(serverUrl + '/account/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify('x'.repeat(20 * megabyte)),
      });
      expect(oversizedJson.status).toBe(413);

      const oversizedSync = await fetch(serverUrl + '/sync/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/actual-sync',
          'x-actual-token': token,
        },
        body: new Uint8Array(20 * megabyte + 1),
      });
      expect(oversizedSync.status).toBe(413);

      const acceptedEncrypted = await fetch(
        serverUrl + '/sync/upload-user-file',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/encrypted-file',
            'x-actual-token': token,
            'x-actual-name': 'Large%20contract%20budget',
            'x-actual-file-id': '1123456789abcdef0123456789abcdef',
          },
          body: new Uint8Array(20 * megabyte + 1),
        },
      );
      expect(acceptedEncrypted.status).toBe(200);

      const oversizedEncrypted = await fetch(
        serverUrl + '/sync/upload-user-file',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/encrypted-file',
            'x-actual-token': token,
            'x-actual-name': 'Oversized%20contract%20budget',
            'x-actual-file-id': '2123456789abcdef0123456789abcdef',
          },
          body: new Uint8Array(50 * megabyte + 1),
        },
      );
      expect(oversizedEncrypted.status).toBe(413);
    }, 30_000);
  },
);
