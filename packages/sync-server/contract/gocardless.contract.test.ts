import { createHash } from 'node:crypto';

import { inject } from 'vitest';

const serverUrl = inject('contractServerUrl');
const upstreamUrl = inject('goCardlessMockUrl');

async function post(path: string, token: string, body: unknown = {}) {
  return fetch(serverUrl + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-actual-token': token,
    },
    body: JSON.stringify(body),
  });
}

type UpstreamRequest = {
  method?: string;
  url?: string;
  authorization?: string;
  body?: Record<string, unknown>;
};

async function upstreamRequests(): Promise<UpstreamRequest[]> {
  return (await (
    await fetch(upstreamUrl.replace(/\/api\/v2$/, '') + '/contract/requests')
  ).json()) as UpstreamRequest[];
}

async function resetUpstreamRequests() {
  expect(
    await fetch(upstreamUrl.replace(/\/api\/v2$/, '') + '/contract/reset', {
      method: 'POST',
    }),
  ).toMatchObject({ status: 204 });
}

async function waitForUpstreamRequest(url: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await upstreamRequests()).some(request => request.url === url)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for GoCardless request: ${url}`);
}

let sharedToken: string;
let currentSecretId: string;
let currentSecretKey: string;
let credentialSequence = 0;

async function setSecrets(secretId: string, secretKey: string) {
  for (const [name, value] of [
    ['gocardless_secretId', secretId],
    ['gocardless_secretKey', secretKey],
  ]) {
    expect((await post('/secret/', sharedToken, { name, value })).status).toBe(
      200,
    );
  }
}

describe.runIf(process.env.ACTUAL_CONTRACT_VARIANT === 'gocardless')(
  'GoCardless HTTP contract',
  () => {
    beforeAll(async () => {
      const bootstrap = await fetch(serverUrl + '/account/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'contract-password' }),
      });
      sharedToken = ((await bootstrap.json()) as { data: { token: string } })
        .data.token;
    });

    beforeEach(async () => {
      credentialSequence += 1;
      currentSecretId = `contract-secret-id-${credentialSequence}`;
      currentSecretKey = `contract-secret-key-${credentialSequence}`;
      await setSecrets(currentSecretId, currentSecretKey);
      await resetUpstreamRequests();
    });

    it('preserves route authentication, validation, redirects, and response shapes', async () => {
      const link = await fetch(serverUrl + '/gocardless/link');
      expect(link.status).toBe(200);
      expect(link.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await link.text()).toBe(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Actual</title>
  </head>
  <body>
    <script>
      window.close();
    </script>

    <p>Please wait...</p>
    <p>
      The window should close automatically. If nothing happened you can close
      this window or tab.
    </p>
  </body>
</html>`);

      for (const path of [
        '/status',
        '/create-web-token',
        '/get-accounts',
        '/get-banks',
        '/remove-account',
        '/transactions',
        '/link',
      ]) {
        const unauthorized = await post(`/gocardless${path}`, 'not-a-token');
        expect(unauthorized.status).toBe(401);
        expect(unauthorized.headers.get('content-type')).toBe(
          'application/json; charset=utf-8',
        );
        expect(await unauthorized.json()).toEqual({
          status: 'error',
          reason: 'unauthorized',
          details: 'token-not-found',
        });
      }

      const unsupported = await post('/gocardless/link', sharedToken);
      expect(unsupported.status).toBe(404);
      expect(unsupported.headers.get('content-type')).toBe(
        'text/html; charset=utf-8',
      );
      expect(await unsupported.text()).toBe(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Error</title>
</head>
<body>
<pre>Cannot POST /gocardless/link</pre>
</body>
</html>
`);

      const bodyToken = await fetch(serverUrl + '/gocardless/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: sharedToken }),
      });
      expect(bodyToken.status).toBe(200);
      expect(bodyToken.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      expect(await bodyToken.json()).toEqual({
        status: 'ok',
        data: { configured: true },
      });

      for (const contentType of [
        'Application/JSON',
        'application/json ; charset=utf-8',
      ]) {
        const mediaType = await fetch(serverUrl + '/gocardless/status', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: JSON.stringify({ token: sharedToken }),
        });
        expect(mediaType.status).toBe(200);
        expect(await mediaType.json()).toEqual({
          status: 'ok',
          data: { configured: true },
        });
      }

      const emptyBody = await fetch(
        serverUrl + '/gocardless/create-web-token',
        {
          method: 'POST',
          headers: { 'x-actual-token': sharedToken },
        },
      );
      expect(emptyBody.status).toBe(200);
      expect(await emptyBody.json()).toEqual({
        status: 'ok',
        data: {
          error_code: 'INTERNAL_ERROR',
          error_type: 'Invalid GoCardless identifier: undefined',
        },
      });

      for (const [path, key] of [
        ['/gocardless/create-web-token', 'institutionId'],
        ['/gocardless/get-accounts', 'requisitionId'],
        ['/gocardless/get-banks', 'country'],
        ['/gocardless/remove-account', 'requisitionId'],
      ] as const) {
        for (const [value, rendered] of [
          [null, 'null'],
          [true, 'true'],
          [42, '42'],
          [['safe'], 'safe'],
          [{}, '[object Object]'],
          ['', ''],
          ['bad/value', 'bad/value'],
        ] as const) {
          const response = await post(path, sharedToken, { [key]: value });
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({
            status: 'ok',
            data: {
              error_code: 'INTERNAL_ERROR',
              error_type: `Invalid GoCardless identifier: ${rendered}`,
            },
          });
        }
      }

      expect(
        await (
          await post('/gocardless/transactions', sharedToken, {
            requisitionId: 'contract-requisition',
          })
        ).json(),
      ).toEqual({
        status: 'ok',
        data: {
          error_code: 'INTERNAL_ERROR',
          error_type: 'Invalid GoCardless identifier: undefined',
        },
      });

      for (const origin of [undefined, 'file://actual']) {
        const response = await fetch(
          serverUrl + '/gocardless/create-web-token',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-actual-token': sharedToken,
              ...(origin ? { origin } : {}),
            },
            body: JSON.stringify({ institutionId: 'CONTRACT_BANK' }),
          },
        );
        expect(await response.json()).toEqual({
          status: 'ok',
          data: {
            error_code: 'INTERNAL_ERROR',
            error_type: 'Invalid Origin header',
          },
        });
      }

      const electron = await fetch(serverUrl + '/gocardless/create-web-token', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': sharedToken,
          origin: 'app://actual',
        },
        body: JSON.stringify({ institutionId: 'CONTRACT_BANK' }),
      });
      expect(await electron.json()).toMatchObject({ status: 'ok' });
      expect(
        (await upstreamRequests()).find(
          request =>
            request.method === 'POST' &&
            request.url === '/api/v2/requisitions/',
        )?.body,
      ).toMatchObject({
        redirect: `${serverUrl}/gocardless/link`,
      });

      const malformed = await fetch(serverUrl + '/gocardless/get-banks', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': sharedToken,
        },
        body: '{',
      });
      expect(malformed.status).toBe(400);
      expect(malformed.headers.get('content-type')).toBe(
        'text/html; charset=utf-8',
      );

      expect(
        await (
          await post('/gocardless/remove-account', sharedToken, {
            requisitionId: 'contract-delete-rejected',
          })
        ).json(),
      ).toEqual({
        status: 'error',
        data: {
          data: {
            summary: 'Requisition is still linked',
            detail: 'Contract deletion was rejected',
          },
          reason: 'Can not delete requisition',
        },
      });

      const truthyDemo = (await (
        await post('/gocardless/get-banks', sharedToken, {
          country: 'FI',
          showDemo: 'false',
        })
      ).json()) as { data: Array<{ id: string }> };
      expect(truthyDemo.data[0].id).toBe('SANDBOXFINANCE_SFIN0000');

      const falsyBalance = (await (
        await post('/gocardless/transactions', sharedToken, {
          requisitionId: 'contract-requisition',
          accountId: 'contract-gocardless-account',
          includeBalance: 0,
        })
      ).json()) as { data: Record<string, unknown> };
      expect(falsyBalance.data).not.toHaveProperty('balances');
      expect(falsyBalance.data).not.toHaveProperty('startingBalance');
    });

    it('preserves token reuse, requisitions, accounts, transactions, and deletion', async () => {
      const banks = await (
        await post('/gocardless/get-banks', sharedToken, {
          country: 'FI',
          showDemo: true,
        })
      ).json();
      expect(banks).toEqual({
        status: 'ok',
        data: [
          {
            id: 'SANDBOXFINANCE_SFIN0000',
            name: 'DEMO bank (used for testing bank-sync)',
          },
          {
            id: 'CONTRACT_BANK',
            name: 'Contract Bank',
            bic: 'CONTRACTBIC',
            transaction_total_days: '730',
            max_access_valid_for_days: '90',
            countries: ['FI'],
            supported_features: ['account_selection'],
          },
        ],
      });

      const created = await fetch(serverUrl + '/gocardless/create-web-token', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': sharedToken,
          origin: 'https://actual.example',
        },
        body: JSON.stringify({ institutionId: 'CONTRACT_BANK' }),
      });
      expect(await created.json()).toEqual({
        status: 'ok',
        data: {
          link: 'https://contract-bank.example/authorize',
          requisitionId: 'contract-requisition',
        },
      });

      const accounts = await (
        await post('/gocardless/get-accounts', sharedToken, {
          requisitionId: 'contract-requisition',
        })
      ).json();
      expect(accounts).toMatchObject({
        status: 'ok',
        data: {
          id: 'contract-requisition',
          status: 'LN',
          institution_id: 'CONTRACT_BANK',
          accounts: [
            {
              account_id: 'contract-gocardless-account',
              name: 'Contract checking (XXX 7890) EUR',
              institution: { id: 'CONTRACT_BANK', name: 'Contract Bank' },
              mask: '7890',
              iban: createHash('sha256')
                .update('FI001234567890')
                .digest('base64'),
              official_name: 'Current account',
              type: 'checking',
            },
          ],
        },
      });

      const transactions = await (
        await post('/gocardless/transactions', sharedToken, {
          requisitionId: 'contract-requisition',
          accountId: 'contract-gocardless-account',
          startDate: '2026-07-01',
          endDate: '2026-07-31',
        })
      ).json();
      expect(transactions).toMatchObject({
        status: 'ok',
        data: {
          institutionId: 'CONTRACT_BANK',
          startingBalance: 101000,
          balances: [
            {
              balanceAmount: { amount: '1000.00', currency: 'EUR' },
              balanceType: 'closingBooked',
            },
          ],
          transactions: {
            booked: [
              {
                transactionId: 'gocardless-booked',
                date: '2026-07-30',
                payeeName: 'Contract Grocery',
                notes: 'Weekly shop',
              },
            ],
            pending: [
              {
                transactionId: 'gocardless-pending',
                date: '2026-07-31',
                payeeName: 'Contract Fuel',
              },
            ],
            all: [
              { transactionId: 'gocardless-pending', booked: false },
              { transactionId: 'gocardless-booked', booked: true },
            ],
          },
        },
      });

      const withoutBalance = (await (
        await post('/gocardless/transactions', sharedToken, {
          requisitionId: 'contract-requisition',
          accountId: 'contract-gocardless-account',
          startDate: '2026-07-01',
          endDate: '2026-07-31',
          includeBalance: false,
        })
      ).json()) as { status: string; data: Record<string, unknown> };
      expect(withoutBalance).toMatchObject({
        status: 'ok',
        data: { institutionId: 'CONTRACT_BANK' },
      });
      expect(withoutBalance.data).not.toHaveProperty('balances');
      expect(withoutBalance.data).not.toHaveProperty('startingBalance');

      expect(
        await (
          await post('/gocardless/remove-account', sharedToken, {
            requisitionId: 'contract-requisition',
          })
        ).json(),
      ).toEqual({
        status: 'ok',
        data: {
          summary: 'Requisition deleted',
          detail: 'Contract requisition deleted',
        },
      });

      const requests = (await (
        await fetch(
          upstreamUrl.replace(/\/api\/v2$/, '') + '/contract/requests',
        )
      ).json()) as Array<{
        method: string;
        url: string;
        authorization?: string;
        body?: Record<string, unknown>;
      }>;
      expect(
        requests.filter(request => request.url === '/api/v2/token/new/'),
      ).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: 'POST',
        body: {
          secret_id: currentSecretId,
          secret_key: currentSecretKey,
        },
      });
      for (const request of requests.slice(1)) {
        expect(request.authorization).toBe(
          'Bearer contract.eyJleHAiOjQxMDI0NDQ4MDB9.signature',
        );
      }
      const agreement = requests.find(
        request => request.url === '/api/v2/agreements/enduser/',
      );
      expect(agreement?.body).toMatchObject({
        institution_id: 'CONTRACT_BANK',
        max_historical_days: 730,
        access_valid_for_days: 90,
        access_scope: ['balances', 'details', 'transactions'],
      });
      const requisition = requests.find(
        request =>
          request.method === 'POST' && request.url === '/api/v2/requisitions/',
      );
      expect(requisition?.body).toMatchObject({
        redirect: 'https://actual.example/gocardless/link',
        institution_id: 'CONTRACT_BANK',
        agreement: 'contract-agreement',
        user_language: 'en',
        redirect_immediate: false,
        account_selection: true,
      });
      expect(
        requests.filter(request =>
          request.url.startsWith(
            '/api/v2/accounts/contract-gocardless-account/transactions/',
          ),
        ),
      ).toHaveLength(2);
    });

    it('maps upstream failures to typed transaction error payloads', async () => {
      const transactionError = async (accountId: string) =>
        (await post('/gocardless/transactions', sharedToken, {
          requisitionId: 'contract-errors-requisition',
          accountId,
          includeBalance: false,
        }).then(response => response.json())) as {
          status: string;
          data: Record<string, unknown>;
        };

      const eua = await transactionError('contract-eua-account');
      expect(eua).toEqual({
        status: 'ok',
        data: {
          error_type: 'ITEM_ERROR',
          error_code: 'ITEM_LOGIN_REQUIRED',
          status: 'expired',
          reason: 'Access to account has expired as set in End User Agreement',
          details: expect.objectContaining({
            response: expect.objectContaining({ status: 401 }),
          }),
          rateLimitHeaders: {},
        },
      });

      const invalidToken = await transactionError(
        'contract-invalid-token-account',
      );
      expect(invalidToken).toEqual({
        status: 'ok',
        data: {
          error_type: 'UNKNOWN',
          error_code: 'UNKNOWN',
          reason: 'Something went wrong',
          details: expect.objectContaining({
            response: expect.objectContaining({ status: 401 }),
          }),
          rateLimitHeaders: {},
        },
      });

      const rateLimited = await transactionError('contract-ratelimit-account');
      expect(rateLimited).toEqual({
        status: 'ok',
        data: {
          error_type: 'RATE_LIMIT_EXCEEDED',
          error_code: 'NORDIGEN_ERROR',
          status: 'rejected',
          reason: 'Rate limit exceeded',
          details: expect.objectContaining({
            response: expect.objectContaining({ status: 429 }),
          }),
          rateLimitHeaders: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '100',
          },
        },
      });

      const unknown = await transactionError('contract-unknown-account');
      expect(unknown).toEqual({
        status: 'ok',
        data: {
          error_type: 'UNKNOWN',
          error_code: 'UNKNOWN',
          reason: 'Something went wrong',
          details: expect.objectContaining({
            response: expect.objectContaining({ status: 500 }),
          }),
          rateLimitHeaders: {},
        },
      });

      const unmapped = await transactionError('contract-unmapped-account');
      expect(unmapped).toEqual({
        status: 'ok',
        data: {
          error_type: 'SYNC_ERROR',
          error_code: 'NORDIGEN_ERROR',
          details: expect.objectContaining({
            response: expect.objectContaining({ status: 502 }),
          }),
          rateLimitHeaders: {},
        },
      });

      const notLinked = (await (
        await post('/gocardless/transactions', sharedToken, {
          requisitionId: 'contract-errors-requisition',
          accountId: 'contract-gocardless-account',
        })
      ).json()) as { status: string; data: Record<string, unknown> };
      expect(notLinked).toEqual({
        status: 'ok',
        data: {
          error_type: 'INVALID_INPUT',
          error_code: 'INVALID_ACCESS_TOKEN',
          status: 'rejected',
          reason: 'Account not linked with this requisition',
          details: {
            accountId: 'contract-gocardless-account',
            requisitionId: 'contract-errors-requisition',
          },
          rateLimitHeaders: {},
        },
      });

      const pendingRequisition = (await (
        await post('/gocardless/transactions', sharedToken, {
          requisitionId: 'contract-pending-requisition',
          accountId: 'contract-gocardless-account',
        })
      ).json()) as { status: string; data: Record<string, unknown> };
      expect(pendingRequisition).toEqual({
        status: 'ok',
        data: {
          error_type: 'ITEM_ERROR',
          error_code: 'ITEM_LOGIN_REQUIRED',
          status: 'expired',
          reason: 'Access to account has expired as set in End User Agreement',
          details: { requisitionStatus: 'CR' },
          rateLimitHeaders: {},
        },
      });

      expect(
        await (
          await post('/gocardless/get-accounts', sharedToken, {
            requisitionId: 'contract-pending-requisition',
          })
        ).json(),
      ).toEqual({ status: 'ok', requisitionStatus: 'CR' });

      expect(
        await (
          await post('/gocardless/get-accounts', sharedToken, {
            requisitionId: 'contract-missing-requisition',
          })
        ).json(),
      ).toEqual({
        status: 'ok',
        data: {
          error_code: 'INTERNAL_ERROR',
          error_type: 'Resource not found',
        },
      });
    });

    it('falls back to conservative agreement limits when rejected', async () => {
      const before = await upstreamRequests();
      const created = await fetch(serverUrl + '/gocardless/create-web-token', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': sharedToken,
          origin: 'https://actual.example',
        },
        body: JSON.stringify({ institutionId: 'CONTRACT_BANK_STRICT' }),
      });
      expect(await created.json()).toEqual({
        status: 'ok',
        data: {
          link: 'https://strict-bank.example/authorize',
          requisitionId: 'contract-strict-requisition',
        },
      });

      const after = await upstreamRequests();
      const agreements = after
        .slice(before.length)
        .filter(request => request.url === '/api/v2/agreements/enduser/');
      expect(agreements).toHaveLength(2);
      expect(agreements[0].body).toMatchObject({
        institution_id: 'CONTRACT_BANK_STRICT',
        max_historical_days: 400,
        access_valid_for_days: 60,
      });
      expect(agreements[1].body).toMatchObject({
        institution_id: 'CONTRACT_BANK_STRICT',
        max_historical_days: 89,
        access_valid_for_days: 90,
      });
    });

    it('coerces string agreement limits with JavaScript Number semantics', async () => {
      for (const [suffix, expected] of [
        ['WHITESPACE', 0],
        ['FRACTION', 1.5],
        ['EXPONENT', 100],
        ['HEX', 16],
        ['BIGHEX', 18_446_744_073_709_552_000],
        ['UNEVENBIGHEX', 166_049_801_551_776_220],
        ['EMPTY', 0],
      ] as const) {
        const before = await upstreamRequests();
        const created = await fetch(
          serverUrl + '/gocardless/create-web-token',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-actual-token': sharedToken,
              origin: 'https://actual.example',
            },
            body: JSON.stringify({
              institutionId: `CONTRACT_NUMBER_${suffix}`,
            }),
          },
        );
        expect(await created.json()).toMatchObject({ status: 'ok' });

        const agreement = (await upstreamRequests())
          .slice(before.length)
          .find(request => request.url === '/api/v2/agreements/enduser/');
        expect(agreement?.body).toMatchObject({
          institution_id: `CONTRACT_NUMBER_${suffix}`,
          max_historical_days: expected,
          access_valid_for_days: expected,
        });
      }
    });

    it('deduplicates institution lookups and refetches requisitions for balance reads', async () => {
      let before = await upstreamRequests();
      const accounts = await (
        await post('/gocardless/get-accounts', sharedToken, {
          requisitionId: 'contract-multi-requisition',
        })
      ).json();
      expect(accounts).toMatchObject({
        status: 'ok',
        data: {
          id: 'contract-multi-requisition',
          accounts: [
            { account_id: 'contract-gocardless-account' },
            {
              account_id: 'contract-second-account',
              name: 'Contract savings (XXX 9999) EUR',
              institution: { id: 'CONTRACT_BANK', name: 'Contract Bank' },
              mask: '9999',
              iban: createHash('sha256')
                .update('FI009999999999')
                .digest('base64'),
              official_name: 'Savings account',
              type: 'checking',
            },
          ],
        },
      });
      let after = await upstreamRequests();
      expect(
        after
          .slice(before.length)
          .filter(
            request =>
              request.method === 'GET' &&
              request.url === '/api/v2/institutions/CONTRACT_BANK/',
          ),
      ).toHaveLength(1);

      before = after;
      await post('/gocardless/transactions', sharedToken, {
        requisitionId: 'contract-requisition',
        accountId: 'contract-gocardless-account',
        startDate: '2026-07-01',
        endDate: '2026-07-31',
      });
      after = await upstreamRequests();
      expect(
        after
          .slice(before.length)
          .filter(
            request =>
              request.method === 'GET' &&
              request.url === '/api/v2/requisitions/contract-requisition/',
          ),
      ).toHaveLength(2);

      before = after;
      await post('/gocardless/transactions', sharedToken, {
        requisitionId: 'contract-requisition',
        accountId: 'contract-gocardless-account',
        startDate: '2026-07-01',
        endDate: '2026-07-31',
        includeBalance: false,
      });
      after = await upstreamRequests();
      expect(
        after
          .slice(before.length)
          .filter(
            request =>
              request.method === 'GET' &&
              request.url === '/api/v2/requisitions/contract-requisition/',
          ),
      ).toHaveLength(1);
    });

    it('dispatches deduplicated institution lookups concurrently', async () => {
      expect(
        await (
          await post('/gocardless/get-accounts', sharedToken, {
            requisitionId: 'contract-concurrent-requisition',
          })
        ).json(),
      ).toMatchObject({ status: 'ok' });

      const requests = await upstreamRequests();
      expect(
        requests.filter(request =>
          request.url?.match(
            /^\/api\/v2\/institutions\/CONTRACT_CONCURRENT_[AB]\/$/,
          ),
        ),
      ).toHaveLength(2);
    }, 3_000);

    it('does not cancel transaction work when the balance request fails first', async () => {
      expect(
        await (
          await post('/gocardless/transactions', sharedToken, {
            requisitionId: 'contract-balance-failure-requisition',
            accountId: 'contract-balance-failure-account',
          })
        ).json(),
      ).toMatchObject({ status: 'ok' });

      await waitForUpstreamRequest(
        '/contract/events/balance-failure-transactions-complete',
      );
    });

    it('surfaces token endpoint failures and regenerates expired tokens', async () => {
      await post('/gocardless/get-banks', sharedToken, { country: 'FI' });
      const alternateSecretId = `${currentSecretId}-alternate`;
      const alternateSecretKey = `${currentSecretKey}-alternate`;
      await setSecrets(alternateSecretId, alternateSecretKey);
      await post('/gocardless/get-banks', sharedToken, { country: 'FI' });
      await setSecrets(currentSecretId, currentSecretKey);
      await post('/gocardless/get-banks', sharedToken, { country: 'FI' });

      let requests = await upstreamRequests();
      expect(
        requests.filter(
          request =>
            request.url === '/api/v2/token/new/' &&
            request.body?.secret_id === currentSecretId,
        ),
      ).toHaveLength(1);
      expect(
        requests.filter(
          request =>
            request.url === '/api/v2/token/new/' &&
            request.body?.secret_id === alternateSecretId,
        ),
      ).toHaveLength(1);

      await setSecrets('contract-invalid-secret-id', 'contract-invalid-key');
      expect(
        await (
          await post('/gocardless/get-banks', sharedToken, { country: 'FI' })
        ).json(),
      ).toEqual({
        status: 'ok',
        data: {
          error_code: 'INTERNAL_ERROR',
          error_type: 'Invalid provided parameters',
        },
      });

      await setSecrets('contract-expired-secret-id', 'contract-expired-key');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(
          await (
            await post('/gocardless/get-banks', sharedToken, { country: 'FI' })
          ).json(),
        ).toMatchObject({ status: 'ok' });
      }
      requests = await upstreamRequests();
      expect(
        requests.filter(
          request =>
            request.url === '/api/v2/token/new/' &&
            request.body?.secret_id === 'contract-expired-secret-id',
        ),
      ).toHaveLength(2);
      const expiredBearer = requests
        .filter(request => request.url === '/api/v2/institutions/?country=FI')
        .map(request => request.authorization)
        .filter(authorization =>
          authorization?.startsWith('Bearer contract-expired.'),
        );
      expect(expiredBearer).toHaveLength(2);

      const beforeNestedRequest = requests.length;
      await post('/gocardless/transactions', sharedToken, {
        requisitionId: 'contract-requisition',
        accountId: 'contract-gocardless-account',
      });
      requests = await upstreamRequests();
      expect(
        requests
          .slice(beforeNestedRequest)
          .filter(
            request =>
              request.url === '/api/v2/token/new/' &&
              request.body?.secret_id === 'contract-expired-secret-id',
          ),
      ).toHaveLength(2);

      await setSecrets(currentSecretId, currentSecretKey);
      await post('/gocardless/get-banks', sharedToken, { country: 'FI' });
      requests = await upstreamRequests();
      expect(
        requests.filter(
          request =>
            request.url === '/api/v2/token/new/' &&
            request.body?.secret_id === currentSecretId,
        ),
      ).toHaveLength(1);
    });
  },
);
