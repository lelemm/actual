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

describe.runIf(process.env.ACTUAL_CONTRACT_VARIANT === 'gocardless')(
  'GoCardless HTTP contract',
  () => {
    it('preserves token reuse, requisitions, accounts, transactions, and deletion', async () => {
      const bootstrap = await fetch(serverUrl + '/account/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'contract-password' }),
      });
      const token = ((await bootstrap.json()) as { data: { token: string } })
        .data.token;
      for (const [name, value] of [
        ['gocardless_secretId', 'contract-secret-id'],
        ['gocardless_secretKey', 'contract-secret-key'],
      ]) {
        expect(
          (
            await post('/secret/', token, {
              name,
              value,
            })
          ).status,
        ).toBe(200);
      }

      const banks = await (
        await post('/gocardless/get-banks', token, {
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
          'x-actual-token': token,
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
        await post('/gocardless/get-accounts', token, {
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
        await post('/gocardless/transactions', token, {
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

      const withoutBalance = await (
        await post('/gocardless/transactions', token, {
          requisitionId: 'contract-requisition',
          accountId: 'contract-gocardless-account',
          startDate: '2026-07-01',
          endDate: '2026-07-31',
          includeBalance: false,
        })
      ).json();
      expect(withoutBalance).toMatchObject({
        status: 'ok',
        data: { institutionId: 'CONTRACT_BANK' },
      });
      expect(withoutBalance.data).not.toHaveProperty('balances');
      expect(withoutBalance.data).not.toHaveProperty('startingBalance');

      expect(
        await (
          await post('/gocardless/remove-account', token, {
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
          secret_id: 'contract-secret-id',
          secret_key: 'contract-secret-key',
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
  },
);
