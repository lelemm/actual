import {
  defineSyncServerPlugin,
  json,
  route,
} from '@actual-app/plugins-core-sync-server/plugin';
import type {
  SyncServerPluginRequest,
  SyncServerPluginResponse,
} from '@actual-app/plugins-core-sync-server/plugin';
import { BankSyncErrorCode } from '@actual-app/plugins-core-sync-server/types';
import type { BankSyncError } from '@actual-app/plugins-core-sync-server/types';
import axios from 'axios';

import './manifest';

type SimpleFINAccount = {
  id: string;
  name: string;
  balance: string;
  currency: string;
  'balance-date': number;
  org: {
    name: string;
    domain?: string;
  };
  transactions: SimpleFINTransaction[];
};

type SimpleFINTransaction = {
  id: string;
  payee: string;
  description: string;
  amount: string;
  transacted_at?: number;
  posted?: number;
  pending?: boolean | number;
};

type SimpleFINResponse = {
  accounts: SimpleFINAccount[];
  errors: string[];
  sferrors: string[];
  hasError: boolean;
  accountErrors?: Record<string, unknown[]>;
};

type SimpleFINNormalizedTransaction = {
  booked: boolean;
  sortOrder: number;
  date: string;
  payeeName: string;
  notes: string;
  transactionAmount: {
    amount: string;
    currency: string;
  };
  transactionId: string;
  valueDate?: string;
  bookingDate?: string;
  transactedDate?: string;
  postedDate?: string;
};

type SimpleFINAccountResponse = {
  balances: Array<{
    balanceAmount: {
      amount: string;
      currency: string;
    };
    balanceType: string;
    referenceDate: string;
  }>;
  startingBalance: number;
  transactions: {
    all: SimpleFINNormalizedTransaction[];
    booked: SimpleFINNormalizedTransaction[];
    pending: SimpleFINNormalizedTransaction[];
  };
};

type ParsedAccessKey = {
  baseUrl: string;
  username: string;
  password: string;
};

type PluginRequest = SyncServerPluginRequest;

function ok(data: unknown): SyncServerPluginResponse {
  return json({ status: 'ok', data });
}

function errorResponse(error: string): SyncServerPluginResponse {
  return json({ status: 'error', error });
}

async function statusHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    const { token } = await request.json<{ token?: string }>();

    if (token) {
      await request.secrets.save('simplefin_token', token);
    }

    const storedToken = await request.secrets.get('simplefin_token');
    const configured = storedToken != null && storedToken !== 'Forbidden';

    return ok({ configured });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}

async function accountsHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    const { token } = await request.json<{ token?: string }>();

    if (token) {
      await request.secrets.save('simplefin_token', token);
    }

    let accessKey: string | null = null;

    try {
      const storedToken = await request.secrets.get('simplefin_token');

      if (storedToken == null || storedToken === 'Forbidden') {
        throw new Error('No token');
      }

      accessKey = await getAccessKey(storedToken);
      await request.secrets.save('simplefin_accessKey', accessKey);
      if (accessKey == null || accessKey === 'Forbidden') {
        throw new Error('No access key');
      }
    } catch {
      return ok({
        error_type: 'INVALID_ACCESS_TOKEN',
        error_code: 'INVALID_ACCESS_TOKEN',
        status: 'rejected',
        reason:
          'Invalid SimpleFIN access token. Reset the token and re-link any broken accounts.',
      });
    }

    try {
      const accounts = await getAccounts(accessKey, null, null, null, true);
      const transformedAccounts = accounts.accounts.map(
        (account: SimpleFINAccount) => ({
          account_id: account.id,
          name: account.name,
          institution: account.org.name,
          balance: parseFloat(account.balance.replace('.', '')) / 100,
          mask: account.id.substring(account.id.length - 4),
          official_name: account.name,
          orgDomain: account.org.domain || null,
          orgId: account.org.name,
        }),
      );

      return ok({ accounts: transformedAccounts });
    } catch (e) {
      console.error('[SIMPLEFIN ACCOUNTS] Error:', e);

      const errorResponse: BankSyncError = {
        error_type: BankSyncErrorCode.SERVER_ERROR,
        error_code: BankSyncErrorCode.SERVER_ERROR,
        status: 'error',
        reason: 'There was an error communicating with SimpleFIN.',
      };

      if (e instanceof Error) {
        const errorMessage = e.message.toLowerCase();

        if (
          errorMessage.includes('forbidden') ||
          errorMessage.includes('403')
        ) {
          errorResponse.error_type = BankSyncErrorCode.INVALID_ACCESS_TOKEN;
          errorResponse.error_code = BankSyncErrorCode.INVALID_ACCESS_TOKEN;
          errorResponse.reason =
            'Invalid SimpleFIN access token. Please reconfigure your connection.';
        } else if (
          errorMessage.includes('401') ||
          errorMessage.includes('unauthorized')
        ) {
          errorResponse.error_type = BankSyncErrorCode.UNAUTHORIZED;
          errorResponse.error_code = BankSyncErrorCode.UNAUTHORIZED;
          errorResponse.reason =
            'Unauthorized access to SimpleFIN. Please check your credentials.';
        } else if (
          errorMessage.includes('network') ||
          errorMessage.includes('econnrefused') ||
          errorMessage.includes('enotfound')
        ) {
          errorResponse.error_type = BankSyncErrorCode.NETWORK_ERROR;
          errorResponse.error_code = BankSyncErrorCode.NETWORK_ERROR;
          errorResponse.reason =
            'Network error communicating with SimpleFIN. Please check your connection.';
        }

        errorResponse.details = { originalError: e.message };
      }

      return ok(errorResponse);
    }
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}

