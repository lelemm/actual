import { inject } from 'vitest';

const serverUrl = inject('contractServerUrl');
const upstreamUrl = inject('akahuMockUrl');

type UpstreamRequest = {
  method?: string;
  url?: string;
  authorization?: string;
  appToken?: string;
  sdk?: string;
  idempotencyKey?: string;
  userAgent?: string;
  accept?: string;
  acceptEncoding?: string;
  contentType?: string;
  contentLength?: string;
  body: string;
};

let token: string;

async function post(path: string, body?: unknown, fileId?: string) {
  return fetch(serverUrl + path, {
    method: 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-actual-token': token,
      ...(fileId ? { 'x-actual-file-id': fileId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function setSecret(name: string, value: string, fileId?: string) {
  const response = await post('/secret/', { name, value }, fileId);
  expect(response.status).toBe(200);
}

async function configure(
  userToken = 'user_token_contract',
  appToken = 'app_token_contract',
) {
  await setSecret('akahu_userToken', userToken);
  await setSecret('akahu_appToken', appToken);
}

async function reset() {
  await Promise.all(
    ['akahu_userToken', 'akahu_appToken'].map(name =>
      fetch(`${serverUrl}/secret/${name}`, {
        method: 'DELETE',
        headers: { 'x-actual-token': token },
      }),
    ),
  );
  await fetch(new URL('../contract/reset', upstreamUrl), { method: 'POST' });
}

async function upstreamRequests(): Promise<UpstreamRequest[]> {
  return (await (
    await fetch(new URL('../contract/requests', upstreamUrl))
  ).json()) as UpstreamRequest[];
}

async function expectJson(response: Response, expected: unknown) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(
    'application/json; charset=utf-8',
  );
  expect(await response.json()).toEqual(expected);
}

function transactionRequest(accountId: string, startDate = '2024-01-01') {
  return post('/akahu/transactions', { accountId, startDate });
}

const badRequestHtml =
  '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Bad Request</pre>\n</body>\n</html>\n';

describe.runIf(process.env.ACTUAL_CONTRACT_VARIANT === 'akahu')(
  'Akahu HTTP contract',
  () => {
    beforeAll(async () => {
      const response = await fetch(serverUrl + '/account/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'contract-password' }),
      });
      token = ((await response.json()) as { data: { token: string } }).data
        .token;
    });

    beforeEach(reset);

    it.each(['/akahu/status', '/akahu/accounts', '/akahu/transactions'])(
      'rejects malformed JSON before the %s handler runs',
      async path => {
        const response = await fetch(serverUrl + path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-actual-token': token,
          },
          body: '{',
        });
        expect(response.status).toBe(400);
        expect(response.headers.get('content-type')).toBe(
          'text/html; charset=utf-8',
        );
        expect(await response.text()).toBe(badRequestHtml);
        expect(await upstreamRequests()).toEqual([]);
      },
    );

    it('matches Express strict JSON and exact media-type semantics across routes', async () => {
      const paths = ['/akahu/status', '/akahu/accounts', '/akahu/transactions'];
      for (const path of paths) {
        for (const primitive of ['null', 'true', '1', '"text"']) {
          const response = await fetch(serverUrl + path, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-actual-token': token,
            },
            body: primitive,
          });
          expect(response.status).toBe(400);
          expect(response.headers.get('content-type')).toBe(
            'text/html; charset=utf-8',
          );
          expect(await response.text()).toBe(badRequestHtml);
        }

        for (const body of ['', '[]']) {
          const response = await fetch(serverUrl + path, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-actual-token': token,
            },
            body,
          });
          expect(response.status).toBe(200);
          expect(response.headers.get('content-type')).toBe(
            'application/json; charset=utf-8',
          );
        }

        const ignoredJsonp = await fetch(serverUrl + path, {
          method: 'POST',
          headers: {
            'content-type': 'application/jsonp',
            'x-actual-token': token,
          },
          body: '{',
        });
        expect(ignoredJsonp.status).toBe(200);
      }

      const caseInsensitive = await fetch(serverUrl + '/akahu/status', {
        method: 'POST',
        headers: {
          'content-type': 'Application/JSON; Charset=UTF-8',
          'x-actual-token': token,
        },
        body: '{',
      });
      expect(caseInsensitive.status).toBe(400);
      expect(await caseInsensitive.text()).toBe(badRequestHtml);
      expect(await upstreamRequests()).toEqual([]);
    });

    it('requires authorization and reads only global credential scope', async () => {
      const unauthorized = await fetch(serverUrl + '/akahu/status', {
        method: 'POST',
      });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      expect(await unauthorized.json()).toEqual({
        status: 'error',
        reason: 'unauthorized',
        details: 'token-not-found',
      });

      await expectJson(await post('/akahu/status'), {
        status: 'ok',
        data: { configured: false },
      });
      await setSecret('akahu_userToken', 'scoped-user', 'budget-scope');
      await setSecret('akahu_appToken', 'app_token_scoped', 'budget-scope');
      await expectJson(await post('/akahu/status'), {
        status: 'ok',
        data: { configured: false },
      });
      await setSecret('akahu_userToken', '');
      await setSecret('akahu_appToken', '');
      await expectJson(await post('/akahu/status'), {
        status: 'ok',
        data: { configured: true },
      });
      await expectJson(await post('/akahu/accounts'), {
        status: 'ok',
        data: { error: 'Missing user or app token' },
      });
      expect(await upstreamRequests()).toEqual([]);
    });

    it('preserves account-list success, headers, and exact request shape', async () => {
      await configure();
      const response = await post('/akahu/accounts');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      expect(await response.json()).toEqual({
        status: 'ok',
        data: {
          accounts: [
            {
              _id: 'acc-contract',
              name: 'Contract account',
              balance: { current: -1.005, available: 50, currency: 'NZD' },
              refreshed: {
                balance: '2024-01-01T11:30:00.000Z',
                transactions: '2099-01-01T00:00:00.000Z',
              },
            },
          ],
        },
      });
      expect(await upstreamRequests()).toEqual([
        {
          method: 'GET',
          url: '/v1/accounts',
          authorization: 'Bearer user_token_contract',
          appToken: 'app_token_contract',
          sdk: 'akahu-sdk-js/2.5.1',
          userAgent: 'akahu-sdk-js/2.5.1',
          accept: 'application/json, text/plain, */*',
          acceptEncoding: 'gzip, compress, deflate, br',
          body: '',
        },
      ]);
    });

    it.each([
      ['user_token_http-error', 'Akahu unavailable'],
      ['user_token_rejected', 'Akahu rejected'],
      ['user_token_non-json', 'OK'],
    ])('maps account-list failure for %s', async (userToken, error) => {
      await configure(userToken);
      const response = await post('/akahu/accounts');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      const payload = (await response.json()) as {
        status: string;
        data: { error: string };
      };
      expect(payload.status).toBe('error');
      expect(payload.data.error).toBe(error);
    });

    it('maps connection resets and waits through a stalled SDK request without inventing a timeout', async () => {
      await configure('user_token_connection-reset');
      await expectJson(await post('/akahu/accounts'), {
        status: 'error',
        data: { error: 'socket hang up' },
      });

      await reset();
      await configure('user_token_stalled');
      const startedAt = Date.now();
      const response = await post('/akahu/accounts');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
      await expectJson(response, {
        status: 'ok',
        data: { accounts: [expect.objectContaining({ _id: 'acc-contract' })] },
      });
    });

    it('preserves SDK validation before making an upstream request', async () => {
      await configure('user_token_contract', 'invalid-app-token');
      await expectJson(await post('/akahu/accounts'), {
        status: 'error',
        data: {
          error:
            'Invalid appToken value: invalid-app-token. appToken must be a string beginning with app_token_',
        },
      });
      expect(await upstreamRequests()).toEqual([]);
    });

    it('preserves input, missing-account, and missing-balance failures', async () => {
      await expectJson(await post('/akahu/transactions', {}), {
        status: 'error',
        data: { error: 'accountId and startDate are required' },
      });
      await configure();
      await expectJson(await transactionRequest('missing-account'), {
        status: 'error',
        data: { error: 'Account not found' },
      });
      await expectJson(await transactionRequest('missing-balance-account'), {
        status: 'error',
        data: { error: 'Account balance unavailable' },
      });
    });

    it('normalizes balances, booked and pending transactions and pagination', async () => {
      await configure();
      const now = new Date();
      const expectedEnd = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        1,
      ).toISOString();
      const response = await transactionRequest('acc-contract');
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        status: string;
        data: {
          balances: unknown;
          startingBalance: number;
          transactions: {
            booked: unknown;
            pending: unknown;
            all: Array<{ booked: boolean }>;
          };
        };
      };
      expect(payload.status).toBe('ok');
      expect(payload.data.balances).toEqual([
        {
          balanceAmount: { amount: -100, currency: 'NZD' },
          balanceType: 'expected',
          referenceDate: '2024-01-02',
        },
        {
          balanceAmount: { amount: 5000, currency: 'NZD' },
          balanceType: 'interimAvailable',
          referenceDate: '2024-01-02',
        },
      ]);
      expect(payload.data.startingBalance).toBe(-100);
      expect(payload.data.transactions.booked).toEqual([
        expect.objectContaining({
          _id: 'akahu-booked',
          booked: true,
          date: '2024-01-03',
          payeeName: 'Contract Merchant',
          category: 'Shopping',
          transactionId: 'akahu-booked',
          transactionAmount: { amount: -1, currency: 'NZD' },
        }),
      ]);
      expect(payload.data.transactions.pending).toEqual([
        expect.objectContaining({
          booked: false,
          date: '2024-01-04',
          payeeName: 'Contract Other Account',
          merchant: { name: 'Contract Other Account' },
          transactionAmount: { amount: -2.35, currency: 'NZD' },
        }),
      ]);
      expect(payload.data.transactions.all.map(item => item.booked)).toEqual([
        false,
        true,
      ]);

      const requests = await upstreamRequests();
      expect(requests.map(request => request.method)).toEqual([
        'GET',
        'GET',
        'GET',
        'GET',
      ]);
      expect(
        requests.map(request => new URL(request.url!, upstreamUrl).pathname),
      ).toEqual([
        '/v1/accounts/acc-contract',
        '/v1/accounts/acc-contract/transactions',
        '/v1/accounts/acc-contract/transactions',
        '/v1/accounts/acc-contract/transactions/pending',
      ]);
      const firstPageUrl = requests[1].url!;
      expect(firstPageUrl).toBe(
        `/v1/accounts/acc-contract/transactions?start=2024-01-01T00:00:00.000Z&end=${expectedEnd}`,
      );
      expect(requests[2].url).toBe(
        `${firstPageUrl}&cursor=cursor+two%2F%2Bvalue`,
      );
      for (const request of requests) {
        expect(request.authorization).toBe('Bearer user_token_contract');
        expect(request.appToken).toBe('app_token_contract');
        expect(request.sdk).toBe('akahu-sdk-js/2.5.1');
        expect(request.userAgent).toBe('akahu-sdk-js/2.5.1');
        expect(request.accept).toBe('application/json, text/plain, */*');
        expect(request.acceptEncoding).toBe('gzip, compress, deflate, br');
        expect(request.body).toBe('');
      }
    });

    it('initiates refresh, polls until fresh, then waits for settlement', async () => {
      await configure();
      await expectJson(
        await transactionRequest('refresh-account'),
        expect.objectContaining({ status: 'ok' }),
      );
      const requests = await upstreamRequests();
      expect(
        requests.slice(0, 3).map(request => [request.method, request.url]),
      ).toEqual([
        ['GET', '/v1/accounts/refresh-account'],
        ['POST', '/v1/refresh'],
        ['GET', '/v1/accounts/refresh-account'],
      ]);
      expect(requests[1].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(requests[1].contentLength).toBe('0');
      expect(requests[1].body).toBe('');
    }, 15_000);

    it('surfaces refresh failure and polls stale accounts exactly five times', async () => {
      await configure('user_token_refresh-failure');
      await expectJson(await transactionRequest('refresh-failure-account'), {
        status: 'error',
        data: { error: 'Failed to fetch transactions: Refresh failed' },
      });

      await reset();
      await configure();
      const response = await transactionRequest('timeout-account');
      expect(((await response.json()) as { status: string }).status).toBe('ok');
      const requests = await upstreamRequests();
      expect(
        requests.filter(
          request => request.url === '/v1/accounts/timeout-account',
        ),
      ).toHaveLength(6);
      expect(
        requests.filter(request => request.url === '/v1/refresh'),
      ).toHaveLength(1);
    }, 25_000);

    it('preserves upstream and malformed-date failures while filtering malformed transaction dates', async () => {
      await configure();
      await expectJson(await transactionRequest('account-http-error'), {
        status: 'error',
        data: { error: 'Failed to fetch transactions: Account failed' },
      });
      await expectJson(await transactionRequest('transactions-http-error'), {
        status: 'error',
        data: { error: 'Failed to fetch transactions: Transactions failed' },
      });
      const malformedStart = await transactionRequest(
        'acc-contract',
        'not-a-date',
      );
      const startPayload = (await malformedStart.json()) as {
        status: string;
        data: { error: string };
      };
      expect(startPayload.status).toBe('error');
      expect(startPayload.data.error).toContain('Invalid time value');

      const malformedBalance = await transactionRequest(
        'malformed-balance-date-account',
      );
      const balancePayload = (await malformedBalance.json()) as {
        status: string;
        data: { error: string };
      };
      expect(balancePayload.status).toBe('error');
      expect(balancePayload.data.error).toContain('Invalid time value');

      const filtered = await transactionRequest(
        'malformed-transaction-date-account',
      );
      const filteredPayload = (await filtered.json()) as {
        data: { transactions: { booked: unknown[] } };
      };
      expect(filteredPayload.data.transactions.booked).toHaveLength(1);

      await reset();
      await configure();
      expect(
        (await transactionRequest('malformed-refresh-date-account')).status,
      ).toBe(200);
      expect(
        (await upstreamRequests()).some(
          request => request.url === '/v1/refresh',
        ),
      ).toBe(false);
    });
  },
);
