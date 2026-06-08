import {
  defineSyncServerPlugin,
  json,
  route,
} from '@actual-app/plugins-core-sync-server/plugin';
import type {
  SyncServerPluginRequest,
  SyncServerPluginResponse,
} from '@actual-app/plugins-core-sync-server/plugin';
import { v4 as uuidv4 } from 'uuid';

import './manifest';
import {
  enableBankingService,
  normalizeAccount,
  normalizeBalance,
  normalizeTransaction,
} from './services/enablebanking-service';
import type {
  EnableBankingAspsp,
  EnableBankingSession,
  PsuHeaders,
} from './services/enablebanking-service';
import { EnableBankingError } from './utils/errors';

type PluginRequest = SyncServerPluginRequest;

type PendingAuth = {
  id: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingAuths = new Map<string, PendingAuth>();
const completedAuths = new Map<string, unknown>();
const stateFileIds = new Map<string, string>();
let nextWaiterId = 0;

const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const COMPLETED_AUTH_TTL_MS = 30 * 1000;

function getFileIdFromRequest(request: PluginRequest): string {
  const body = (request.body ?? {}) as { fileId?: unknown };
  const rawFileId =
    request.fileId ||
    body.fileId ||
    request.query.fileId ||
    request.headers['x-actual-file-id'];
  const fileId = Array.isArray(rawFileId) ? rawFileId[0] : rawFileId;
  if (typeof fileId !== 'string' || fileId.trim() === '') {
    throw new Error('missing-file-id');
  }
  return fileId.trim();
}

function getSecretOptions(request: PluginRequest) {
  return { fileId: getFileIdFromRequest(request), secrets: request.secrets };
}

function extractPsuHeaders(request: PluginRequest): PsuHeaders {
  const forwardedFor = request.headers['x-forwarded-for'];
  const userAgent = request.headers['user-agent'];
  const ip = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const ua = Array.isArray(userAgent) ? userAgent[0] : userAgent;

  return {
    ...(typeof ip === 'string' ? { 'Psu-Ip-Address': ip } : {}),
    ...(typeof ua === 'string' ? { 'Psu-User-Agent': ua } : {}),
  };
}

function cleanupPendingAuth(state: string, waiterId?: string) {
  const entry = pendingAuths.get(state);
  if (entry && (waiterId == null || entry.id === waiterId)) {
    clearTimeout(entry.timer);
    pendingAuths.delete(state);
  }
}

function sendOk(data: unknown): SyncServerPluginResponse {
  return json({ status: 'ok', data });
}

function sendError(error: unknown): SyncServerPluginResponse {
  return sendOk({
    error: error instanceof Error ? error.message : 'unknown error',
  });
}

function isEnableBankingAspsp(value: unknown): value is EnableBankingAspsp {
  return (
    value != null &&
    typeof value === 'object' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'country' in value &&
    typeof value.country === 'string'
  );
}

async function buildSessionResult(
  session: EnableBankingSession,
  options: ReturnType<typeof getSecretOptions>,
  psuHeaders?: PsuHeaders,
) {
  const accountsWithBalances = await Promise.all(
    session.accounts.map(async account => {
      const normalized = normalizeAccount(account, session.aspsp);

      let balances: ReturnType<typeof normalizeBalance>[] = [];
      try {
        const balanceResult = await enableBankingService.getBalances(
          account.uid,
          psuHeaders,
          options,
        );
        balances = balanceResult.balances.map(normalizeBalance);
      } catch {
        balances = [];
      }

      const preferredBalance =
        balances.find(b => b.balanceType === 'CLAV') ?? balances[0];

      return {
        ...normalized,
        bank_id: account.uid,
        balance: preferredBalance ? preferredBalance.balanceAmount.amount : 0,
        balances,
      };
    }),
  );

  return {
    session_id: session.session_id,
    accounts: accountsWithBalances,
    aspsp: session.aspsp,
  };
}

async function statusHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    return sendOk({
      configured: await enableBankingService.isConfigured(
        getSecretOptions(request),
      ),
    });
  } catch (error) {
    return sendError(error);
  }
}

