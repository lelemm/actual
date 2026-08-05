import { inject } from 'vitest';

const serverUrl = inject('contractServerUrl');
const pluggyMockUrl = inject('pluggyMockUrl');
const fileId = '11111111111111111111111111111111';

type UpstreamRequest = {
  method: string;
  url: string;
  apiKey?: string;
  contentType?: string;
  userAgent?: string;
  accept?: string;
  acceptEncoding?: string;
  body: string;
  receivedAt: number;
};

async function request(path: string, init?: RequestInit) {
  return fetch(serverUrl + path, init);
}

async function resetUpstream() {
  await fetch(pluggyMockUrl + '/contract/reset', { method: 'POST' });
}

async function upstreamRequests() {
  return (await (
    await fetch(pluggyMockUrl + '/contract/requests')
  ).json()) as UpstreamRequest[];
}

async function setSecret(
  token: string,
  name: string,
  value: string,
  budgetFileId?: string,
) {
  const response = await request('/secret/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-actual-token': token,
      ...(budgetFileId ? { 'x-actual-file-id': budgetFileId } : {}),
    },
    body: JSON.stringify({ name, value }),
  });
  expect(response.status).toBe(200);
}

async function setCredentials(
  token: string,
  clientId: string,
  clientSecret: string,
  itemIds: string,
  budgetFileId?: string,
) {
  await setSecret(token, 'pluggyai_clientId', clientId, budgetFileId);
  await setSecret(token, 'pluggyai_clientSecret', clientSecret, budgetFileId);
  await setSecret(token, 'pluggyai_itemIds', itemIds, budgetFileId);
}