async function transactionsHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    const { accountId, startDate } = await request.json<{
      accountId?: string | string[];
      startDate?: string | string[];
    }>();

    if (!accountId) {
      return errorResponse('accountId is required');
    }
    if (!startDate) {
      return errorResponse('startDate is required');
    }

    const accessKey = await request.secrets.get('simplefin_accessKey');

    if (accessKey == null || accessKey === 'Forbidden') {
      return ok({
        error_type: 'INVALID_ACCESS_TOKEN',
        error_code: 'INVALID_ACCESS_TOKEN',
        status: 'rejected',
        reason:
          'Invalid SimpleFIN access token. Reset the token and re-link any broken accounts.',
      });
    }

    if (Array.isArray(accountId) !== Array.isArray(startDate)) {
      console.log({ accountId, startDate });
      return errorResponse(
        'accountId and startDate must either both be arrays or both be strings',
      );
    }
    if (
      Array.isArray(accountId) &&
      Array.isArray(startDate) &&
      accountId.length !== startDate.length
    ) {
      console.log({ accountId, startDate });
      return errorResponse(
        'accountId and startDate arrays must be the same length',
      );
    }

    const earliestStartDate = Array.isArray(startDate)
      ? startDate.reduce((a, b) => (a < b ? a : b))
      : startDate;

    let results: SimpleFINResponse;
    try {
      results = await getTransactions(
        accessKey,
        Array.isArray(accountId) ? accountId : [accountId],
        new Date(earliestStartDate),
      );
    } catch (e) {
      console.error('[SIMPLEFIN TRANSACTIONS] Error:', e);

      const errorResponse: BankSyncError = {
        error_type: BankSyncErrorCode.SERVER_ERROR,
        error_code: BankSyncErrorCode.SERVER_ERROR,
        status: 'error',
        reason: 'There was an error communicating with SimpleFIN.',
      };

      if (e instanceof Error) {
        const errorMessage = e.message.toLowerCase();

        if (
          errorMessage.includes('forbidden') ||
          errorMessage.includes('403')
        ) {
          errorResponse.error_type = BankSyncErrorCode.INVALID_ACCESS_TOKEN;
          errorResponse.error_code = BankSyncErrorCode.INVALID_ACCESS_TOKEN;
          errorResponse.reason =
            'Invalid SimpleFIN access token. Please reconfigure your connection.';
        } else if (
          errorMessage.includes('401') ||
          errorMessage.includes('unauthorized')
        ) {
          errorResponse.error_type = BankSyncErrorCode.UNAUTHORIZED;
          errorResponse.error_code = BankSyncErrorCode.UNAUTHORIZED;
          errorResponse.reason =
            'Unauthorized access to SimpleFIN. Please check your credentials.';
        } else if (
          errorMessage.includes('404') ||
          errorMessage.includes('not found')
        ) {
          errorResponse.error_type = BankSyncErrorCode.ACCOUNT_NOT_FOUND;
          errorResponse.error_code = BankSyncErrorCode.ACCOUNT_NOT_FOUND;
          errorResponse.reason =
            'Account not found in SimpleFIN. Please check your account configuration.';
        } else if (
          errorMessage.includes('network') ||
          errorMessage.includes('econnrefused') ||
          errorMessage.includes('enotfound')
        ) {
          errorResponse.error_type = BankSyncErrorCode.NETWORK_ERROR;
          errorResponse.error_code = BankSyncErrorCode.NETWORK_ERROR;
          errorResponse.reason =
            'Network error communicating with SimpleFIN. Please check your connection.';
        }

        errorResponse.details = { originalError: e.message };
      }

      return ok(errorResponse);
    }

    let response:
      | Record<string, SimpleFINAccountResponse | undefined>
      | SimpleFINAccountResponse
      | undefined = {};
    if (Array.isArray(accountId)) {
      const startDates = startDate as string[];
      for (let i = 0; i < accountId.length; i++) {
        const id = accountId[i];
        response[id] = getAccountResponse(results, id, new Date(startDates[i]));
      }
    } else {
      response = getAccountResponse(
        results,
        accountId,
        new Date(startDate as string),
      );
    }

    if (results.hasError) {
      return ok(
        !Array.isArray(accountId)
          ? results.accountErrors?.[accountId]?.[0] || results.errors[0]
          : {
              ...response,
              errors: results.accountErrors || results.errors,
            },
      );
    }

    return ok(response);
  } catch (error) {
    return ok({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

function logAccountError(
  results: SimpleFINResponse,
  accountId: string,
  data: unknown,
) {
  if (!results.accountErrors) {
    results.accountErrors = {};
  }
  const errors = results.accountErrors[accountId] || [];
  errors.push(data);
  results.accountErrors[accountId] = errors;
  results.hasError = true;
}

function getAccountResponse(
  results: SimpleFINResponse,
  accountId: string,
  startDate: Date,
): SimpleFINAccountResponse | undefined {
  const account = !results?.accounts
    ? undefined
    : results.accounts.find(a => a.id === accountId);
  if (!account) {
    console.log(
      `The account "${accountId}" was not found. Here were the accounts returned:`,
    );
    if (results?.accounts) {
      results.accounts.forEach(a => console.log(`${a.id} - ${a.org.name}`));
    }
    logAccountError(results, accountId, {
      error_type: 'ACCOUNT_MISSING',
      error_code: 'ACCOUNT_MISSING',
      reason: `The account "${accountId}" was not found. Try unlinking and relinking the account.`,
    });
    return;
  }

  const needsAttention = results.sferrors.find(e =>
    e.startsWith(`Connection to ${account.org.name} may need attention`),
  );
  if (needsAttention) {
    logAccountError(results, accountId, {
      error_type: 'ACCOUNT_NEEDS_ATTENTION',
      error_code: 'ACCOUNT_NEEDS_ATTENTION',
      reason:
        'The account needs your attention at <a href="https://bridge.simplefin.org/auth/login">SimpleFIN</a>.',
    });
  }

  const startingBalance = parseInt(account.balance.replace('.', ''));
  const date = getDate(new Date(account['balance-date'] * 1000));

  const balances = [
    {
      balanceAmount: {
        amount: account.balance,
        currency: account.currency,
      },
      balanceType: 'expected',
      referenceDate: date,
    },
    {
      balanceAmount: {
        amount: account.balance,
        currency: account.currency,
      },
      balanceType: 'interimAvailable',
      referenceDate: date,
    },
  ];

  const all: SimpleFINNormalizedTransaction[] = [];
  const booked: SimpleFINNormalizedTransaction[] = [];
  const pending: SimpleFINNormalizedTransaction[] = [];

  for (const trans of account.transactions) {
    const newTrans: SimpleFINNormalizedTransaction = {
      booked: false,
      sortOrder: 0,
      date: '',
      payeeName: trans.payee,
      notes: trans.description,
      transactionAmount: { amount: trans.amount, currency: 'USD' },
      transactionId: trans.id,
    };

    let dateToUse = 0;

    if (trans.pending ?? trans.posted === 0) {
      newTrans.booked = false;
      dateToUse = trans.transacted_at || 0;
    } else {
      newTrans.booked = true;
      dateToUse = trans.posted || 0;
    }

    const transactionDate = new Date(dateToUse * 1000);

    if (transactionDate < startDate) {
      continue;
    }

    newTrans.sortOrder = dateToUse;
    newTrans.date = getDate(transactionDate);
    newTrans.payeeName = trans.payee;
    newTrans.notes = trans.description;
    newTrans.transactionAmount = { amount: trans.amount, currency: 'USD' };
    newTrans.transactionId = trans.id;
    newTrans.valueDate = newTrans.bookingDate;

    if (trans.transacted_at) {
      newTrans.transactedDate = getDate(new Date(trans.transacted_at * 1000));
    }

    if (trans.posted) {
      newTrans.postedDate = getDate(new Date(trans.posted * 1000));
    }

    if (newTrans.booked) {
      booked.push(newTrans);
    } else {
      pending.push(newTrans);
    }
    all.push(newTrans);
  }

  const sortFunction = (
    a: SimpleFINNormalizedTransaction,
    b: SimpleFINNormalizedTransaction,
  ) => b.sortOrder - a.sortOrder;

  const bookedSorted = booked.sort(sortFunction);
  const pendingSorted = pending.sort(sortFunction);
  const allSorted = all.sort(sortFunction);

  return {
    balances,
    startingBalance,
    transactions: {
      all: allSorted,
      booked: bookedSorted,
      pending: pendingSorted,
    },
  };
}

function parseAccessKey(accessKey: string): ParsedAccessKey {
  if (!accessKey || !accessKey.match(/^.*\/\/.*:.*@.*$/)) {
    console.log(`Invalid SimpleFIN access key: ${accessKey}`);
    throw new Error(`Invalid access key`);
  }
  const [scheme, rest] = accessKey.split('//');
  const [auth, restAfterAuth] = rest.split('@');
  const [username, password] = auth.split(':');
  const baseUrl = `${scheme}//${restAfterAuth}`;
  return {
    baseUrl,
    username,
    password,
  };
}

async function getAccessKey(base64Token: string): Promise<string> {
  const token = Buffer.from(base64Token, 'base64').toString();

  const response = await axios.post(token, undefined, {
    headers: { 'Content-Length': 0 },
  });

  return response.data;
}

async function getTransactions(
  accessKey: string,
  accounts: string[],
  startDate: Date,
  endDate?: Date,
): Promise<SimpleFINResponse> {
  const now = new Date();
  startDate = startDate || new Date(now.getFullYear(), now.getMonth(), 1);
  endDate = endDate || new Date(now.getFullYear(), now.getMonth() + 1, 1);
  console.log(`${getDate(startDate)} - ${getDate(endDate)}`);
  return await getAccounts(accessKey, accounts, startDate, endDate);
}

function getDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function normalizeDate(date: Date): number {
  return (date.valueOf() - date.getTimezoneOffset() * 60 * 1000) / 1000;
}

async function getAccounts(
  accessKey: string,
  accounts?: string[] | null,
  startDate?: Date | null,
  endDate?: Date | null,
  noTransactions = false,
): Promise<SimpleFINResponse> {
  const sfin = parseAccessKey(accessKey);

  const headers = {
    Authorization: `Basic ${Buffer.from(
      `${sfin.username}:${sfin.password}`,
    ).toString('base64')}`,
  };

  const params = new URLSearchParams();
  if (!noTransactions) {
    if (startDate) {
      params.append('start-date', normalizeDate(startDate).toString());
    }
    if (endDate) {
      params.append('end-date', normalizeDate(endDate).toString());
    }
    params.append('pending', '1');
  } else {
    params.append('balances-only', '1');
  }

  if (accounts) {
    for (const id of accounts) {
      params.append('account', id);
    }
  }

  const url = new URL(`${sfin.baseUrl}/accounts`);
  url.search = params.toString();

  const response = await axios.get(url.toString(), {
    headers,
    maxRedirects: 5,
  });

  if (response.status === 403) {
    throw new Error('Forbidden');
  }

  const results: SimpleFINResponse = response.data as SimpleFINResponse;
  results.sferrors = results.errors;
  results.hasError = false;
  results.errors = [];
  results.accountErrors = {};
  return results;
}

export const plugin = defineSyncServerPlugin({
  routes: [
    route('GET', '/status', statusHandler),
    route('POST', '/status', statusHandler),
    route('POST', '/accounts', accountsHandler),
    route('POST', '/transactions', transactionsHandler),
  ],
});
