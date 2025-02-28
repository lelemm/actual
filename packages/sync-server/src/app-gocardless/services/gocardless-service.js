import jwt from 'jws';
import * as nordigenNode from 'nordigen-node';
import { v4 as uuidv4 } from 'uuid';

import { SecretName, secretsService } from '../../services/secrets-service.js';
import { BankFactory, BANKS_WITH_LIMITED_HISTORY } from '../bank-factory.js';
import {
  AccessDeniedError,
  AccountNotLinkedToRequisition,
  GenericGoCardlessError,
  InvalidInputDataError,
  InvalidGoCardlessTokenError,
  NotFoundError,
  RateLimitError,
  ResourceSuspended,
  RequisitionNotLinked,
  ServiceError,
  UnknownError,
} from '../errors.js';

const GoCardlessClient = nordigenNode.default;

const clients = new Map();

const getGocardlessClient = fileId => {
  const secrets = {
    secretId: secretsService.get(SecretName.gocardless_secretId, fileId),
    secretKey: secretsService.get(SecretName.gocardless_secretKey, fileId),
  };

  const hash = JSON.stringify(secrets);

  if (!clients.has(hash)) {
    clients.set(hash, new GoCardlessClient(secrets));
  }

  return clients.get(hash);
};

export const handleGoCardlessError = error => {
  const status = error?.response?.status;

  switch (status) {
    case 400:
      throw new InvalidInputDataError(error);
    case 401:
      throw new InvalidGoCardlessTokenError(error);
    case 403:
      throw new AccessDeniedError(error);
    case 404:
      throw new NotFoundError(error);
    case 409:
      throw new ResourceSuspended(error);
    case 429:
      throw new RateLimitError(error);
    case 500:
      throw new UnknownError(error);
    case 503:
      throw new ServiceError(error);
    default:
      throw new GenericGoCardlessError(error);
  }
};

