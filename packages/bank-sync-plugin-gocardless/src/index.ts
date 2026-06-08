/* eslint-disable @typescript-eslint/no-explicit-any */
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
import jwt from 'jws';
import NordigenNode from 'nordigen-node';
import { v4 as uuidv4 } from 'uuid';

import './manifest';
import { bankFactory } from './banks/bank-factory';

const GoCardlessClient = NordigenNode;

type GoCardlessTransaction = {
  transactionId: string;
  bookingDate?: string;
  valueDate?: string;
  transactionAmount: {
    amount: string;
    currency: string;
  };
  debtorName?: string;
  creditorName?: string;
  remittanceInformationUnstructured?: string;
  remittanceInformationUnstructuredArray?: string[];
  [key: string]: unknown;
};

type PluginRequest = SyncServerPluginRequest;

const clients = new Map<string, any>();

function ok(data: unknown): SyncServerPluginResponse {
  return json({ status: 'ok', data });
}

function errorResponse(error: string): SyncServerPluginResponse {
  return json({ status: 'error', error });
}

async function getGoCardlessClient(request: PluginRequest): Promise<any> {
  const secretId = await request.secrets.get('secretId');
  const secretKey = await request.secrets.get('secretKey');

  if (!secretId || !secretKey) {
    throw new Error('GoCardless credentials not configured');
  }

  const hash = JSON.stringify({ secretId, secretKey });

  if (!clients.has(hash)) {
    clients.set(
      hash,
      new GoCardlessClient({
        secretId,
        secretKey,
        baseUrl: 'https://bankaccountdata.gocardless.com',
      }),
    );
  }

  return clients.get(hash)!;
}

function isExpiredJwtToken(token: string | null | undefined): boolean {
  if (!token) return true;

  const decodedToken = jwt.decode(token);
  if (!decodedToken) return true;

  const payload = decodedToken.payload as { exp: number };
  const clockTimestamp = Math.floor(Date.now() / 1000);
  return clockTimestamp >= payload.exp;
}

async function ensureValidToken(client: any): Promise<void> {
  if (isExpiredJwtToken(client.token)) {
    await client.generateToken();
  }
}

function handleGoCardlessError(error: any): never {
  const status = error?.response?.status;
  let errorCode: BankSyncError['error_code'] = BankSyncErrorCode.UNKNOWN_ERROR;
  let errorType = 'UNKNOWN_ERROR';
  let reason = 'An unknown error occurred';

  switch (status) {
    case 400:
      errorCode = BankSyncErrorCode.INVALID_REQUEST;
      errorType = 'INVALID_INPUT_DATA';
      reason = 'Invalid request data';
      break;
    case 401:
      errorCode = BankSyncErrorCode.INVALID_CREDENTIALS;
      errorType = 'INVALID_TOKEN';
      reason = 'Invalid GoCardless credentials';
      break;
    case 403:
      errorCode = BankSyncErrorCode.UNAUTHORIZED;
      errorType = 'ACCESS_DENIED';
      reason = 'Access denied';
      break;
    case 404:
      errorCode = BankSyncErrorCode.ACCOUNT_NOT_FOUND;
      errorType = 'NOT_FOUND';
      reason = 'Resource not found';
      break;
    case 409:
      errorCode = BankSyncErrorCode.SERVER_ERROR;
      errorType = 'RESOURCE_SUSPENDED';
      reason = 'Resource suspended';
      break;
    case 429:
      errorCode = BankSyncErrorCode.RATE_LIMIT;
      errorType = 'RATE_LIMIT_EXCEEDED';
      reason = 'Rate limit exceeded';
      break;
    case 500:
      errorCode = BankSyncErrorCode.SERVER_ERROR;
      errorType = 'SERVER_ERROR';
      reason = 'GoCardless server error';
      break;
    case 503:
      errorCode = BankSyncErrorCode.SERVER_ERROR;
      errorType = 'SERVICE_ERROR';
      reason = 'GoCardless service unavailable';
      break;
    default:
      break;
  }

  const bankSyncError = Object.assign(new Error(reason), {
    error_type: errorType,
    error_code: errorCode,
    status: 'error',
    reason,
    details: { originalError: error?.message, status },
  } satisfies BankSyncError);

  throw bankSyncError;
}

