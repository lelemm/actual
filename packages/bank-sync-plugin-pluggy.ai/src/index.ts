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
import { PluggyClient } from 'pluggy-sdk';

import './manifest';

type PluggyConnector = {
  id: number | string;
  name: string;
  institutionUrl?: string;
};

type PluggyItem = {
  connector?: PluggyConnector;
};

type PluggyAccount = {
  id: string;
  name: string;
  number?: string;
  balance?: number;
  type?: string;
  itemId?: string;
  item?: PluggyItem;
  itemData?: PluggyItem;
  updatedAt?: string;
  currencyCode?: string;
  owner?: string;
};

type PluginRequest = SyncServerPluginRequest;

const pluggyClients = new Map<string, PluggyClient>();

function ok(data: unknown): SyncServerPluginResponse {
  return json({ status: 'ok', data });
}

function errorResponse(error: string): SyncServerPluginResponse {
  return json({ status: 'error', error });
}

async function getPluggyClient(request: PluginRequest): Promise<PluggyClient> {
  const body = (request.body ?? {}) as {
    clientId?: string;
    clientSecret?: string;
  };
  const clientId = (await request.secrets.get('clientId')) || body.clientId;
  const clientSecret =
    (await request.secrets.get('clientSecret')) || body.clientSecret;

  if (!clientId || !clientSecret) {
    throw new Error('Pluggy.ai credentials not configured');
  }

  const cacheKey = JSON.stringify({ clientId, clientSecret });
  const cachedClient = pluggyClients.get(cacheKey);
  if (cachedClient) {
    return cachedClient;
  }

  const pluggyClient = new PluggyClient({
    clientId,
    clientSecret,
  });
  pluggyClients.set(cacheKey, pluggyClient);
  return pluggyClient;
}

async function hasCredentials(request: PluginRequest): Promise<boolean> {
  return Boolean(
    (await request.secrets.get('clientId')) &&
    (await request.secrets.get('clientSecret')) &&
    (await request.secrets.get('itemIds')),
  );
}

function normalizeItemIds(itemIds: string | string[]): string[] {
  const items = typeof itemIds === 'string' ? itemIds.split(',') : itemIds;
  return items.map((id: string) => id.trim()).filter(Boolean);
}

async function statusHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    const { clientId, clientSecret, itemIds } = await request.json<{
      clientId?: string;
      clientSecret?: string;
      itemIds?: string | string[];
    }>();

    if (clientId && clientSecret) {
      await request.secrets.save('clientId', clientId);
      await request.secrets.save('clientSecret', clientSecret);
    }
    if (itemIds) {
      await request.secrets.save(
        'itemIds',
        typeof itemIds === 'string' ? itemIds : itemIds.join(','),
      );
    }

    const configured = await hasCredentials(request);

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
    const { itemIds, clientId, clientSecret } = await request.json<{
      itemIds?: string | string[];
      clientId?: string;
      clientSecret?: string;
    }>();

    if (clientId && clientSecret) {
      await request.secrets.save('clientId', clientId);
      await request.secrets.save('clientSecret', clientSecret);
    }

    let itemIdsArray: string[];

    if (itemIds) {
      if (typeof itemIds === 'string') {
        itemIdsArray = normalizeItemIds(itemIds);
      } else if (Array.isArray(itemIds)) {
        itemIdsArray = normalizeItemIds(itemIds);
      } else {
        return errorResponse('itemIds must be a string or array');
      }

      await request.secrets.save('itemIds', itemIdsArray.join(','));
    } else {
      const storedItemIds = await request.secrets.get('itemIds');
      if (!storedItemIds) {
        return errorResponse(
          'itemIds is required (comma-separated string or array). Please provide itemIds in request or configure them first.',
        );
      }
      itemIdsArray = normalizeItemIds(storedItemIds);
    }

    if (!itemIdsArray.length) {
      return errorResponse('At least one item ID is required');
    }

    const client = await getPluggyClient(request);
    let accounts: PluggyAccount[] = [];

    for (const itemId of itemIdsArray) {
      const partial = await client.fetchAccounts(itemId);

      for (const account of partial.results) {
        try {
          const item = await client.fetchItem(itemId);
          (account as PluggyAccount).itemData = item;
        } catch (error) {
          console.error(
            '[PLUGGY ACCOUNTS] Error fetching item:',
            itemId,
            error,
          );
        }
      }

      accounts = accounts.concat(partial.results as PluggyAccount[]);
    }

    const transformedAccounts = accounts.map((account: PluggyAccount) => {
      const institution =
        account.itemData?.connector?.name ||
        account.item?.connector?.name ||
        'Unknown Institution';
      const connectorId =
        account.itemData?.connector?.id ||
        account.item?.connector?.id ||
        account.itemId;

      return {
        account_id: account.id,
        name: account.name,
        institution,
        balance: account.balance || 0,
        mask: account.number?.substring(account.number.length - 4),
        official_name: account.name,
        orgDomain:
          account.itemData?.connector?.institutionUrl ||
          account.item?.connector?.institutionUrl ||
          null,
        orgId: connectorId?.toString() || null,
      };
    });

    return ok({ accounts: transformedAccounts });
  } catch (error) {
    console.error('[PLUGGY ACCOUNTS] Error:', error);
    return ok(toPluggyError(error));
  }
}