export const goCardlessService = {
  /**
   * Check if the GoCardless service is configured to be used.
   * @returns {boolean}
   */
  isConfigured: fileId => {
    return !!(
      getGocardlessClient(fileId).secretId &&
      getGocardlessClient(fileId).secretKey
    );
  },

  /**
   *
   * @returns {Promise<void>}
   */
  setToken: async fileId => {
    const isExpiredJwtToken = token => {
      const decodedToken = jwt.decode(token);
      if (!decodedToken) {
        return true;
      }
      const payload = decodedToken.payload;
      const clockTimestamp = Math.floor(Date.now() / 1000);
      return clockTimestamp >= payload.exp;
    };

    if (isExpiredJwtToken(getGocardlessClient(fileId).token)) {
      // Generate new access token. Token is valid for 24 hours
      // Note: access_token is automatically injected to other requests after you successfully obtain it
      try {
        await client.generateToken(fileId);
      } catch (error) {
        handleGoCardlessError(error);
      }
    }
  },

  /**
   *
   * @param requisitionId
   * @throws {RequisitionNotLinked} Will throw an error if requisition is not in Linked
   * @throws {InvalidInputDataError}
   * @throws {InvalidGoCardlessTokenError}
   * @throws {AccessDeniedError}
   * @throws {NotFoundError}
   * @throws {ResourceSuspended}
   * @throws {RateLimitError}
   * @throws {UnknownError}
   * @throws {ServiceError}
   * @returns {Promise<import('../gocardless-node.types.js').Requisition>}
   */
  getLinkedRequisition: async (requisitionId, fileId) => {
    const requisition = await goCardlessService.getRequisition(
      requisitionId,
      fileId,
    );

    const { status } = requisition;

    // Continue only if status of requisition is "LN" what does
    // mean that account has been successfully linked to requisition
    if (status !== 'LN') {
      throw new RequisitionNotLinked({ requisitionStatus: status });
    }

    return requisition;
  },

  /**
   * Returns requisition and all linked accounts in their Bank format.
   * Each account object is extended about details of the institution
   * @param requisitionId
   * @throws {RequisitionNotLinked} Will throw an error if requisition is not in Linked
   * @throws {InvalidInputDataError}
   * @throws {InvalidGoCardlessTokenError}
   * @throws {AccessDeniedError}
   * @throws {NotFoundError}
   * @throws {ResourceSuspended}
   * @throws {RateLimitError}
   * @throws {UnknownError}
   * @throws {ServiceError}
   * @returns {Promise<{requisition: import('../gocardless-node.types.js').Requisition, accounts: Array<import('../gocardless.types.js').NormalizedAccountDetails>}>}
   */
  getRequisitionWithAccounts: async (requisitionId, fileId) => {
    const requisition = await goCardlessService.getLinkedRequisition(
      requisitionId,
      fileId,
    );

    const institutionIdSet = new Set();
    const detailedAccounts = await Promise.all(
      requisition.accounts.map(async accountId => {
        const account = await goCardlessService.getDetailedAccount(
          accountId,
          fileId,
        );
        institutionIdSet.add(account.institution_id);
        return account;
      }),
    );

    const institutions = await Promise.all(
      Array.from(institutionIdSet).map(async institutionId => {
        return await goCardlessService.getInstitution(institutionId, fileId);
      }),
    );

    const extendedAccounts =
      await goCardlessService.extendAccountsAboutInstitutions({
        accounts: detailedAccounts,
        institutions,
      });

    const normalizedAccounts = extendedAccounts.map(account => {
      const bankAccount = BankFactory(account.institution_id);
      return bankAccount.normalizeAccount(account);
    });

    return { requisition, accounts: normalizedAccounts };
  },

  /**
   *
   * @param requisitionId
   * @param accountId
   * @param startDate
   * @param endDate
   * @throws {AccountNotLinkedToRequisition} Will throw an error if requisition not includes provided account id
   * @throws {RequisitionNotLinked} Will throw an error if requisition is not in Linked
   * @throws {InvalidInputDataError}
   * @throws {InvalidGoCardlessTokenError}
   * @throws {AccessDeniedError}
   * @throws {NotFoundError}
   * @throws {ResourceSuspended}
   * @throws {RateLimitError}
   * @throws {UnknownError}
   * @throws {ServiceError}
   * @returns {Promise<{balances: Array<import('../gocardless-node.types.js').Balance>, institutionId: string, transactions: {booked: Array<import('../gocardless-node.types.js').Transaction>, pending: Array<import('../gocardless-node.types.js').Transaction>, all: Array<import('../gocardless.types.js').TransactionWithBookedStatus>}, startingBalance: number}>}
   */
  getTransactionsWithBalance: async (
    requisitionId,
    accountId,
    startDate,
    endDate,
    fileId,
  ) => {
    const { institution_id, accounts: accountIds } =
      await goCardlessService.getLinkedRequisition(requisitionId, fileId);

    if (!accountIds.includes(accountId)) {
      throw new AccountNotLinkedToRequisition(accountId, requisitionId);
    }

    const [normalizedTransactions, accountBalance] = await Promise.all([
      goCardlessService.getNormalizedTransactions(
        requisitionId,
        accountId,
        startDate,
        endDate,
        fileId,
      ),
      goCardlessService.getBalances(accountId, fileId),
    ]);

    const transactions = normalizedTransactions.transactions;

    const bank = BankFactory(institution_id);

    const startingBalance = bank.calculateStartingBalance(
      transactions.booked,
      accountBalance.balances,
    );

    return {
      balances: accountBalance.balances,
      institutionId: institution_id,
      startingBalance,
      transactions,
    };
  },

  /**
   *
   * @param requisitionId
   * @param accountId
   * @param startDate
   * @param endDate
   * @throws {AccountNotLinkedToRequisition} Will throw an error if requisition not includes provided account id
   * @throws {RequisitionNotLinked} Will throw an error if requisition is not in Linked
   * @throws {InvalidInputDataError}
   * @throws {InvalidGoCardlessTokenError}
   * @throws {AccessDeniedError}
   * @throws {NotFoundError}
   * @throws {ResourceSuspended}
   * @throws {RateLimitError}
   * @throws {UnknownError}
   * @throws {ServiceError}
   * @returns {Promise<{institutionId: string, transactions: {booked: Array<import('../gocardless-node.types.js').Transaction>, pending: Array<import('../gocardless-node.types.js').Transaction>, all: Array<import('../gocardless.types.js').TransactionWithBookedStatus>}}>}
   */
  getNormalizedTransactions: async (
    requisitionId,
    accountId,
    startDate,
    endDate,
    fileId,
  ) => {
    const { institution_id, accounts: accountIds } =
      await goCardlessService.getLinkedRequisition(requisitionId, fileId);

    if (!accountIds.includes(accountId)) {
      throw new AccountNotLinkedToRequisition(accountId, requisitionId);
    }

    const transactions = await goCardlessService.getTransactions({
      institutionId: institution_id,
      accountId,
      startDate,
      endDate,
      fileId,
    });

    const bank = BankFactory(institution_id);
    const sortedBookedTransactions = bank.sortTransactions(
      transactions.transactions?.booked,
    );
    const sortedPendingTransactions = bank.sortTransactions(
      transactions.transactions?.pending,
    );
    const allTransactions = sortedBookedTransactions.map(t => {
      return { ...t, booked: true };
    });
    sortedPendingTransactions.forEach(t =>
      allTransactions.push({ ...t, booked: false }),
    );
    const sortedAllTransactions = bank.sortTransactions(allTransactions);

    return {
      institutionId: institution_id,
      transactions: {
        booked: sortedBookedTransactions,
        pending: sortedPendingTransactions,
        all: sortedAllTransactions,
      },
    };
  },

  /**
   *
   * @param {import('../gocardless.types.js').CreateRequisitionParams} params
   * @throws {InvalidInputDataError}
   * @throws {InvalidGoCardlessTokenError}
   * @throws {AccessDeniedError}
   * @throws {NotFoundError}
   * @throws {ResourceSuspended}
   * @throws {RateLimitError}
   * @throws {UnknownError}
   * @throws {ServiceError}
   * @returns {Promise<{requisitionId, link}>}
   */
  createRequisition: async ({ institutionId, host, fileId }) => {
    await goCardlessService.setToken(fileId);

    const institution = await goCardlessService.getInstitution(
      institutionId,
      fileId,
    );

    let response;
    try {
      response = await client(fileId).initSession({
        redirectUrl: host + '/gocardless/link',
        institutionId,
        referenceId: uuidv4(),
        accessValidForDays: institution.max_access_valid_for_days,
        maxHistoricalDays: BANKS_WITH_LIMITED_HISTORY.includes(institutionId)
          ? Number(institution.transaction_total_days) >= 90
            ? '89'
            : institution.transaction_total_days
          : institution.transaction_total_days,
        userLanguage: 'en',
        ssn: null,
        redirectImmediate: false,
        accountSelection: false,
      });
    } catch (error) {
      handleGoCardlessError(error);
    }

    const { link, id: requisitionId } = response;

    return {
      link,
      requisitionId,
    };
  },

  /**
   * Deletes requisition by provided ID
   * @param requisitionId
   * @throws {InvalidInputDataError}
   * @throws {InvalidGoCardlessTokenError}
   * @throws {AccessDeniedError}
   * @throws {NotFoundError}
   * @throws {ResourceSuspended}
   * @throws {RateLimitError}
   * @throws {UnknownError}
   * @throws {ServiceError}
   * @returns {Promise<{summary: string, detail: string}>}
   */
  deleteRequisition: async (requisitionId, fileId) => {
    await goCardlessService.getRequisition(requisitionId, fileId);

    let response;
    try {
      response = client(fileId).deleteRequisition(requisitionId);
    } catch (error) {
      handleGoCardlessError(error);
    }

    return response;
  },

  /**
   * Retrieve a requisition by ID
   * https://nordigen.com/en/docs/account-information/integration/parameters-and-responses/#/requisitions/requisition%20by%20id
   * @param { string } requisitionId
   * @throws {InvalidInputDataError}
   * @throws {InvalidGoCardlessTokenError}
   * @throws {AccessDeniedError}
   * @throws {NotFoundError}
   * @throws {ResourceSuspended}
   * @throws {RateLimitError}
   * @throws {UnknownError}
   * @throws {ServiceError}
   * @returns { Promise<import('../gocardless-node.types.js').Requisition> }
   */
  getRequisition: async (requisitionId, fileId) => {
    await goCardlessService.setToken(fileId);

    let response;
    try {
      response = client(fileId).getRequisitionById(requisitionId);
    } catch (error) {
      handleGoCardlessError(error);
    }

    return response;
  },

  /**
   * Retrieve an detailed account by account id
   * @param accountId
   * @returns {Promise<import('../gocardless.types.js').DetailedAccount>}
   */
  getDetailedAccount: async (accountId, fileId) => {
    let detailedAccount, metadataAccount;
    const cli = client(fileId);
    try {
      [detailedAccount, metadataAccount] = await Promise.all([
        cli.getDetails(accountId),
        cli.getMetadata(accountId),
      ]);
    } catch (error) {
      handleGoCardlessError(error);
    }

    return {
      ...detailedAccount.account,
      ...metadataAccount,
    };
  },

  /**
   * Retrieve account metadata by account id
   *
   * Unlike getDetailedAccount, this method is not affected by institution rate-limits.
   *
   * @param accountId
   * @returns {Promise<import('../gocardless-node.types.js').GoCardlessAccountMetadata>}
   */
  getAccountMetadata: async (accountId, fileId) => {
    let response;
    try {
      response = await client(fileId).getMetadata(accountId);
    } catch (error) {
      handleGoCardlessError(error);
    }

    return response;
  },

  /**
   * Retrieve details about all Institutions in a specific country
   * @param country
   * @throws {InvalidInputDataError}
   * @throws {InvalidGoCardlessTokenError}
   * @throws {AccessDeniedError}
   * @throws {NotFoundError}
   * @throws {ResourceSuspended}
   * @throws {RateLimitError}
   * @throws {UnknownError}
   * @throws {ServiceError}
   * @returns {Promise<Array<import('../gocardless-node.types.js').Institution>>}
   */
  getInstitutions: async (country, fileId) => {
    let response;
    try {
      response = await client(fileId).getInstitutions(country);
    } catch (error) {
      handleGoCardlessError(error);
    }

    return response;
  },

  /**
   * Retrieve details about a specific Institution
   * @param institutionId
   * @throws {InvalidInputDataError}
   * @throws {InvalidGoCardlessTokenError}
   * @throws {AccessDeniedError}
   * @throws {NotFoundError}
   * @throws {ResourceSuspended}
   * @throws {RateLimitError}
   * @throws {UnknownError}
   * @throws {ServiceError}
   * @returns {Promise<import('../gocardless-node.types.js').Institution>}
   */
  getInstitution: async (institutionId, fileId) => {
    let response;
    try {
      response = await client(fileId).getInstitutionById(institutionId);
    } catch (error) {
      handleGoCardlessError(error);
    }

    return response;
  },

  /**
   * Extends provided accounts about details of their institution
   * @param {{accounts: Array<import('../gocardless.types.js').DetailedAccount>, institutions: Array<import('../gocardless-node.types.js').Institution>}} params
   * @returns {Promise<Array<import('../gocardless.types.js').DetailedAccount&{institution: import('../gocardless-node.types.js').Institution}>>}
   */
  extendAccountsAboutInstitutions: async ({ accounts, institutions }) => {
    const institutionsById = institutions.reduce((acc, institution) => {
      acc[institution.id] = institution;
      return acc;
    }, {});

    return accounts.map(account => {
      const institution = institutionsById[account.institution_id] || null;
      return {
        ...account,
        institution,
      };
    });
  },

  /**
   * Returns account transaction in provided dates
   * @param {import('../gocardless.types.js').GetTransactionsParams} params
   * @throws {InvalidInputDataError}
   * @throws {InvalidGoCardlessTokenError}
   * @throws {AccessDeniedError}
   * @throws {NotFoundError}
   * @throws {ResourceSuspended}
   * @throws {RateLimitError}
   * @throws {UnknownError}
   * @throws {ServiceError}
   * @returns {Promise<import('../gocardless.types.js').GetTransactionsResponse>}
   */
  getTransactions: async ({
    institutionId,
    accountId,
    startDate,
    endDate,
    fileId,
  }) => {
    let response;
    try {
      response = await client(fileId).getTransactions({
        accountId,
        dateFrom: startDate,
        dateTo: endDate,
      });
    } catch (error) {
      handleGoCardlessError(error);
    }

    const bank = BankFactory(institutionId);
    response.transactions.booked = response.transactions.booked
      .map(transaction => bank.normalizeTransaction(transaction, true))
      .filter(transaction => transaction);
    response.transactions.pending = response.transactions.pending
      .map(transaction => bank.normalizeTransaction(transaction, false))
      .filter(transaction => transaction);

    return response;
  },

  /**
   * Returns account available balances
   * @param accountId
   * @throws {InvalidInputDataError}
   * @throws {InvalidGoCardlessTokenError}
   * @throws {AccessDeniedError}
   * @throws {NotFoundError}
   * @throws {ResourceSuspended}
   * @throws {RateLimitError}
   * @throws {UnknownError}
   * @throws {ServiceError}
   * @returns {Promise<import('../gocardless.types.js').GetBalances>}
   */
  getBalances: async (accountId, fileId) => {
    let response;
    try {
      response = await client(fileId).getBalances(accountId);
    } catch (error) {
      handleGoCardlessError(error);
    }

    return response;
  },
};