async function statusHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    const { secretId, secretKey } = await request.json<{
      secretId?: string;
      secretKey?: string;
    }>();

    if (secretId && secretKey) {
      await request.secrets.save('secretId', secretId);
      await request.secrets.save('secretKey', secretKey);
    }

    const configured = !!(
      (await request.secrets.get('secretId')) &&
      (await request.secrets.get('secretKey'))
    );

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
    const { requisitionId, secretId, secretKey } = await request.json<any>();

    if (secretId && secretKey) {
      await request.secrets.save('secretId', secretId);
      await request.secrets.save('secretKey', secretKey);
    }

    if (!requisitionId) {
      return errorResponse('requisitionId is required');
    }

    const client = await getGoCardlessClient(request);
    await ensureValidToken(client);

    const requisition =
      await client.requisition.getRequisitionById(requisitionId);
    const institutionName = await (async () => {
      try {
        const institution = await client.institution.getInstitutionById(
          requisition.institution_id,
        );
        return (institution?.name as string) || requisition.institution_id;
      } catch {
        return requisition.institution_id;
      }
    })();

    if (requisition.status !== 'LN') {
      return ok({
        error_type: 'REQUISITION_NOT_LINKED',
        error_code: 'REQUISITION_NOT_LINKED',
        status: 'pending',
        requisitionStatus: requisition.status,
        reason: 'Requisition is not yet linked',
      });
    }

    const accounts = await Promise.all(
      requisition.accounts.map(async (accountId: string) => {
        try {
          const [details, metadata] = await Promise.all([
            client.account(accountId).getDetails(),
            client.account(accountId).getMetadata(),
          ]);

          const accountDetails = details?.account || {};
          const metadataDetails = metadata || {};
          const mergedAccount: Record<string, unknown> = {};
          const uniqueKeys = new Set([
            ...Object.keys(accountDetails),
            ...Object.keys(metadataDetails),
          ]);

          for (const key of uniqueKeys) {
            mergedAccount[key] = metadataDetails[key] || accountDetails[key];
          }

          return {
            account_id: accountId,
            name:
              (mergedAccount.name as string) ||
              (mergedAccount.product as string) ||
              accountId,
            institution: institutionName,
            iban: mergedAccount.iban as string | undefined,
            mask: mergedAccount.iban
              ? (mergedAccount.iban as string).slice(-4)
              : accountId.slice(-4),
            official_name:
              (mergedAccount.name as string) ||
              (mergedAccount.product as string),
            currency: mergedAccount.currency as string | undefined,
          };
        } catch (error) {
          console.error(`Error fetching account ${accountId}:`, error);
          return null;
        }
      }),
    );

    return ok({ accounts: accounts.filter(a => a !== null) });
  } catch (error) {
    console.error('[GOCARDLESS ACCOUNTS] Error:', error);

    if ((error as any).type === 'BankSyncError') {
      return ok(error);
    }

    try {
      handleGoCardlessError(error);
    } catch (bankSyncError) {
      return ok(bankSyncError);
    }
  }
}