async function transactionsHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    const { accountId, startDate } = await request.json<{
      accountId?: string;
      startDate?: string;
    }>();

    if (!accountId) {
      return errorResponse('accountId is required');
    }
    if (!startDate) {
      return errorResponse('startDate is required');
    }

    const client = await getPluggyClient(request);
    const transactions = await getTransactions(client, accountId, startDate);
    const account = (await client.fetchAccount(accountId)) as Record<
      string,
      unknown
    >;

    let startingBalance = parseInt(
      Math.round((account.balance as number) * 100).toString(),
    );
    if (account.type === 'CREDIT') {
      startingBalance = -startingBalance;
    }
    const date = getDate(new Date(account.updatedAt as string));

    const balances = [
      {
        balanceAmount: {
          amount: startingBalance,
          currency: account.currencyCode,
        },
        balanceType: 'expected',
        referenceDate: date,
      },
    ];

    const all: unknown[] = [];
    const booked: unknown[] = [];
    const pending: unknown[] = [];

    for (const trans of transactions) {
      const transRecord = trans as Record<string, unknown>;
      const newTrans: Record<string, unknown> = {};

      newTrans.booked = !(transRecord.status === 'PENDING');

      const transactionDate = new Date(transRecord.date as string);

      if (transactionDate < new Date(startDate) && !transRecord.sandbox) {
        continue;
      }

      newTrans.payeeName = getPayeeName(transRecord);
      newTrans.notes = transRecord.descriptionRaw || transRecord.description;

      if (account.type === 'CREDIT') {
        if (transRecord.amountInAccountCurrency) {
          transRecord.amountInAccountCurrency =
            (transRecord.amountInAccountCurrency as number) * -1;
        }

        transRecord.amount = (transRecord.amount as number) * -1;
      }

      let amountInCurrency =
        (transRecord.amountInAccountCurrency as number) ??
        (transRecord.amount as number);
      amountInCurrency = Math.round(amountInCurrency * 100) / 100;

      newTrans.transactionAmount = {
        amount: amountInCurrency,
        currency: transRecord.currencyCode,
      };

      newTrans.transactionId = transRecord.id;
      newTrans.sortOrder = transactionDate.getTime();

      newTrans.originalDate = getDate(transactionDate);
      newTrans.date = getDate(getTransactionDateCorrected(transRecord));

      delete transRecord.amount;

      const finalTrans = { ...flattenObject(transRecord), ...newTrans };
      if (newTrans.booked) {
        booked.push(finalTrans);
      } else {
        pending.push(finalTrans);
      }
      all.push(finalTrans);
    }

    const sortFunction = (a: unknown, b: unknown) => {
      const aRec = a as Record<string, unknown>;
      const bRec = b as Record<string, unknown>;
      return (bRec.sortOrder as number) - (aRec.sortOrder as number);
    };

    return ok({
      balances,
      startingBalance,
      transactions: {
        all: all.sort(sortFunction),
        booked: booked.sort(sortFunction),
        pending: pending.sort(sortFunction),
      },
    });
  } catch (error) {
    console.error('[PLUGGY TRANSACTIONS] Error:', error);
    return ok(toPluggyError(error));
  }
}

function toPluggyError(error: unknown): BankSyncError {
  let pluggyMessage = 'Unknown error';
  let pluggyCode: string | number | undefined;

  if (error instanceof Error) {
    pluggyMessage = error.message;

    try {
      const errorAny = error as unknown as Record<string, unknown>;
      if (errorAny.message && typeof errorAny.message === 'string') {
        pluggyMessage = errorAny.message;
      }
      if (errorAny.code !== undefined) {
        pluggyCode = errorAny.code as string | number;
      }
    } catch {
      // Ignore parse errors
    }
  }

  const errorResponse: BankSyncError = {
    error_type: BankSyncErrorCode.UNKNOWN_ERROR,
    error_code: BankSyncErrorCode.UNKNOWN_ERROR,
    status: 'error',
    reason: pluggyMessage,
  };

  const errorMessageLower = pluggyMessage.toLowerCase();

  if (
    pluggyCode === 401 ||
    errorMessageLower.includes('401') ||
    errorMessageLower.includes('unauthorized') ||
    errorMessageLower.includes('invalid credentials')
  ) {
    errorResponse.error_type = BankSyncErrorCode.INVALID_CREDENTIALS;
    errorResponse.error_code = BankSyncErrorCode.INVALID_CREDENTIALS;
  } else if (
    pluggyCode === 403 ||
    errorMessageLower.includes('403') ||
    errorMessageLower.includes('forbidden')
  ) {
    errorResponse.error_type = BankSyncErrorCode.UNAUTHORIZED;
    errorResponse.error_code = BankSyncErrorCode.UNAUTHORIZED;
  } else if (
    pluggyCode === 429 ||
    errorMessageLower.includes('429') ||
    errorMessageLower.includes('rate limit')
  ) {
    errorResponse.error_type = BankSyncErrorCode.RATE_LIMIT;
    errorResponse.error_code = BankSyncErrorCode.RATE_LIMIT;
  } else if (
    pluggyCode === 400 ||
    errorMessageLower.includes('400') ||
    errorMessageLower.includes('bad request')
  ) {
    errorResponse.error_type = BankSyncErrorCode.INVALID_REQUEST;
    errorResponse.error_code = BankSyncErrorCode.INVALID_REQUEST;
  } else if (
    pluggyCode === 404 ||
    errorMessageLower.includes('404') ||
    errorMessageLower.includes('not found')
  ) {
    errorResponse.error_type = BankSyncErrorCode.ACCOUNT_NOT_FOUND;
    errorResponse.error_code = BankSyncErrorCode.ACCOUNT_NOT_FOUND;
  } else if (
    errorMessageLower.includes('network') ||
    errorMessageLower.includes('connect') ||
    errorMessageLower.includes('econnrefused')
  ) {
    errorResponse.error_type = BankSyncErrorCode.NETWORK_ERROR;
    errorResponse.error_code = BankSyncErrorCode.NETWORK_ERROR;
  } else if (
    (pluggyCode && typeof pluggyCode === 'number' && pluggyCode >= 500) ||
    errorMessageLower.includes('500') ||
    errorMessageLower.includes('502') ||
    errorMessageLower.includes('503')
  ) {
    errorResponse.error_type = BankSyncErrorCode.SERVER_ERROR;
    errorResponse.error_code = BankSyncErrorCode.SERVER_ERROR;
  }

  errorResponse.details = {
    originalError: pluggyMessage,
    pluggyCode,
  };

  return errorResponse;
}

