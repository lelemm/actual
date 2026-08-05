import { inject } from 'vitest';

const serverUrl = inject('contractServerUrl');
const upstreamUrl = inject('simpleFinMockUrl');

const invalidToken = {
  status: 'ok',
  data: {
    error_type: 'INVALID_ACCESS_TOKEN',
    error_code: 'INVALID_ACCESS_TOKEN',
    status: 'rejected',
    reason:
      'Invalid SimpleFIN access token.  Reset the token and re-link any broken accounts.',
  },
};
const serverDown = {
  status: 'ok',
  data: {
    error_type: 'SERVER_DOWN',
    error_code: 'SERVER_DOWN',
    status: 'rejected',
    reason: 'There was an error communicating with SimpleFIN.',
  },
};

type UpstreamRequest = {
  origin: 'primary' | 'redirect';
  method?: string;
  url?: string;
  authorization?: string;
  contentType?: string;
  contentLength?: string;
  body: string;
};

let token: string;

async function post(path: string, body: unknown = {}) {
  return fetch(serverUrl + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-actual-token': token,
    },
    body: JSON.stringify(body),
  });
}

async function setSecret(name: string, value: string) {
  const response = await post('/secret/', { name, value });
  expect(response.status).toBe(200);
}

async function resetSecrets() {
  await Promise.all(
    ['simplefin_token', 'simplefin_accessKey'].map(name =>
      fetch(`${serverUrl}/secret/${name}`, {
        method: 'DELETE',
        headers: { 'x-actual-token': token },
      }),
    ),
  );
  await fetch(upstreamUrl + '/contract/reset', { method: 'POST' });
}

function setupToken(path: string) {
  return Buffer.from(upstreamUrl + path).toString('base64');
}

function accessKey(path: string) {
  const url = new URL(upstreamUrl);
  url.username = 'contract-user';
  url.password = 'contract-password';
  url.pathname = path;
  return url.toString().replace(/\/$/, '');
}

async function upstreamRequests(): Promise<UpstreamRequest[]> {
  return (await (
    await fetch(upstreamUrl + '/contract/requests')
  ).json()) as UpstreamRequest[];
}

async function expectJsonError(response: Response, expected: unknown) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(
    'application/json; charset=utf-8',
  );
  expect(await response.json()).toEqual(expected);
}

function normalizedTimestamp(date: Date) {
  return (date.valueOf() - date.getTimezoneOffset() * 60 * 1000) / 1000;
}