async function transactionsHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    const {
      requisitionId,
      accountId,
      startDate,
      endDate,
      includeBalance = true,
    } = await request.json<any>();

    if (!requisitionId || !accountId) {
      return errorResponse('requisitionId and accountId are required');
    }

    const client = await getGoCardlessClient(request);
    await ensureValidToken(client);

    const requisition =
      await client.requisition.getRequisitionById(requisitionId);
    const bank = bankFactory(requisition?.institution_id);

    if (requisition.status !== 'LN') {
      return ok({
        error_type: 'ITEM_ERROR',
        error_code: 'ITEM_LOGIN_REQUIRED',
        status: 'expired',
        reason: 'Access to account has expired',
      });
    }

    if (!requisition.accounts.includes(accountId)) {
      return ok({
        error_type: 'INVALID_INPUT',
        error_code: 'INVALID_ACCESS_TOKEN',
        status: 'rejected',
        reason: 'Account not linked with this requisition',
      });
    }

    const [transactionsResponse, balancesResponse] = await Promise.all([
      client
        .account(accountId)
        .getTransactions({ dateFrom: startDate, dateTo: endDate }),
      includeBalance ? client.account(accountId).getBalances() : null,
    ]);

    function normalizeTransaction(
      transaction: GoCardlessTransaction,
      booked: boolean,
    ):
      | (GoCardlessTransaction & {
          booked: boolean;
          date?: string;
          payeeName?: string;
          notes?: string;
          amount: number;
        })
      | null {
      const normalized = bank.normalizeTransaction(
        transaction as any,
        booked,
      ) as any | null;
      if (!normalized) return null;

      const date =
        normalized.date ||
        normalized.bookingDate ||
        normalized.bookingDateTime ||
        normalized.valueDate ||
        normalized.valueDateTime;
      const notes =
        normalized.notes ??
        normalized.remittanceInformationUnstructured ??
        (normalized.remittanceInformationUnstructuredArray || []).join(' ') ??
        '';
      const payeeName =
        normalized.payeeName ??
        normalized.creditorName ??
        normalized.debtorName ??
        '';

      return {
        ...normalized,
        booked,
        date,
        payeeName,
        notes,
        transactionId: normalized.transactionId,
        amount: parseFloat(normalized.transactionAmount.amount),
      };
    }

    const booked = (transactionsResponse?.transactions?.booked || [])
      .map((t: GoCardlessTransaction) => normalizeTransaction(t, true))
      .filter(Boolean) as any[];
    const pending = (transactionsResponse?.transactions?.pending || [])
      .map((t: GoCardlessTransaction) => normalizeTransaction(t, false))
      .filter(Boolean) as any[];

    bank.sortTransactions(booked);
    bank.sortTransactions(pending);

    const all = [...booked, ...pending];
    bank.sortTransactions(all);

    const result: any = {
      transactions: {
        all,
        booked,
        pending,
      },
    };

    if (balancesResponse && includeBalance) {
      result.balances = balancesResponse.balances;
      result.startingBalance = bank.calculateStartingBalance(
        all,
        balancesResponse.balances,
      );
    }

    return ok(result);
  } catch (error) {
    console.error('[GOCARDLESS TRANSACTIONS] Error:', error);

    if ((error as any).type === 'BankSyncError') {
      return ok(error);
    }

    try {
      handleGoCardlessError(error);
    } catch (bankSyncError) {
      return ok(bankSyncError);
    }
  }
}

async function banksHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    const { country, showDemo = false } = await request.json<any>();

    if (!country) {
      return errorResponse('country is required');
    }

    const client = await getGoCardlessClient(request);
    await ensureValidToken(client);

    const institutions = await client.institution.getInstitutions({ country });
    let data = institutions || [];

    if (showDemo) {
      data = [
        {
          id: 'SANDBOXFINANCE_SFIN0000',
          name: 'DEMO bank (used for testing bank-sync)',
        },
        ...data,
      ];
    }

    return ok(data);
  } catch (error) {
    console.error('[GOCARDLESS BANKS] Error:', error);

    if ((error as any).type === 'BankSyncError') {
      return ok(error);
    }

    try {
      handleGoCardlessError(error);
    } catch (bankSyncError) {
      return errorResponse(
        (bankSyncError as any).reason || 'Failed to fetch banks',
      );
    }
  }
}

async function createWebTokenHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    const {
      institutionId,
      accessValidForDays = 90,
      host,
    } = await request.json<any>();

    if (!institutionId) {
      return errorResponse('institutionId is required');
    }

    const client = await getGoCardlessClient(request);
    await ensureValidToken(client);

    const institution =
      await client.institution.getInstitutionById(institutionId);
    const accountSelection =
      institution.supported_features?.includes('account_selection') ?? false;

    const body = {
      redirectUrl: host + '/gocardless/link',
      institutionId,
      referenceId: uuidv4(),
      accessValidForDays: Math.min(
        accessValidForDays,
        institution.max_access_valid_for_days || 90,
      ),
      maxHistoricalDays: institution.transaction_total_days
        ? parseInt(institution.transaction_total_days) - 1
        : 89,
      userLanguage: 'en',
      ssn: null,
      redirectImmediate: false,
      accountSelection,
    };

    let response;
    try {
      response = await client.initSession(body);
    } catch {
      console.log('Failed to link using:', body);
      console.log(
        'Falling back to accessValidForDays = 90 and maxHistoricalDays = 89',
      );

      response = await client.initSession({
        ...body,
        accessValidForDays: 90,
        maxHistoricalDays: 89,
      });
    }

    return ok({ link: response.link, requisitionId: response.id });
  } catch (error) {
    console.error('[GOCARDLESS CREATE-WEB-TOKEN] Error:', error);

    if ((error as any).type === 'BankSyncError') {
      return errorResponse((error as any).reason);
    }

    try {
      handleGoCardlessError(error);
    } catch (bankSyncError) {
      return errorResponse(
        (bankSyncError as any).reason || 'Failed to create web token',
      );
    }
  }
}