async function getTransactions(
  client: PluggyClient,
  accountId: string,
  startDate: string,
): Promise<unknown[]> {
  let transactions: unknown[] = [];
  let result = await getTransactionsByAccountId(
    client,
    accountId,
    startDate,
    500,
    1,
  );
  transactions = transactions.concat(result.results);
  const totalPages = result.totalPages;
  let currentPage = result.page;

  while (currentPage !== totalPages) {
    result = await getTransactionsByAccountId(
      client,
      accountId,
      startDate,
      500,
      currentPage + 1,
    );
    transactions = transactions.concat(result.results);
    currentPage = result.page;
  }

  return transactions;
}

async function getTransactionsByAccountId(
  client: PluggyClient,
  accountId: string,
  startDate: string,
  pageSize: number,
  page: number,
): Promise<{ results: unknown[]; totalPages: number; page: number }> {
  const account = (await client.fetchAccount(accountId)) as Record<
    string,
    unknown
  >;

  const sandboxAccount = account.owner === 'John Doe';
  const fromDate = sandboxAccount ? '2000-01-01' : startDate;

  const transactions = await client.fetchTransactions(accountId, {
    from: fromDate,
    pageSize,
    page,
  });

  if (sandboxAccount) {
    const mappedResults = transactions.results.map(
      (t: Record<string, unknown>) => ({
        ...t,
        sandbox: true,
      }),
    );
    transactions.results =
      mappedResults as unknown as typeof transactions.results;
  }

  return transactions;
}

function getDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function addMonthsClamped(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function getTransactionDateCorrected(trans: Record<string, unknown>): Date {
  const creditCardMetadata = trans.creditCardMetadata as
    | {
        installmentNumber?: number;
        purchaseDate?: string | Date;
      }
    | undefined;

  if (creditCardMetadata?.installmentNumber != null) {
    return addMonthsClamped(
      new Date(creditCardMetadata.purchaseDate || (trans.date as string)),
      creditCardMetadata.installmentNumber - 1,
    );
  }

  return new Date(trans.date as string);
}

function flattenObject(
  obj: Record<string, unknown>,
  prefix = '',
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (value === null) {
      continue;
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(
        result,
        flattenObject(value as Record<string, unknown>, newKey),
      );
    } else {
      result[newKey] = value;
    }
  }

  return result;
}

function getPayeeName(trans: Record<string, unknown>): string {
  const merchant = trans.merchant as Record<string, string> | undefined;
  if (merchant && (merchant.name || merchant.businessName)) {
    return merchant.name || merchant.businessName || '';
  }

  const paymentData = trans.paymentData as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (paymentData) {
    const { receiver, payer } = paymentData;

    if (trans.type === 'DEBIT' && receiver) {
      const receiverData = receiver as Record<string, unknown>;
      const docNum = receiverData.documentNumber as
        | Record<string, string>
        | undefined;
      return (receiverData.name as string) || docNum?.value || '';
    }

    if (trans.type === 'CREDIT' && payer) {
      const payerData = payer as Record<string, unknown>;
      const docNum = payerData.documentNumber as
        | Record<string, string>
        | undefined;
      return (payerData.name as string) || docNum?.value || '';
    }
  }

  return '';
}

export const plugin = defineSyncServerPlugin({
  routes: [
    route('GET', '/status', statusHandler),
    route('POST', '/status', statusHandler),
    route('POST', '/accounts', accountsHandler),
    route('POST', '/transactions', transactionsHandler),
  ],
});
