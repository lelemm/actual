import { inject } from 'vitest';

const serverUrl = inject('contractServerUrl');
const upstreamUrl = inject('enableBankingMockUrl');
const secretKey = inject('enableBankingSecretKey');
let token: string;

type EnableBankingRequest = {
  method: string;
  url: string;
  authorization: string;
  psuIp?: string;
  psuUserAgent?: string;
  contentType?: string;
  contentLength?: string;
  rawBody: string;
  body?: Record<string, unknown>;
};

async function upstreamRequests(): Promise<EnableBankingRequest[]> {
  return (await (
    await fetch(upstreamUrl + '/contract/requests')
  ).json()) as EnableBankingRequest[];
}

async function resetUpstream() {
  await fetch(upstreamUrl + '/contract/reset', { method: 'POST' });
}

async function post(
  path: string,
  token: string,
  body: unknown = {},
  fileId?: string,
) {
  return fetch(serverUrl + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-actual-token': token,
      ...(fileId ? { 'x-actual-file-id': fileId } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function setSecret(name: string, value: string, fileId?: string) {
  const response = await post('/secret/', token, { name, value }, fileId);
  expect(response.status).toBe(200);
}

function decodeJwtPart(token: string, index: number) {
  return JSON.parse(
    Buffer.from(token.split('.')[index], 'base64url').toString(),
  );
}

describe.runIf(process.env.ACTUAL_CONTRACT_VARIANT === 'enablebanking')(
  'Enable Banking HTTP contract',
  () => {
    beforeAll(async () => {
      const bootstrap = await fetch(serverUrl + '/account/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'contract-password' }),
      });
      token = ((await bootstrap.json()) as { data: { token: string } }).data
        .token;
    }, 30_000);

    it('requires authorization and reads credentials only from global secret scope', async () => {
      const unauthorized = await fetch(serverUrl + '/enablebanking/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
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

      await setSecret(
        'enablebanking_applicationId',
        'scoped-application',
        'enablebanking-budget-scope',
      );
      await setSecret(
        'enablebanking_secretKey',
        secretKey,
        'enablebanking-budget-scope',
      );
      expect(await (await post('/enablebanking/status', token)).json()).toEqual(
        {
          status: 'ok',
          data: { configured: false },
        },
      );
      expect(
        (
          (await (
            await fetch(upstreamUrl + '/contract/requests')
          ).json()) as unknown[]
        ).length,
      ).toBe(0);
    });

    it('preserves configuration, authorization handoff, and paginated transactions', async () => {
      expect(
        await (await fetch(serverUrl + '/enablebanking/auth_callback')).text(),
      ).toBe(
        '<html><body><p>Authorization failed: missing code.</p></body></html>',
      );
      expect(
        (
          await fetch(
            serverUrl + '/enablebanking/auth_callback?code=contract-code',
          )
        ).status,
      ).toBe(400);

      expect(await (await post('/enablebanking/status', token)).json()).toEqual(
        {
          status: 'ok',
          data: { configured: false },
        },
      );
      expect(
        await (
          await post('/enablebanking/configure', token, {
            applicationId: 'contract-enablebanking-app',
            secretKey,
          })
        ).json(),
      ).toEqual({ status: 'ok', data: { configured: true } });
      expect(await (await post('/enablebanking/status', token)).json()).toEqual(
        {
          status: 'ok',
          data: { configured: true },
        },
      );

      expect(
        await (
          await post('/enablebanking/aspsps', token, { country: 'FI' })
        ).json(),
      ).toEqual({
        status: 'ok',
        data: [
          {
            name: 'Contract Bank',
            country: 'FI',
            maximum_consent_validity: 7_776_000,
          },
        ],
      });

      const started = (await (
        await post('/enablebanking/start-auth', token, {
          aspsp: { name: 'Contract Bank', country: 'FI' },
          redirectUrl: 'https://actual.example/enablebanking/callback',
          maxConsentValidity: 2_592_000,
          psuType: 'business',
        })
      ).json()) as {
        status: string;
        data: { url: string; state: string };
      };
      expect(started.status).toBe('ok');
      expect(started.data.url).toBe('https://contract-bank.example/authorize');
      expect(started.data.state).toMatch(/^[0-9a-f-]{36}$/);

      const completed = (await (
        await post('/enablebanking/complete-auth', token, {
          code: 'contract-code',
          state: started.data.state,
        })
      ).json()) as { status: string; data: Record<string, unknown> };
      expect(completed).toMatchObject({
        status: 'ok',
        data: {
          session_id: 'contract-enablebanking-session',
          accounts: [
            {
              account_id: 'contract-enablebanking-account',
              name: 'Contract current account',
              institution: 'Contract Bank',
              balance: 123456,
              balances: [
                {
                  balanceAmount: { amount: 123456, currency: 'EUR' },
                  balanceType: 'CLAV',
                  referenceDate: '2026-07-31',
                },
                {
                  balanceAmount: { amount: 120000, currency: 'EUR' },
                  balanceType: 'XPCD',
                },
              ],
            },
          ],
        },
      });
      expect(
        await (
          await post('/enablebanking/poll-auth', token, {
            state: started.data.state,
          })
        ).json(),
      ).toEqual(completed);

      const callback = await fetch(
        serverUrl +
          '/enablebanking/auth_callback?code=callback-code&state=callback-state',
      );
      expect(callback.status).toBe(200);
      expect(await callback.text()).toContain('Authorization successful.');
      expect(
        await (
          await post('/enablebanking/poll-auth', token, {
            state: 'callback-state',
          })
        ).json(),
      ).toMatchObject({
        status: 'ok',
        data: { session_id: 'contract-enablebanking-session' },
      });

      const transactions = await (
        await post('/enablebanking/transactions', token, {
          accountId: 'contract-enablebanking-account',
          startDate: '2026-07-01',
        })
      ).json();
      expect(transactions).toMatchObject({
        status: 'ok',
        data: {
          startingBalance: 123456,
          transactions: {
            all: [
              {
                transactionId: 'enable-booked',
                transactionAmount: { amount: '100.50', currency: 'EUR' },
                payeeName: 'Contract Employer',
                notes: 'salary July',
                booked: true,
              },
              {
                transactionId: 'enable-pending',
                transactionAmount: { amount: '-25.99', currency: 'EUR' },
                payeeName: 'Contract Shop',
                booked: false,
              },
            ],
            booked: [{ transactionId: 'enable-booked' }],
            pending: [{ transactionId: 'enable-pending' }],
          },
        },
      });

      const requests = await upstreamRequests();
      expect(requests.map(request => request.method)).toEqual([
        'GET',
        'GET',
        'POST',
        'POST',
        'GET',
        'POST',
        'GET',
        'GET',
        'GET',
        'GET',
      ]);
      expect(
        requests.map(request => new URL(request.url, upstreamUrl).pathname),
      ).toEqual([
        '/application',
        '/aspsps',
        '/auth',
        '/sessions',
        '/accounts/contract-enablebanking-account/balances',
        '/sessions',
        '/accounts/contract-enablebanking-account/balances',
        '/accounts/contract-enablebanking-account/balances',
        '/accounts/contract-enablebanking-account/transactions',
        '/accounts/contract-enablebanking-account/transactions',
      ]);
      expect(requests.slice(0, 8).map(request => request.url)).toEqual([
        '/application',
        '/aspsps?country=FI',
        '/auth',
        '/sessions',
        '/accounts/contract-enablebanking-account/balances',
        '/sessions',
        '/accounts/contract-enablebanking-account/balances',
        '/accounts/contract-enablebanking-account/balances',
      ]);
      expect(requests[8].url).toMatch(
        /^\/accounts\/contract-enablebanking-account\/transactions\?date_from=2026-07-01&date_to=\d{4}-\d{2}-\d{2}$/,
      );
      expect(requests[9].url).toBe(
        `${requests[8].url}&continuation_key=contract-page-2`,
      );
      for (const request of requests) {
        const jwt = request.authorization.replace(/^Bearer /, '');
        expect(decodeJwtPart(jwt, 0)).toEqual({
          typ: 'JWT',
          alg: 'RS256',
          kid: 'contract-enablebanking-app',
        });
        const claims = decodeJwtPart(jwt, 1) as {
          iss: string;
          aud: string;
          iat: number;
          exp: number;
        };
        expect(claims).toEqual({
          iss: 'enablebanking.com',
          aud: 'api.enablebanking.com',
          iat: claims.iat,
          exp: claims.exp,
        });
        expect(claims.iat).toBeGreaterThanOrEqual(
          Math.floor(Date.now() / 1000) - 5,
        );
        expect(claims.iat).toBeLessThanOrEqual(
          Math.floor(Date.now() / 1000) + 1,
        );
        expect(claims.exp - claims.iat).toBe(3600);
        expect(request.psuIp).toBeUndefined();
        expect(request.psuUserAgent).toBeUndefined();
        expect(request.contentType).toBe('application/json');
      }
      expect(requests[2].body).toMatchObject({
        aspsp: { name: 'Contract Bank', country: 'FI' },
        redirect_url: 'https://actual.example/enablebanking/callback',
        state: started.data.state,
        psu_type: 'business',
      });
      const authAccess = requests[2].body?.access as
        | { valid_until?: string }
        | undefined;
      const validUntil = String(authAccess?.valid_until);
      const consentDays =
        (Date.parse(validUntil) - Date.now()) / (24 * 60 * 60 * 1000);
      expect(consentDays).toBeGreaterThan(29.9);
      expect(consentDays).toBeLessThan(30.1);
      const expectedBodies = [
        '',
        '',
        `{"aspsp":{"name":"Contract Bank","country":"FI"},"redirect_url":"https://actual.example/enablebanking/callback","state":"${started.data.state}","access":{"valid_until":"${validUntil}"},"psu_type":"business"}`,
        '{"code":"contract-code"}',
        '',
        '{"code":"callback-code"}',
        '',
        '',
        '',
        '',
      ];
      expect(requests.map(request => request.rawBody)).toEqual(expectedBodies);
      expect(requests.map(request => request.contentLength)).toEqual(
        expectedBodies.map(body =>
          body ? String(Buffer.byteLength(body)) : undefined,
        ),
      );
    });

    it('preserves poll-before-callback, supersession, failure, and disconnect handoffs', async () => {
      const pollBeforeCallback = post('/enablebanking/poll-auth', token, {
        state: 'poll-before-callback',
      }).then(response => response.json());
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(
        (
          await fetch(
            serverUrl +
              '/enablebanking/auth_callback?code=contract-code&state=poll-before-callback',
          )
        ).status,
      ).toBe(200);
      expect(await pollBeforeCallback).toMatchObject({
        status: 'ok',
        data: { session_id: 'contract-enablebanking-session' },
      });

      const superseded = post('/enablebanking/poll-auth', token, {
        state: 'superseded-state',
      }).then(response => response.json());
      await new Promise(resolve => setTimeout(resolve, 50));
      const current = post('/enablebanking/poll-auth', token, {
        state: 'superseded-state',
      }).then(response => response.json());
      expect(await superseded).toEqual({
        status: 'ok',
        data: { error: 'Poll superseded' },
      });
      await post('/enablebanking/complete-auth', token, {
        code: 'contract-code',
        state: 'superseded-state',
      });
      expect(await current).toMatchObject({
        status: 'ok',
        data: { session_id: 'contract-enablebanking-session' },
      });

      const failed = post('/enablebanking/poll-auth', token, {
        state: 'failure-state',
      }).then(response => response.json());
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(
        (
          await fetch(
            serverUrl +
              '/enablebanking/auth_callback?code=failure-code&state=failure-state',
          )
        ).status,
      ).toBe(500);
      expect(await failed).toEqual({
        status: 'ok',
        data: { error: 'Session failed' },
      });

      const controller = new AbortController();
      const disconnected = fetch(serverUrl + '/enablebanking/poll-auth', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({ state: 'disconnect-state' }),
        signal: controller.signal,
      }).catch(error => error);
      await new Promise(resolve => setTimeout(resolve, 50));
      controller.abort();
      expect((await disconnected).name).toBe('AbortError');
      expect(
        (
          await fetch(
            serverUrl +
              '/enablebanking/auth_callback?code=contract-code&state=disconnect-state',
          )
        ).status,
      ).toBe(200);
      expect(
        await (
          await post('/enablebanking/poll-auth', token, {
            state: 'disconnect-state',
          })
        ).json(),
      ).toMatchObject({
        status: 'ok',
        data: { session_id: 'contract-enablebanking-session' },
      });

      expect(
        await (
          await post('/enablebanking/poll-auth', token, {
            state: 'timeout-state',
          })
        ).json(),
      ).toEqual({
        status: 'ok',
        data: { error: 'Polling timed out' },
      });
    });

    it('stops pagination on an empty continuation key and rejects malformed collections', async () => {
      await resetUpstream();
      expect(
        await (
          await post('/enablebanking/transactions', token, {
            accountId: 'empty-continuation-account',
            startDate: '2026-07-01',
          })
        ).json(),
      ).toMatchObject({ status: 'ok', data: { transactions: { all: [] } } });
      expect((await upstreamRequests()).map(request => request.url)).toEqual([
        '/accounts/empty-continuation-account/balances',
        expect.stringMatching(
          /^\/accounts\/empty-continuation-account\/transactions\?date_from=2026-07-01&date_to=\d{4}-\d{2}-\d{2}$/,
        ),
      ]);

      for (const accountId of [
        'malformed-balances-account',
        'malformed-transactions-account',
      ]) {
        expect(
          await (
            await post('/enablebanking/transactions', token, {
              accountId,
              startDate: '2026-07-01',
            })
          ).json(),
        ).toEqual({
          status: 'ok',
          data: {
            error_type: 'INTERNAL_ERROR',
            error_code: 'INTERNAL_ERROR',
          },
        });
      }
    });

    it('times out once without retrying a stalled upstream request', async () => {
      await resetUpstream();
      const startedAt = Date.now();
      expect(
        await (
          await post('/enablebanking/transactions', token, {
            accountId: 'timeout-account',
            startDate: '2026-07-01',
          })
        ).json(),
      ).toEqual({
        status: 'ok',
        data: {
          error_type: 'TIMED_OUT',
          error_code: 'TIMED_OUT',
        },
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(29_000);
      expect((await upstreamRequests()).map(request => request.url)).toEqual([
        '/accounts/timeout-account/balances',
      ]);
    }, 40_000);

    it('preserves validation, credential, secret-scope, and upstream error mappings', async () => {
      const expectJson = async (response: Response, expected: unknown) => {
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(
          'application/json; charset=utf-8',
        );
        expect(await response.json()).toEqual(expected);
      };
      await expectJson(await post('/enablebanking/configure', token, {}), {
        status: 'ok',
        data: {
          error_code: 'INVALID_INPUT',
          error_type: 'Missing applicationId or secretKey',
        },
      });
      await expectJson(await post('/enablebanking/start-auth', token, {}), {
        status: 'ok',
        data: {
          error_code: 'INVALID_INPUT',
          error_type: 'Missing aspsp or redirectUrl',
        },
      });
      await expectJson(await post('/enablebanking/complete-auth', token, {}), {
        status: 'ok',
        data: { error_code: 'INVALID_INPUT', error_type: 'Missing code' },
      });
      await expectJson(await post('/enablebanking/poll-auth', token, {}), {
        status: 'ok',
        data: { error_code: 'INVALID_INPUT', error_type: 'Missing state' },
      });
      await expectJson(await post('/enablebanking/transactions', token, {}), {
        status: 'ok',
        data: {
          error_code: 'INVALID_INPUT',
          error_type: 'Missing accountId or startDate',
        },
      });
      await expectJson(
        await post('/enablebanking/configure', token, {
          applicationId: 'invalid-enablebanking-app',
          secretKey,
        }),
        {
          status: 'ok',
          data: {
            error_code: 'CONFIGURATION_FAILED',
            error_type: 'Invalid Enable Banking credentials',
          },
        },
      );

      for (const [accountId, expected] of [
        [
          'rate-limited-account',
          {
            error_type: 'RATE_LIMIT_EXCEEDED',
            error_code: 'RATE_LIMIT_EXCEEDED',
          },
        ],
        [
          'missing-account',
          { error_type: 'INVALID_INPUT', error_code: 'NOT_FOUND' },
        ],
        [
          'server-error-account',
          { error_type: 'INTERNAL_ERROR', error_code: 'INTERNAL_ERROR' },
        ],
        [
          'non-json-account',
          { error_type: 'INTERNAL_ERROR', error_code: 'INTERNAL_ERROR' },
        ],
        [
          'success-non-json-account',
          { error_type: 'INTERNAL_ERROR', error_code: 'INTERNAL_ERROR' },
        ],
        [
          'network-error-account',
          { error_type: 'INTERNAL_ERROR', error_code: 'INTERNAL_ERROR' },
        ],
        [
          'unauthorized-account',
          { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' },
        ],
        [
          'expired-session-account',
          { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' },
        ],
      ] as const) {
        await expectJson(
          await post('/enablebanking/transactions', token, {
            accountId,
            startDate: '2026-07-01',
          }),
          { status: 'ok', data: expected },
        );
      }
      await expectJson(
        await post('/enablebanking/transactions', token, {
          accountId: 'empty-balances-account',
          startDate: '2026-07-01',
        }),
        expect.objectContaining({
          status: 'ok',
          data: expect.objectContaining({ startingBalance: 0, balances: [] }),
        }),
      );
    });
  },
);