async function getAccountsHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    const { requisitionId } = await request.json<any>();

    if (!requisitionId) {
      return errorResponse('requisitionId is required');
    }

    const client = await getGoCardlessClient(request);
    await ensureValidToken(client);

    const requisition =
      await client.requisition.getRequisitionById(requisitionId);
    const institutionName = await (async () => {
      try {
        const institution = await client.institution.getInstitutionById(
          requisition.institution_id,
        );
        return (institution?.name as string) || requisition.institution_id;
      } catch {
        return requisition.institution_id;
      }
    })();

    if (requisition.status !== 'LN') {
      return json({ status: 'ok', requisitionStatus: requisition.status });
    }

    const accounts = await Promise.all(
      requisition.accounts.map(async (accountId: string) => {
        try {
          const [details, metadata] = await Promise.all([
            client.account(accountId).getDetails(),
            client.account(accountId).getMetadata(),
          ]);

          const accountDetails = details?.account || {};
          const metadataDetails = metadata || {};
          const mergedAccount: Record<string, unknown> = {};
          const uniqueKeys = new Set([
            ...Object.keys(accountDetails),
            ...Object.keys(metadataDetails),
          ]);

          for (const key of uniqueKeys) {
            mergedAccount[key] = metadataDetails[key] || accountDetails[key];
          }

          const iban = mergedAccount.iban as string | undefined;
          if (iban) {
            mergedAccount.iban = iban.slice(0, 4) + '****' + iban.slice(-4);
          }

          return {
            account_id: accountId,
            name:
              (mergedAccount.name as string) ||
              (mergedAccount.product as string) ||
              accountId,
            institution: institutionName,
            iban: mergedAccount.iban as string | undefined,
            mask: iban ? iban.slice(-4) : accountId.slice(-4),
            official_name:
              (mergedAccount.name as string) ||
              (mergedAccount.product as string),
            currency: mergedAccount.currency as string | undefined,
          };
        } catch (error) {
          console.error(`Error fetching account ${accountId}:`, error);
          return null;
        }
      }),
    );

    return ok({
      id: requisition.id,
      status: requisition.status,
      institution_id: requisition.institution_id,
      accounts: accounts.filter((a: any) => a !== null),
    });
  } catch (error) {
    console.error('[GOCARDLESS GET-ACCOUNTS] Error:', error);

    if ((error as any).type === 'BankSyncError') {
      return errorResponse((error as any).reason);
    }

    try {
      handleGoCardlessError(error);
    } catch (bankSyncError) {
      return errorResponse(
        (bankSyncError as any).reason || 'Failed to get accounts',
      );
    }
  }
}

async function removeAccountHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    const { requisitionId } = await request.json<any>();

    if (!requisitionId) {
      return errorResponse('requisitionId is required');
    }

    const client = await getGoCardlessClient(request);
    await ensureValidToken(client);

    const result = await client.requisition.deleteRequisition(requisitionId);

    if (result.summary === 'Requisition deleted') {
      return ok(result);
    }

    return json({
      status: 'error',
      data: {
        data: result,
        reason: 'Cannot delete requisition',
      },
    });
  } catch (error) {
    console.error('[GOCARDLESS REMOVE-ACCOUNT] Error:', error);

    if ((error as any).type === 'BankSyncError') {
      return errorResponse((error as any).reason);
    }

    try {
      handleGoCardlessError(error);
    } catch (bankSyncError) {
      return errorResponse(
        (bankSyncError as any).reason || 'Failed to remove account',
      );
    }
  }
}

export const plugin = defineSyncServerPlugin({
  routes: [
    route('GET', '/status', statusHandler),
    route('POST', '/status', statusHandler),
    route('POST', '/accounts', accountsHandler),
    route('POST', '/transactions', transactionsHandler),
    route('POST', '/banks', banksHandler),
    route('POST', '/create-web-token', createWebTokenHandler),
    route('POST', '/get-accounts', getAccountsHandler),
    route('POST', '/remove-account', removeAccountHandler),
  ],
});
