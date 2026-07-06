import {
  defineSyncServerPlugin,
  json,
  route,
} from '@actual-app/plugins-core-sync-server/plugin';
import type { SyncServerPluginRequest } from '@actual-app/plugins-core-sync-server/plugin';

type TransactionsRequestBody = {
  accountId?: string;
};

type DummyTransaction = {
  booked: boolean;
  date: string;
  originalDate: string;
  payeeName: string;
  notes: string;
  transactionAmount: {
    amount: number;
    currency: string;
  };
  transactionId: string;
  sortOrder: number;
};

function statusHandler() {
  return json({
    status: 'ok',
    data: {
      configured: true,
      provider: 'dummy-bank-sync',
    },
  });
}

function accountsHandler() {
  return json({
    status: 'ok',
    data: {
      accounts: [
        {
          account_id: 'dummy-checking',
          name: 'Dummy Checking',
          institution: 'Dummy Bank',
          balance: 1234.56,
          mask: '0001',
          official_name: 'Dummy Checking',
          orgDomain: null,
          orgId: 'dummy-bank',
        },
        {
          account_id: 'dummy-credit',
          name: 'Dummy Credit Card',
          institution: 'Dummy Bank',
          balance: -89.12,
          mask: '0002',
          official_name: 'Dummy Credit Card',
          orgDomain: null,
          orgId: 'dummy-bank',
        },
      ],
    },
  });
}

async function transactionsHandler(request: SyncServerPluginRequest) {
  const { accountId } = await request.json<TransactionsRequestBody>();
  if (!accountId) {
    return json(
      {
        error_type: 'INVALID_REQUEST',
        error_code: 'INVALID_REQUEST',
        status: 'error',
        reason: 'accountId is required',
      },
      { status: 400 },
    );
  }

  const isCredit = accountId === 'dummy-credit';
  const currency = 'USD';
  const startingBalance = isCredit ? -8912 : 123456;
  const transactions = getDummyTransactions(accountId, currency);

  return json({
    status: 'ok',
    data: {
      balances: [
        {
          balanceAmount: {
            amount: startingBalance,
            currency,
          },
          balanceType: 'expected',
          referenceDate: '2026-01-03',
        },
      ],
      startingBalance,
      transactions: {
        all: transactions,
        booked: transactions.filter(transaction => transaction.booked),
        pending: transactions.filter(transaction => !transaction.booked),
      },
    },
  });
}

function getDummyTransactions(
  accountId: string,
  currency: string,
): DummyTransaction[] {
  return [
    {
      booked: true,
      date: '2026-01-03',
      originalDate: '2026-01-03',
      payeeName: 'Dummy Grocery',
      notes: 'Dummy booked transaction',
      transactionAmount: {
        amount: -42.1,
        currency,
      },
      transactionId: `${accountId}-booked-001`,
      sortOrder: new Date('2026-01-03').getTime(),
    },
    {
      booked: false,
      date: '2026-01-04',
      originalDate: '2026-01-04',
      payeeName: 'Dummy Pending',
      notes: 'Dummy pending transaction',
      transactionAmount: {
        amount: -7.5,
        currency,
      },
      transactionId: `${accountId}-pending-001`,
      sortOrder: new Date('2026-01-04').getTime(),
    },
  ];
}

export const plugin = defineSyncServerPlugin({
  routes: [
    route('GET', '/status', statusHandler),
    route('POST', '/status', statusHandler),
    route('POST', '/accounts', accountsHandler),
    route('POST', '/transactions', transactionsHandler),
  ],
});