async function configureHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    const { applicationId, secretKey } = await request.json<{
      applicationId?: string;
      secretKey?: string;
    }>();

    if (!applicationId || !secretKey) {
      return sendOk({
        error_code: 'INVALID_INPUT',
        error_type: 'Missing applicationId or secretKey',
      });
    }

    try {
      await enableBankingService.validateCredentials(applicationId, secretKey);
    } catch (error) {
      return sendOk({
        error_code: 'CONFIGURATION_FAILED',
        error_type: error instanceof Error ? error.message : 'unknown error',
      });
    }

    await request.secrets.save('applicationId', applicationId);
    await request.secrets.save('secretKey', secretKey);

    return sendOk({ configured: true });
  } catch (error) {
    return sendError(error);
  }
}

async function aspspsHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    const { country } = await request.json<{ country?: string }>();
    const aspsps = await enableBankingService.getAspsps(
      country,
      getSecretOptions(request),
    );
    return sendOk({ aspsps });
  } catch (error) {
    return sendOk({
      error: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

async function startAuthHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    const options = getSecretOptions(request);
    const { aspsp, redirectUrl, maxConsentValidity } = await request.json<{
      aspsp?: unknown;
      redirectUrl?: string;
      maxConsentValidity?: number;
    }>();

    if (!isEnableBankingAspsp(aspsp) || !redirectUrl) {
      return sendOk({
        error_code: 'INVALID_INPUT',
        error_type: 'Missing aspsp or redirectUrl',
      });
    }

    const state = uuidv4();
    const authResponse = await enableBankingService.startAuth(
      aspsp,
      redirectUrl,
      state,
      typeof maxConsentValidity === 'number' ? maxConsentValidity : undefined,
      options,
    );
    stateFileIds.set(state, options.fileId);
    setTimeout(() => stateFileIds.delete(state), POLL_TIMEOUT_MS);

    return sendOk({
      url: authResponse.url,
      state,
    });
  } catch (error) {
    return sendOk({
      error: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

async function completeAuthHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  const { code, state } = await request.json<{
    code?: string;
    state?: string;
  }>();

  if (!code) {
    return sendOk({
      error_code: 'INVALID_INPUT',
      error_type: 'Missing code',
    });
  }

  try {
    const fileId = state ? stateFileIds.get(state) : undefined;
    const options = {
      fileId: fileId ?? getFileIdFromRequest(request),
      secrets: request.secrets,
    };
    const session = await enableBankingService.createSession(code, options);
    const result = await buildSessionResult(
      session,
      options,
      extractPsuHeaders(request),
    );

    if (state) {
      completedAuths.set(state, result);
      setTimeout(() => completedAuths.delete(state), COMPLETED_AUTH_TTL_MS);

      const pending = pendingAuths.get(state);
      if (pending) {
        pending.resolve(result);
        cleanupPendingAuth(state);
      }
      stateFileIds.delete(state);
    }

    return sendOk(result);
  } catch (error) {
    const errorResult = {
      error: error instanceof Error ? error.message : 'unknown error',
    };

    if (state) {
      completedAuths.set(state, errorResult);
      setTimeout(() => completedAuths.delete(state), COMPLETED_AUTH_TTL_MS);

      const pending = pendingAuths.get(state);
      if (pending) {
        pending.reject(error);
        cleanupPendingAuth(state);
      }
      stateFileIds.delete(state);
    }

    return sendOk(errorResult);
  }
}

async function pollAuthHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  const { state } = await request.json<{ state?: string }>();

  if (!state) {
    return sendOk({
      error_code: 'INVALID_INPUT',
      error_type: 'Missing state',
    });
  }

  const waiterId = String(++nextWaiterId);

  try {
    if (completedAuths.has(state)) {
      const result = completedAuths.get(state);
      completedAuths.delete(state);
      return sendOk(result);
    }

    const result = await new Promise((resolve, reject) => {
      const existing = pendingAuths.get(state);
      if (existing) {
        clearTimeout(existing.timer);
        existing.reject(new Error('Poll superseded'));
      }

      let settled = false;
      const safeResolve = (value: unknown) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const safeReject = (reason: unknown) => {
        if (settled) return;
        settled = true;
        reject(reason);
      };

      const timer = setTimeout(() => {
        cleanupPendingAuth(state, waiterId);
        safeReject(new Error('timeout'));
      }, POLL_TIMEOUT_MS);

      pendingAuths.set(state, {
        id: waiterId,
        resolve: safeResolve,
        reject: safeReject,
        timer,
      });
    });

    return sendOk(result);
  } catch (error) {
    cleanupPendingAuth(state, waiterId);
    return sendError(error);
  }
}

async function pollAuthStopHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  const { state } = await request.json<{ state?: string }>();
  if (typeof state === 'string') {
    cleanupPendingAuth(state);
  }
  return sendOk({});
}

async function accountsHandler(): Promise<SyncServerPluginResponse> {
  return sendOk({
    error_code: 'AUTH_REQUIRED',
    error_type: 'Enable Banking accounts must be linked through authorization',
  });
}

async function transactionsHandler(
  request: PluginRequest,
): Promise<SyncServerPluginResponse> {
  try {
    const options = getSecretOptions(request);
    const { accountId, startDate } = await request.json<{
      accountId?: string;
      startDate?: string | number | Date;
    }>();

    if (!accountId || !startDate) {
      return sendOk({
        error_code: 'INVALID_INPUT',
        error_type: 'Missing accountId or startDate',
      });
    }

    const psuHeaders = extractPsuHeaders(request);
    const dateTo = new Date().toISOString().split('T')[0];
    const dateFrom =
      typeof startDate === 'string'
        ? startDate
        : new Date(startDate).toISOString().split('T')[0];

    const balanceResult = await enableBankingService.getBalances(
      accountId,
      psuHeaders,
      options,
    );
    const balances = balanceResult.balances.map(normalizeBalance);
    const preferredBalance =
      balances.find(b => b.balanceType === 'CLAV') ?? balances[0];
    const startingBalance = preferredBalance
      ? preferredBalance.balanceAmount.amount
      : 0;

    const rawTransactions = await enableBankingService.getAllTransactions(
      accountId,
      dateFrom,
      dateTo,
      psuHeaders,
      options,
    );

    const all = rawTransactions.map(normalizeTransaction);
    const booked = all.filter(tx => tx.booked);
    const pending = all.filter(tx => !tx.booked);

    return sendOk({
      transactions: {
        all,
        booked,
        pending,
      },
      balances,
      startingBalance,
    });
  } catch (error) {
    if (error instanceof EnableBankingError) {
      if (error.error_code === 'INVALID_ACCESS_TOKEN') {
        return sendOk({
          error_type: 'ITEM_ERROR',
          error_code: 'ITEM_LOGIN_REQUIRED',
        });
      }

      return sendOk({
        error_type:
          error.error_code === 'NOT_FOUND' ? 'INVALID_INPUT' : error.error_code,
        error_code: error.error_code,
      });
    }

    return sendOk({
      error_type: 'INTERNAL_ERROR',
      error_code: 'INTERNAL_ERROR',
    });
  }
}

export const plugin = defineSyncServerPlugin({
  routes: [
    route('GET', '/status', statusHandler),
    route('POST', '/status', statusHandler),
    route('POST', '/configure', configureHandler),
    route('POST', '/aspsps', aspspsHandler),
    route('POST', '/start-auth', startAuthHandler),
    route('POST', '/complete-auth', completeAuthHandler),
    route('POST', '/poll-auth', pollAuthHandler),
    route('POST', '/poll-auth-stop', pollAuthStopHandler),
    route('POST', '/accounts', accountsHandler),
    route('POST', '/transactions', transactionsHandler),
  ],
});