describe.runIf(process.env.ACTUAL_CONTRACT_VARIANT === 'simplefin')(
  'SimpleFIN HTTP contract',
  () => {
    beforeAll(async () => {
      const bootstrap = await fetch(serverUrl + '/account/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'contract-password' }),
      });
      token = ((await bootstrap.json()) as { data: { token: string } }).data
        .token;
    });

    beforeEach(resetSecrets);

    it('preserves status and rejects malformed claim tokens without upstream traffic', async () => {
      expect(await (await post('/simplefin/status')).json()).toEqual({
        status: 'ok',
        data: { configured: false },
      });

      await setSecret('simplefin_token', '');
      expect(await (await post('/simplefin/status')).json()).toEqual({
        status: 'ok',
        data: { configured: true },
      });

      for (const malformed of [
        '%%%',
        Buffer.from('not a URL').toString('base64'),
        Buffer.from('ftp://127.0.0.1/claim').toString('base64'),
      ]) {
        await setSecret('simplefin_token', malformed);
        await expectJsonError(await post('/simplefin/accounts'), invalidToken);
      }

      await setSecret('simplefin_token', 'Forbidden (was it already claimed?)');
      expect(await (await post('/simplefin/status')).json()).toEqual({
        status: 'ok',
        data: { configured: false },
      });
      expect(await upstreamRequests()).toEqual([]);
    });

    it('always blocks link-local claim targets without upstream traffic', async () => {
      for (const target of [
        'http://169.254.169.254/latest/meta-data/',
        'http://[::ffff:169.254.169.254]/latest/meta-data/',
      ]) {
        await setSecret(
          'simplefin_token',
          Buffer.from(target).toString('base64'),
        );
        await expectJsonError(await post('/simplefin/accounts'), serverDown);
      }
      expect(await upstreamRequests()).toEqual([]);
    });

    it('claims with an empty POST, trims and persists the access key, then lists balances', async () => {
      await setSecret('simplefin_token', setupToken('/claim'));

      expect(await (await post('/simplefin/accounts')).json()).toMatchObject({
        status: 'ok',
        data: { accounts: [{ id: 'contract-account' }] },
      });
      expect(
        (
          await fetch(serverUrl + '/secret/simplefin_accessKey', {
            headers: { 'x-actual-token': token },
          })
        ).status,
      ).toBe(204);

      const requests = await upstreamRequests();
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        origin: 'primary',
        method: 'POST',
        url: '/claim',
        body: '',
      });
      expect(requests[0].authorization).toBeUndefined();
      expect(requests[0].contentType).toBeUndefined();
      expect(requests[1]).toMatchObject({
        origin: 'primary',
        method: 'GET',
        url: '/simplefin/accounts?balances-only=1',
        authorization: `Basic ${Buffer.from(
          'contract-user:contract-password',
        ).toString('base64')}`,
        body: '',
      });
      expect(requests[1].contentType).toBeUndefined();

      expect(await (await post('/simplefin/accounts')).json()).toMatchObject({
        status: 'ok',
        data: { accounts: [{ id: 'contract-account' }] },
      });
      expect(await upstreamRequests()).toHaveLength(3);
      expect(
        (await upstreamRequests()).filter(request => request.method === 'POST'),
      ).toHaveLength(1);
    });

    it.each([
      ['/claim-forbidden', invalidToken],
      ['/claim-redirect', serverDown],
      ['/claim-502', serverDown],
      ['/claim-json-error', serverDown],
      ['/claim-invalid-access-key', invalidToken],
    ])(
      'maps the %s claim response without persisting it',
      async (path, expected) => {
        await setSecret('simplefin_token', setupToken(path));

        await expectJsonError(await post('/simplefin/accounts'), expected);
        expect(
          (
            await fetch(serverUrl + '/secret/simplefin_accessKey', {
              headers: { 'x-actual-token': token },
            })
          ).status,
        ).toBe(404);
        expect(await upstreamRequests()).toEqual([
          expect.objectContaining({
            origin: 'primary',
            method: 'POST',
            url: path,
            body: '',
          }),
        ]);
      },
    );

    it('preserves upstream status and body interpretation', async () => {
      for (const [providerPath, expected] of [
        ['/simplefin/plain-error', serverDown],
        ['/simplefin/invalid-json', serverDown],
        ['/simplefin/forbidden', serverDown],
        ['/simplefin/json-error', { status: 'ok', data: {} }],
      ] as const) {
        await setSecret('simplefin_accessKey', accessKey(providerPath));
        await expectJsonError(await post('/simplefin/accounts'), expected);
      }

      await setSecret(
        'simplefin_accessKey',
        accessKey('/simplefin/non-object-array'),
      );
      expect(await (await post('/simplefin/accounts')).json()).toEqual({
        status: 'ok',
        data: {},
      });
      for (const path of [
        '/simplefin/non-object-null',
        '/simplefin/non-object-string',
      ]) {
        await setSecret('simplefin_accessKey', accessKey(path));
        await expectJsonError(await post('/simplefin/accounts'), serverDown);
      }

      await setSecret('simplefin_accessKey', accessKey('/simplefin/forbidden'));
      await expectJsonError(
        await post('/simplefin/transactions', {
          accountId: 'contract-account',
          startDate: '2024-01-01',
        }),
        invalidToken,
      );

      await setSecret(
        'simplefin_accessKey',
        accessKey('/simplefin/json-error'),
      );
      await expectJsonError(
        await post('/simplefin/transactions', {
          accountId: 'missing-account',
          startDate: '2024-01-01',
        }),
        {
          status: 'ok',
          data: {
            error_code: 'INTERNAL_ERROR',
            error_type: "Cannot read properties of undefined (reading 'find')",
          },
        },
      );

      await setSecret(
        'simplefin_accessKey',
        accessKey('/simplefin/accounts-without-errors'),
      );
      await expectJsonError(
        await post('/simplefin/transactions', {
          accountId: 'missing-errors-account',
          startDate: '2024-01-01',
        }),
        {
          status: 'ok',
          data: {
            error_code: 'INTERNAL_ERROR',
            error_type: "Cannot read properties of undefined (reading 'find')",
          },
        },
      );
    });

    it('follows same-origin redirects with credentials and permanently drops them cross-origin', async () => {
      await setSecret(
        'simplefin_accessKey',
        accessKey('/simplefin/redirect-same'),
      );
      expect(await (await post('/simplefin/accounts')).json()).toEqual({
        status: 'ok',
        data: { accounts: [{ id: 'same-origin-account' }] },
      });
      const sameOrigin = await upstreamRequests();
      expect(sameOrigin.map(request => request.authorization)).toEqual([
        expect.stringMatching(/^Basic /),
        expect.stringMatching(/^Basic /),
      ]);

      await resetSecrets();
      await setSecret(
        'simplefin_accessKey',
        accessKey('/simplefin/redirect-cross'),
      );
      expect(await (await post('/simplefin/accounts')).json()).toEqual({
        status: 'ok',
        data: {
          accounts: [
            {
              id: 'redirected-account',
              currency: 'USD',
              balance: '10.00',
              'balance-date': 1704067200,
              org: { name: 'Redirect Bank' },
              transactions: [],
            },
          ],
        },
      });
      const crossOrigin = await upstreamRequests();
      expect(crossOrigin.map(request => request.url)).toEqual([
        '/simplefin/redirect-cross/accounts?balances-only=1',
        '/cross/step',
        '/cross/final',
      ]);
      expect(crossOrigin[0].authorization).toMatch(/^Basic /);
      expect(crossOrigin[1].authorization).toBeUndefined();
      expect(crossOrigin[2].authorization).toBeUndefined();

      await resetSecrets();
      await setSecret(
        'simplefin_accessKey',
        accessKey('/simplefin/redirect-link-local'),
      );
      await expectJsonError(await post('/simplefin/accounts'), serverDown);
      expect(await upstreamRequests()).toEqual([
        expect.objectContaining({
          origin: 'primary',
          url: '/simplefin/redirect-link-local/accounts?balances-only=1',
          authorization: expect.stringMatching(/^Basic /),
        }),
      ]);

      await resetSecrets();
      await setSecret(
        'simplefin_accessKey',
        accessKey('/simplefin/redirect-mapped-link-local'),
      );
      await expectJsonError(await post('/simplefin/accounts'), serverDown);
      expect(await upstreamRequests()).toEqual([
        expect.objectContaining({
          origin: 'primary',
          url: '/simplefin/redirect-mapped-link-local/accounts?balances-only=1',
          authorization: expect.stringMatching(/^Basic /),
        }),
      ]);

      await resetSecrets();
      await setSecret(
        'simplefin_accessKey',
        accessKey('/simplefin/redirect-loop'),
      );
      await expectJsonError(await post('/simplefin/accounts'), serverDown);
      const redirectLoop = await upstreamRequests();
      expect(redirectLoop.map(request => request.url)).toEqual([
        '/simplefin/redirect-loop/accounts?balances-only=1',
        '/simplefin/redirect-loop-1',
        '/simplefin/redirect-loop-2',
        '/simplefin/redirect-loop-3',
        '/simplefin/redirect-loop-4',
        '/simplefin/redirect-loop-5',
      ]);
      expect(
        redirectLoop.every(request =>
          request.authorization?.startsWith('Basic '),
        ),
      ).toBe(true);
    });

    it('preserves multi-account queries, filtering, pending truthiness, and per-account errors', async () => {
      await setSecret('simplefin_accessKey', accessKey('/simplefin/edges'));

      const response = await post('/simplefin/transactions', {
        accountId: ['edge-account', 'missing-account'],
        startDate: ['2024-01-02', '2024-01-01'],
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: 'ok',
        data: {
          'edge-account': {
            balances: [
              {
                balanceAmount: { amount: '-12.34', currency: 'CAD' },
                balanceType: 'expected',
                referenceDate: '2024-01-03',
              },
              {
                balanceAmount: { amount: '-12.34', currency: 'CAD' },
                balanceType: 'interimAvailable',
                referenceDate: '2024-01-03',
              },
            ],
            startingBalance: -1234,
            transactions: {
              all: [
                {
                  booked: false,
                  sortOrder: 1704326400,
                  date: '2024-01-04',
                  payeeName: 'Edge Fuel',
                  notes: 'Truthy pending marker',
                  transactionAmount: { amount: '-1.25', currency: 'USD' },
                  transactionId: 'edge-pending',
                  transactedDate: '2024-01-04',
                },
                {
                  booked: true,
                  sortOrder: 1704240000,
                  date: '2024-01-03',
                  payeeName: 'Edge Grocery',
                  notes: 'Booked edge transaction',
                  transactionAmount: { amount: '-2.50', currency: 'USD' },
                  transactionId: 'edge-booked',
                  transactedDate: '2024-01-02',
                  postedDate: '2024-01-03',
                },
              ],
              booked: [
                {
                  booked: true,
                  sortOrder: 1704240000,
                  date: '2024-01-03',
                  payeeName: 'Edge Grocery',
                  notes: 'Booked edge transaction',
                  transactionAmount: { amount: '-2.50', currency: 'USD' },
                  transactionId: 'edge-booked',
                  transactedDate: '2024-01-02',
                  postedDate: '2024-01-03',
                },
              ],
              pending: [
                {
                  booked: false,
                  sortOrder: 1704326400,
                  date: '2024-01-04',
                  payeeName: 'Edge Fuel',
                  notes: 'Truthy pending marker',
                  transactionAmount: { amount: '-1.25', currency: 'USD' },
                  transactionId: 'edge-pending',
                  transactedDate: '2024-01-04',
                },
              ],
            },
          },
          errors: {
            'edge-account': [
              {
                error_type: 'ACCOUNT_NEEDS_ATTENTION',
                error_code: 'ACCOUNT_NEEDS_ATTENTION',
                reason:
                  'The account needs your attention at <a href="https://bridge.simplefin.org/auth/login">SimpleFIN</a>.',
              },
            ],
            'missing-account': [
              {
                error_type: 'ACCOUNT_MISSING',
                error_code: 'ACCOUNT_MISSING',
                reason:
                  'The account "missing-account" was not found. Try unlinking and relinking the account.',
              },
            ],
          },
        },
      });

      const now = new Date();
      const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const expectedQuery = new URLSearchParams([
        ['start-date', String(normalizedTimestamp(new Date('2024-01-01')))],
        ['end-date', String(normalizedTimestamp(endDate))],
        ['pending', '1'],
        ['account', 'edge-account'],
        ['account', 'missing-account'],
      ]);
      expect(await upstreamRequests()).toEqual([
        expect.objectContaining({
          origin: 'primary',
          method: 'GET',
          url: `/simplefin/edges/accounts?${expectedQuery.toString()}`,
          authorization: expect.stringMatching(/^Basic /),
          body: '',
        }),
      ]);
    });

    it('preserves explicit account/start-date validation failures', async () => {
      await setSecret('simplefin_accessKey', accessKey('/simplefin'));

      await expectJsonError(
        await post('/simplefin/transactions', {
          accountId: ['contract-account'],
          startDate: '2024-01-01',
        }),
        {
          status: 'ok',
          data: {
            error_code: 'INTERNAL_ERROR',
            error_type:
              'accountId and startDate must either both be arrays or both be strings',
          },
        },
      );
      await expectJsonError(
        await post('/simplefin/transactions', {
          accountId: ['contract-account'],
          startDate: ['2024-01-01', '2024-01-02'],
        }),
        {
          status: 'ok',
          data: {
            error_code: 'INTERNAL_ERROR',
            error_type:
              'accountId and startDate arrays must be the same length',
          },
        },
      );
      expect(await upstreamRequests()).toEqual([]);
    });
  },
);
