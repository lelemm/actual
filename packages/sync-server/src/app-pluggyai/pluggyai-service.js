import { PluggyClient } from 'pluggy-sdk';

import { SecretName, secretsService } from '../services/secrets-service.js';

const pluggyClients = new Map();

function getPluggyClient(fileId = null) {
  const cacheKey = fileId || 'global';

  if (!pluggyClients.has(cacheKey)) {
    const clientId = secretsService.getWithFallback(
      SecretName.pluggyai_clientId,
      fileId,
    );
    const clientSecret = secretsService.getWithFallback(
      SecretName.pluggyai_clientSecret,
      fileId,
    );

    if (!clientId || !clientSecret) {
      return null;
    }

    const client = new PluggyClient({
      clientId,
      clientSecret,
    });

    pluggyClients.set(cacheKey, client);
  }

  return pluggyClients.get(cacheKey);
}

export const pluggyaiService = {
  isConfigured: (fileId = null) => {
    return !!(
      secretsService.getWithFallback(SecretName.pluggyai_clientId, fileId) &&
      secretsService.getWithFallback(
        SecretName.pluggyai_clientSecret,
        fileId,
      ) &&
      secretsService.getWithFallback(SecretName.pluggyai_itemIds, fileId)
    );
  },

  getAccountsByItemId: async (itemId, fileId = null) => {
    try {
      const client = getPluggyClient(fileId);
      if (!client) {
        throw new Error('Pluggy.ai client not configured for this budget');
      }
      const { results, total, ...rest } = await client.fetchAccounts(itemId);
      return {
        results,
        total,
        ...rest,
        hasError: false,
        errors: {},
      };
    } catch (error) {
      console.error(`Error fetching accounts: ${error.message}`);
      throw error;
    }
  },
  getAccountById: async (accountId, fileId = null) => {
    try {
      const client = getPluggyClient(fileId);
      if (!client) {
        throw new Error('Pluggy.ai client not configured for this budget');
      }
      const account = await client.fetchAccount(accountId);
      return {
        ...account,
        hasError: false,
        errors: {},
      };
    } catch (error) {
      console.error(`Error fetching account: ${error.message}`);
      throw error;
    }
  },

  getTransactionsByAccountId: async (
    accountId,
    startDate,
    pageSize,
    page,
    fileId = null,
  ) => {
    try {
      const client = getPluggyClient(fileId);
      if (!client) {
        throw new Error('Pluggy.ai client not configured for this budget');
      }

      const account = await pluggyaiService.getAccountById(accountId, fileId);

      // the sandbox data doesn't move the dates automatically so the
      // transactions are often older than 90 days. The owner on one of the
      // sandbox accounts is set to John Doe so in these cases we'll ignore
      // the start date.
      const sandboxAccount = account.owner === 'John Doe';

      if (sandboxAccount) startDate = '2000-01-01';

      const transactions = await client.fetchTransactions(accountId, {
        from: startDate,
        pageSize,
        page,
      });

      if (sandboxAccount) {
        transactions.results = transactions.results.map(t => ({
          ...t,
          sandbox: true,
        }));
      }

      return {
        ...transactions,
        hasError: false,
        errors: {},
      };
    } catch (error) {
      console.error(`Error fetching transactions: ${error.message}`);
      throw error;
    }
  },
  getTransactions: async (accountId, startDate, fileId = null) => {
    let transactions = [];
    let result = await pluggyaiService.getTransactionsByAccountId(
      accountId,
      startDate,
      500,
      1,
      fileId,
    );
    transactions = transactions.concat(result.results);
    const totalPages = result.totalPages;
    while (result.page !== totalPages) {
      result = await pluggyaiService.getTransactionsByAccountId(
        accountId,
        startDate,
        500,
        result.page + 1,
        fileId,
      );
      transactions = transactions.concat(result.results);
    }

    return transactions;
  },
};
