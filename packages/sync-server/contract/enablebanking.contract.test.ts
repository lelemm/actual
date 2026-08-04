import { inject } from 'vitest';

const serverUrl = inject('contractServerUrl');
const upstreamUrl = inject('enableBankingMockUrl');
const secretKey = inject('enableBankingSecretKey');

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

function decodeJwtPart(token: string, index: number) {
  return JSON.parse(
    Buffer.from(token.split('.')[index], 'base64url').toString(),
  );
}

describe.runIf(process.env.ACTUAL_CONTRACT_VARIANT === 'enablebanking')(
  'Enable Banking HTTP contract',
  () => {
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

      const bootstrap = await fetch(serverUrl + '/account/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'contract-password' }),
      });
      const token = ((await bootstrap.json()) as { data: { token: string } })
        .data.token;

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

      const requests = (await (
        await fetch(upstreamUrl + '/contract/requests')
      ).json()) as Array<{
        url: string;
        authorization: string;
        psuIp?: string;
        psuUserAgent?: string;
        body?: Record<string, unknown>;
      }>;
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
      for (const request of requests) {
        const jwt = request.authorization.replace(/^Bearer /, '');
        expect(decodeJwtPart(jwt, 0)).toMatchObject({
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
        expect(claims).toMatchObject({
          iss: 'enablebanking.com',
          aud: 'api.enablebanking.com',
        });
        expect(claims.exp - claims.iat).toBe(3600);
        expect(request.psuIp).toBeUndefined();
        expect(request.psuUserAgent).toBeUndefined();
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
      expect(requests[9].url).toContain('continuation_key=contract-page-2');
    });
  },
);