async function postPluggy(
  token: string,
  path: string,
  body?: unknown,
  budgetFileId?: string,
) {
  return request('/pluggyai/' + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-actual-token': token,
      ...(budgetFileId ? { 'x-actual-file-id': budgetFileId } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
}

describe.runIf(process.env.ACTUAL_CONTRACT_VARIANT === 'pluggy')(
  'Pluggy provider contract',
  () => {
    let token: string;

    beforeAll(async () => {
      const bootstrap = await request('/account/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'pluggy-contract-password' }),
      });
      const body = (await bootstrap.json()) as {
        data: { token: string };
      };
      token = body.data.token;
    });

    it('selects sandbox, global, and per-budget credentials with isolated clients', async () => {
      await resetUpstream();
      const unconfigured = await postPluggy(token, 'status');
      expect(unconfigured.status).toBe(200);
      expect(unconfigured.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      expect(await unconfigured.json()).toEqual({
        status: 'ok',
        data: { configured: false, source: null },
      });

      const invalid = await postPluggy(token, 'status', {}, 'not/a/file');
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        status: 'error',
        reason: 'invalid-file-id',
        details: 'invalid fileId',
      });

      await setCredentials(
        token,
        'scope-global-client',
        'scope-global-secret',
        'global-item, credit-item',
      );
      await setCredentials(
        token,
        'scope-budget-client',
        'scope-budget-secret',
        ' budget-item, ',
        fileId,
      );

      expect(await (await postPluggy(token, 'status')).json()).toEqual({
        status: 'ok',
        data: { configured: true, source: 'global' },
      });
      expect(
        await (await postPluggy(token, 'status', {}, fileId)).json(),
      ).toEqual({
        status: 'ok',
        data: { configured: true, source: 'per-budget-file' },
      });

      expect(
        await (await postPluggy(token, 'accounts', {}, fileId)).json(),
      ).toMatchObject({
        status: 'ok',
        data: {
          accounts: [{ id: 'budget-account', itemId: 'budget-item' }],
        },
      });
      expect(await (await postPluggy(token, 'accounts')).json()).toMatchObject({
        status: 'ok',
        data: {
          accounts: [
            { id: 'global-item-account', itemId: 'global-item' },
            { id: 'credit-account', itemId: 'credit-item' },
          ],
        },
      });

      const upstream = await upstreamRequests();
      const authBodies = upstream
        .filter(entry => entry.url === '/auth')
        .map(entry => JSON.parse(entry.body));
      expect(authBodies).toEqual([
        {
          clientId: 'scope-budget-client',
          clientSecret: 'scope-budget-secret',
          nonExpiring: false,
        },
        {
          clientId: 'scope-global-client',
          clientSecret: 'scope-global-secret',
          nonExpiring: false,
        },
      ]);
      for (const entry of upstream.filter(entry => entry.method === 'GET')) {
        expect(entry.contentType).toBe('application/json');
        expect(entry.apiKey).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
      }
    }, 15_000);

    it('reuses valid tokens, refreshes expired tokens, and isolates changed credentials', async () => {
      await resetUpstream();
      await setCredentials(
        token,
        'expired-client',
        'expired-secret',
        'global-item',
      );
      for (let index = 0; index < 3; index += 1) {
        expect((await postPluggy(token, 'accounts')).status).toBe(200);
      }
      let upstream = await upstreamRequests();
      expect(upstream.filter(entry => entry.url === '/auth')).toHaveLength(2);
      const accountKeys = upstream
        .filter(entry => entry.url?.startsWith('/accounts?'))
        .map(entry => entry.apiKey);
      expect(accountKeys[0]).not.toBe(accountKeys[1]);
      expect(accountKeys[1]).toBe(accountKeys[2]);

      await setCredentials(
        token,
        'changed-client',
        'changed-secret',
        'global-item',
      );
      expect((await postPluggy(token, 'accounts')).status).toBe(200);
      upstream = await upstreamRequests();
      expect(
        upstream
          .filter(entry => entry.url === '/auth')
          .map(entry => JSON.parse(entry.body).clientId),
      ).toEqual(['expired-client', 'expired-client', 'changed-client']);

      await resetUpstream();
      await setCredentials(
        token,
        'shared-cache-client',
        'shared-cache-secret',
        'global-item',
      );
      await setCredentials(
        token,
        'shared-cache-client',
        'shared-cache-secret',
        'budget-item',
        fileId,
      );
      expect((await postPluggy(token, 'accounts')).status).toBe(200);
      expect((await postPluggy(token, 'accounts', {}, fileId)).status).toBe(
        200,
      );
      expect(
        (await upstreamRequests()).filter(entry => entry.url === '/auth'),
      ).toHaveLength(2);
    });

    it('retries 429 responses twice using the provider retry hint', async () => {
      await resetUpstream();
      await setCredentials(token, 'rate-client', 'rate-secret', 'rate-item');
      const response = await postPluggy(token, 'accounts');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: 'ok',
        data: { accounts: [{ id: 'rate-item-account' }] },
      });
      const attempts = (await upstreamRequests()).filter(
        entry => entry.url === '/accounts?itemId=rate-item',
      );
      expect(attempts).toHaveLength(3);
      expect(
        attempts[2].receivedAt - attempts[0].receivedAt,
      ).toBeGreaterThanOrEqual(80);
      expect(attempts[2].receivedAt - attempts[0].receivedAt).toBeLessThan(500);

      await resetUpstream();
      await setCredentials(
        token,
        'flaky-network-client',
        'flaky-network-secret',
        'flaky-network-item',
      );
      expect((await postPluggy(token, 'accounts')).status).toBe(200);
      expect(
        (await upstreamRequests()).filter(entry =>
          entry.url?.includes('itemId=flaky-network-item'),
        ),
      ).toHaveLength(2);

      await resetUpstream();
      await setCredentials(
        token,
        'auth-flaky-network-client',
        'auth-flaky-network-secret',
        'global-item',
      );
      expect((await postPluggy(token, 'accounts')).status).toBe(200);
      expect(
        (await upstreamRequests()).filter(entry => entry.url === '/auth'),
      ).toHaveLength(2);

      for (const itemId of [
        'rate-missing-hint-item',
        'rate-invalid-hint-item',
        'rate-zero-hint-item',
      ]) {
        await resetUpstream();
        await setCredentials(
          token,
          `${itemId}-client`,
          `${itemId}-secret`,
          itemId,
        );
        expect((await postPluggy(token, 'accounts')).status).toBe(200);
        const attempts = (await upstreamRequests()).filter(entry =>
          entry.url?.includes(`itemId=${itemId}`),
        );
        expect(attempts).toHaveLength(3);
        expect(
          attempts[2].receivedAt - attempts[0].receivedAt,
        ).toBeGreaterThanOrEqual(2_900);
      }

      await resetUpstream();
      await setCredentials(
        token,
        'body-reset-client',
        'body-reset-secret',
        'body-reset-item',
      );
      expect((await postPluggy(token, 'accounts')).status).toBe(200);
      expect(
        (await upstreamRequests()).filter(entry =>
          entry.url?.includes('itemId=body-reset-item'),
        ),
      ).toHaveLength(2);
    }, 30_000);

    it('preserves SDK result-shape semantics for valid JSON', async () => {
      await resetUpstream();
      await setCredentials(
        token,
        'result-shapes-client',
        'result-shapes-secret',
        'results-missing-item,results-null-item,results-object-item',
      );
      const response = await postPluggy(token, 'accounts');
      expect(response.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      expect(await response.json()).toEqual({
        status: 'ok',
        data: { accounts: [null, null, { id: 'object-result' }] },
      });
    });

    it('normalizes bank, credit-card, sandbox, booked, and pending transactions', async () => {
      await resetUpstream();
      await setCredentials(
        token,
        'normalization-client',
        'normalization-secret',
        'global-item',
      );

      const bank = await postPluggy(token, 'transactions', {
        accountId: 'bank-account',
        startDate: '2024-01-01',
      });
      expect(bank.status).toBe(200);
      expect(await bank.json()).toEqual({
        status: 'ok',
        data: {
          balances: [
            {
              balanceAmount: { amount: 10013, currency: 'BRL' },
              balanceType: 'expected',
              referenceDate: '2024-03-31',
            },
          ],
          startingBalance: 10013,
          transactions: {
            all: expect.any(Array),
            booked: expect.any(Array),
            pending: expect.any(Array),
          },
        },
      });
      const bankBody = (await (
        await postPluggy(token, 'transactions', {
          accountId: 'bank-account',
          startDate: '2024-01-01',
        })
      ).json()) as {
        data: {
          transactions: {
            all: Array<Record<string, unknown>>;
            booked: Array<Record<string, unknown>>;
            pending: Array<Record<string, unknown>>;
          };
        };
      };
      expect(
        bankBody.data.transactions.all.map(entry => entry.transactionId),
      ).toEqual(['bank-account-pending', 'bank-account-booked']);
      expect(bankBody.data.transactions.booked).toHaveLength(1);
      expect(bankBody.data.transactions.pending).toHaveLength(1);
      expect(bankBody.data.transactions.all).toMatchObject([
        {
          booked: false,
          type: 'CREDIT',
          payeeName: 'payer-document',
          notes: 'Pending transfer',
          transactionAmount: { amount: 5, currency: 'BRL' },
        },
        {
          booked: true,
          type: 'DEBIT',
          payeeName: 'Contract Market',
          notes: 'Raw description',
          transactionAmount: { amount: -12.34, currency: 'BRL' },
        },
      ]);

      const credit = await (
        await postPluggy(token, 'transactions', {
          accountId: 'credit-account',
          startDate: '2024-01-01',
        })
      ).json();
      expect(credit).toMatchObject({
        status: 'ok',
        data: {
          startingBalance: -32146,
          balances: [{ balanceAmount: { amount: -32146, currency: 'BRL' } }],
          transactions: {
            all: [
              {
                transactionId: 'credit-account-pending',
                booked: false,
                transactionAmount: { amount: 5, currency: 'BRL' },
              },
              {
                transactionId: 'credit-account-booked',
                booked: true,
                date: '2024-02-29',
                originalDate: '2024-03-31',
                transactionAmount: { amount: -10.01, currency: 'BRL' },
                'creditCardMetadata.installmentNumber': 2,
              },
            ],
          },
        },
      });

      const sandbox = await (
        await postPluggy(token, 'transactions', {
          accountId: 'sandbox-account',
          startDate: '2024-01-01',
        })
      ).json();
      expect(sandbox).toMatchObject({
        status: 'ok',
        data: {
          transactions: {
            all: [
              { transactionId: 'sandbox-account-pending', sandbox: true },
              { transactionId: 'sandbox-account-booked', sandbox: true },
            ],
          },
        },
      });
      const sandboxQueries = (await upstreamRequests())
        .filter(entry => entry.url?.includes('accountId=sandbox-account'))
        .map(entry => entry.url);
      expect(sandboxQueries[0]).toContain('dateFrom=2000-01-01');
    });

    it('preserves missing account fields and reports missing dates', async () => {
      await resetUpstream();
      await setCredentials(
        token,
        'missing-client',
        'missing-secret',
        'missing-item',
      );
      expect(await (await postPluggy(token, 'accounts')).json()).toEqual({
        status: 'ok',
        data: {
          accounts: [
            {
              id: 'missing-item-account',
              itemId: 'missing-item',
              name: 'missing-item account',
              type: 'BANK',
              balance: null,
              currencyCode: 'BRL',
              updatedAt: null,
            },
          ],
        },
      });

      const missingAccount = await postPluggy(token, 'transactions', {
        accountId: 'missing-account',
        startDate: '2024-01-01',
      });
      expect(missingAccount.status).toBe(200);
      expect(await missingAccount.json()).toEqual({
        status: 'ok',
        data: {
          error: "Cannot read properties of null (reading 'toISOString')",
        },
      });

      const missingTransactionDate = await postPluggy(token, 'transactions', {
        accountId: 'missing-transaction-date-account',
        startDate: '2024-01-01',
      });
      expect(await missingTransactionDate.json()).toEqual({
        status: 'ok',
        data: {
          error: "Cannot read properties of undefined (reading 'toISOString')",
        },
      });

      const invalidDate = await postPluggy(token, 'transactions', {
        accountId: 'invalid-date-account',
        startDate: '2024-01-01',
      });
      expect(await invalidDate.json()).toEqual({
        status: 'ok',
        data: { error: 'Invalid time value' },
      });

      const rolloverDate = await postPluggy(token, 'transactions', {
        accountId: 'rollover-date-account',
        startDate: '2024-01-01',
      });
      expect(await rolloverDate.json()).toMatchObject({
        status: 'ok',
        data: {
          balances: [{ referenceDate: '2024-03-01' }],
        },
      });

      const impossibleDate = await postPluggy(token, 'transactions', {
        accountId: 'impossible-date-account',
        startDate: '2024-01-01',
      });
      expect(await impossibleDate.json()).toEqual({
        status: 'ok',
        data: { error: 'Invalid time value' },
      });

      for (const [accountId, startingBalance] of [
        ['omitted-balance-account', null],
        ['null-balance-account', 0],
        ['nan-balance-account', null],
      ] as const) {
        const response = await postPluggy(token, 'transactions', {
          accountId,
          startDate: '2024-01-01',
        });
        expect(await response.json()).toMatchObject({
          status: 'ok',
          data: {
            startingBalance,
            balances: [{ balanceAmount: { amount: startingBalance } }],
          },
        });
      }
    });

    it('preserves upstream non-2xx, malformed JSON, auth, and network failures', async () => {
      for (const [clientId, itemId, expected] of [
        ['error-client', 'error-item', 'Pluggy accounts failed'],
        [
          'malformed-client',
          'malformed-item',
          `Expected property name or '}' in JSON at position 1 (line 1 column 2) in "${pluggyMockUrl}/accounts?itemId=malformed-item"`,
        ],
        ['network-client', 'network-item', 'socket hang up'],
        [
          'malformed-token-client',
          'malformed-token-item',
          `Unexpected token 'o', "not-json" is not valid JSON in "${pluggyMockUrl}/accounts?itemId=malformed-token-item"`,
        ],
        [
          'malformed-array-client',
          'malformed-array-item',
          `Unexpected end of JSON input in "${pluggyMockUrl}/accounts?itemId=malformed-array-item"`,
        ],
        [
          'malformed-value-client',
          'malformed-value-item',
          `Unexpected token '}', "{"x":}" is not valid JSON in "${pluggyMockUrl}/accounts?itemId=malformed-value-item"`,
        ],
        [
          'malformed-trailing-client',
          'malformed-trailing-item',
          `Unexpected non-whitespace character after JSON at position 4 (line 1 column 5) in "${pluggyMockUrl}/accounts?itemId=malformed-trailing-item"`,
        ],
        [
          'malformed-key-client',
          'malformed-key-item',
          `Expected property name or '}' in JSON at position 1 (line 1 column 2) in "${pluggyMockUrl}/accounts?itemId=malformed-key-item"`,
        ],
        [
          'malformed-string-client',
          'malformed-string-item',
          `Unterminated string in JSON at position 5 (line 1 column 6) in "${pluggyMockUrl}/accounts?itemId=malformed-string-item"`,
        ],
        [
          'malformed-object-string-client',
          'malformed-object-string-item',
          `Unterminated string in JSON at position 7 (line 1 column 8) in "${pluggyMockUrl}/accounts?itemId=malformed-object-string-item"`,
        ],
        [
          'malformed-dangling-escape-client',
          'malformed-dangling-escape-item',
          `Unexpected end of JSON input in "${pluggyMockUrl}/accounts?itemId=malformed-dangling-escape-item"`,
        ],
        [
          'malformed-unicode-escape-client',
          'malformed-unicode-escape-item',
          `Bad Unicode escape in JSON at position 8 (line 1 column 9) in "${pluggyMockUrl}/accounts?itemId=malformed-unicode-escape-item"`,
        ],
        [
          'malformed-partial-unicode-escape-client',
          'malformed-partial-unicode-escape-item',
          `Bad Unicode escape in JSON at position 10 (line 1 column 11) in "${pluggyMockUrl}/accounts?itemId=malformed-partial-unicode-escape-item"`,
        ],
        [
          'malformed-incomplete-true-client',
          'malformed-incomplete-true-item',
          `Unexpected end of JSON input in "${pluggyMockUrl}/accounts?itemId=malformed-incomplete-true-item"`,
        ],
        [
          'malformed-trailing-newline-client',
          'malformed-trailing-newline-item',
          `Expected property name or '}' in JSON at position 2 (line 2 column 1) in "${pluggyMockUrl}/accounts?itemId=malformed-trailing-newline-item"`,
        ],
        [
          'malformed-utf16-client',
          'malformed-utf16-item',
          `Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8) in "${pluggyMockUrl}/accounts?itemId=malformed-utf16-item"`,
        ],
        [
          'malformed-utf16-newline-client',
          'malformed-utf16-newline-item',
          `Expected ',' or '}' after property value in JSON at position 8 (line 2 column 7) in "${pluggyMockUrl}/accounts?itemId=malformed-utf16-newline-item"`,
        ],
        [
          'malformed-array-object-client',
          'malformed-array-object-item',
          `Expected property name or '}' in JSON at position 2 (line 1 column 3) in "${pluggyMockUrl}/accounts?itemId=malformed-array-object-item"`,
        ],
        [
          'malformed-nested-start-client',
          'malformed-nested-start-item',
          `Expected property name or '}' in JSON at position 7 (line 1 column 8) in "${pluggyMockUrl}/accounts?itemId=malformed-nested-start-item"`,
        ],
        [
          'malformed-nested-value-client',
          'malformed-nested-value-item',
          `Expected ',' or '}' after property value in JSON at position 11 (line 1 column 12) in "${pluggyMockUrl}/accounts?itemId=malformed-nested-value-item"`,
        ],
        [
          'truncated-gzip-client',
          'truncated-compressed-gzip',
          'unexpected end of file',
        ],
        [
          'truncated-deflate-client',
          'truncated-compressed-deflate',
          'unexpected end of file',
        ],
        [
          'truncated-br-client',
          'truncated-compressed-br',
          'unexpected end of file',
        ],
        ['auth-error-client', 'global-item', 'Response code 502 (Bad Gateway)'],
        [
          'auth-malformed-client',
          'global-item',
          `Expected property name or '}' in JSON at position 1 (line 1 column 2) in "${pluggyMockUrl}/auth"`,
        ],
      ] as const) {
        await resetUpstream();
        await setCredentials(token, clientId, `${clientId}-secret`, itemId);
        const response = await postPluggy(token, 'accounts');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(
          'application/json; charset=utf-8',
        );
        expect(await response.json()).toEqual({
          status: 'ok',
          data: { error: expected },
        });
        if (itemId.startsWith('truncated-compressed-')) {
          expect(
            (await upstreamRequests()).filter(entry =>
              entry.url?.includes(`itemId=${itemId}`),
            ),
          ).toHaveLength(1);
        }
      }

      await resetUpstream();
      await setCredentials(
        token,
        'error-without-message-client',
        'error-without-message-secret',
        'error-without-message-item',
      );
      expect(await (await postPluggy(token, 'accounts')).json()).toEqual({
        status: 'ok',
        data: {},
      });

      for (const [itemId, error] of [
        ['error-number-message-item', 42],
        ['error-null-message-item', null],
      ] as const) {
        await resetUpstream();
        await setCredentials(
          token,
          `${itemId}-client`,
          `${itemId}-secret`,
          itemId,
        );
        expect(await (await postPluggy(token, 'accounts')).json()).toEqual({
          status: 'ok',
          data: { error },
        });
      }
    }, 15_000);

    it('sends exact Pluggy methods, URLs, authorization headers, and auth body', async () => {
      await resetUpstream();
      await setCredentials(token, 'wire-client', 'wire-secret', 'wire-item');
      await postPluggy(token, 'accounts');
      await postPluggy(token, 'transactions', {
        accountId: 'wire-account',
        startDate: '2024-01-01',
      });

      const upstream = await upstreamRequests();
      expect(
        upstream.map(entry => ({ method: entry.method, url: entry.url })),
      ).toEqual([
        { method: 'POST', url: '/auth' },
        { method: 'GET', url: '/accounts?itemId=wire-item' },
        { method: 'GET', url: '/accounts/wire-account' },
        {
          method: 'GET',
          url: '/v2/transactions?dateFrom=2024-01-01&accountId=wire-account',
        },
        {
          method: 'GET',
          url: '/v2/transactions?dateFrom=2024-01-01&after=wire-account-cursor&accountId=wire-account',
        },
        { method: 'GET', url: '/accounts/wire-account' },
      ]);
      expect(JSON.parse(upstream[0].body)).toEqual({
        clientId: 'wire-client',
        clientSecret: 'wire-secret',
        nonExpiring: false,
      });
      expect(upstream[0].contentType).toBe('application/json');
      for (const entry of upstream) {
        expect(entry.userAgent).toBe(
          `PluggyNode/0.89.0 node.js/${process.versions.node} Got/11.8.6`,
        );
        expect(entry.accept).toBe('application/json');
        expect(entry.acceptEncoding).toBe('gzip, deflate, br');
      }
      for (const entry of upstream.slice(1)) {
        expect(entry.contentType).toBe('application/json');
        expect(entry.apiKey).toMatch(/^[^.]+\.[^.]+\.wire-client$/);
        expect(entry.body).toBe('');
      }
    });

    it('omits missing and null account IDs from transaction queries', async () => {
      for (const body of [{}, { accountId: null }]) {
        await resetUpstream();
        await setCredentials(
          token,
          'missing-account-id-client',
          'missing-account-id-secret',
          'global-item',
        );
        await postPluggy(token, 'transactions', body);
        const upstream = await upstreamRequests();
        expect(
          upstream.find(entry => entry.url?.startsWith('/v2/transactions?'))
            ?.url,
        ).not.toContain('accountId=');
        expect(
          upstream.filter(entry => entry.url?.startsWith('/accounts/')),
        ).toHaveLength(2);
      }
    });
  },
);