/**
 * All executions of goCardlessClient should be here for testing purposes,
 * as the nordigen-node library is not written in a way that is conducive to testing.
 * In that way we can mock the `client` const instead of nordigen library
 */
export const client = fileId => ({
  getBalances: async accountId =>
    await getGocardlessClient(fileId).account(accountId).getBalances(),
  getTransactions: async ({ accountId, dateFrom, dateTo }) =>
    await getGocardlessClient(fileId).account(accountId).getTransactions({
      dateFrom,
      dateTo,
      country: undefined,
    }),
  getInstitutions: async country =>
    await getGocardlessClient(fileId).institution.getInstitutions({ country }),
  getInstitutionById: async institutionId =>
    await getGocardlessClient(fileId).institution.getInstitutionById(
      institutionId,
    ),
  getDetails: async accountId =>
    await getGocardlessClient(fileId).account(accountId).getDetails(),
  getMetadata: async accountId =>
    await getGocardlessClient(fileId).account(accountId).getMetadata(),
  getRequisitionById: async requisitionId =>
    await getGocardlessClient(fileId).requisition.getRequisitionById(
      requisitionId,
    ),
  deleteRequisition: async requisitionId =>
    await getGocardlessClient(fileId).requisition.deleteRequisition(
      requisitionId,
    ),
  initSession: async ({
    redirectUrl,
    institutionId,
    referenceId,
    accessValidForDays,
    maxHistoricalDays,
    userLanguage,
    ssn,
    redirectImmediate,
    accountSelection,
  }) =>
    await getGocardlessClient(fileId).initSession({
      redirectUrl,
      institutionId,
      referenceId,
      accessValidForDays,
      maxHistoricalDays,
      userLanguage,
      ssn,
      redirectImmediate,
      accountSelection,
    }),
  generateToken: async () => await getGocardlessClient(fileId).generateToken(),
  exchangeToken: async ({ refreshToken }) =>
    await getGocardlessClient(fileId).exchangeToken({ refreshToken }),
});
