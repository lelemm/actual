import createDebug from 'debug';

import { getAccountDb } from '../account-db.js';

/**
 * An enum of valid secret names.
 * @readonly
 * @enum {string}
 */
export const SecretName = {
  gocardless_secretId: 'gocardless_secretId',
  gocardless_secretKey: 'gocardless_secretKey',
  simplefin_token: 'simplefin_token',
  simplefin_accessKey: 'simplefin_accessKey',
  pluggyai_clientId: 'pluggyai_clientId',
  pluggyai_clientSecret: 'pluggyai_clientSecret',
  pluggyai_itemIds: 'pluggyai_itemIds',
};

class SecretsDb {
  constructor() {
    this.debug = createDebug('actual:secrets-db');
    this.db = null;
  }

  open() {
    return getAccountDb();
  }

  set(name, value, fileId = null) {
    if (!this.db) {
      this.db = this.open();
    }

    const debugStr = fileId
      ? `setting secret '${name}' for file '${fileId}' to '${value}'`
      : `setting global secret '${name}' to '${value}'`;
    this.debug(debugStr);

    const result = this.db.mutate(
      `INSERT OR REPLACE INTO secrets (name, value, file_id) VALUES (?,?,?)`,
      [name, value, fileId],
    );
    return result;
  }

  get(name, fileId = null) {
    if (!this.db) {
      this.db = this.open();
    }

    const debugStr = fileId
      ? `getting secret '${name}' for file '${fileId}'`
      : `getting global secret '${name}'`;
    this.debug(debugStr);

    const result = this.db.first(
      `SELECT value FROM secrets WHERE name = ? AND file_id IS ?`,
      [name, fileId],
    );
    return result;
  }

  // New method to get secrets with fallback (file-specific first, then global)
  getWithFallback(name, fileId) {
    if (!fileId) {
      return this.get(name);
    }

    // Try to get file-specific secret first
    const result = this.get(name, fileId);
    if (result) {
      return result;
    }

    // Fall back to global secret
    return this.get(name);
  }
}

const secretsDb = new SecretsDb();
const _cachedSecrets = new Map();
/**
 * A service for managing secrets stored in `secretsDb`.
 */
export const secretsService = {
  /**
   * Retrieves the value of a secret by name.
   * @param {SecretName} name - The name of the secret to retrieve.
   * @param {string|null} fileId - Optional file ID for per-budget secrets.
   * @returns {string|null} The value of the secret, or null if the secret does not exist.
   */
  get: (name, fileId = null) => {
    const cacheKey = fileId ? `${fileId}_${name}` : name;
    return (
      _cachedSecrets.get(cacheKey) ?? secretsDb.get(name, fileId)?.value ?? null
    );
  },

  /**
   * Sets the value of a secret by name.
   * @param {SecretName} name - The name of the secret to set.
   * @param {string} value - The value to set for the secret.
   * @param {string|null} fileId - Optional file ID for per-budget secrets.
   * @returns {Object}
   */
  set: (name, value, fileId = null) => {
    const result = secretsDb.set(name, value, fileId);

    if (result.changes === 1) {
      const cacheKey = fileId ? `${fileId}_${name}` : name;
      _cachedSecrets.set(cacheKey, value);
    }
    return result;
  },

  /**
   * Gets a secret with fallback: tries file-specific first, then global.
   * @param {SecretName} name - The name of the secret to retrieve.
   * @param {string} fileId - The file ID for per-budget secrets.
   * @returns {string|null} The value of the secret, or null if not found.
   */
  getWithFallback: (name, fileId) => {
    return secretsDb.getWithFallback(name, fileId)?.value ?? null;
  },

  /**
   * Determines whether a secret with the given name exists.
   * @param {SecretName} name - The name of the secret to check for existence.
   * @param {string|null} fileId - Optional file ID for per-budget secrets.
   * @returns {boolean} True if a secret with the given name exists, false otherwise.
   */
  exists: (name, fileId = null) => {
    return Boolean(secretsService.get(name, fileId));
  },

  /**
   * Lists all secrets, optionally filtered by file ID.
   * @param {string|null} fileId - Optional file ID to filter by. If null, returns all secrets.
   * @returns {Array<{name: string, file_id: string|null}>} List of secrets with their metadata.
   */
  list: (fileId = null) => {
    let query = 'SELECT name, file_id FROM secrets';
    const params = [];

    if (fileId !== null) {
      query += ' WHERE file_id = ?';
      params.push(fileId);
    } else {
      query += ' WHERE file_id is null';
    }

    query += ' ORDER BY name';

    try {
      return getAccountDb().all(query, params);
    } catch (error) {
      console.error('Failed to list secrets:', error);
      return [];
    }
  },

  /**
   * Deletes a secret with the given name and file ID.
   * @param {SecretName} name - The name of the secret to delete.
   * @param {string|null} fileId - Optional file ID for per-budget secrets.
   */
  delete: (name, fileId = null) => {
    try {
      // Build cache key for deletion
      const cacheKey = fileId ? `${name}_${fileId}` : name;

      // Delete from database
      let query = 'DELETE FROM secrets WHERE name = ?';
      const params = [name];

      if (fileId !== null) {
        query += ' AND file_id = ?';
        params.push(fileId);
      } else {
        query += ' AND file_id IS NULL';
      }

      getAccountDb().mutate(query, params);

      // Clear from cache
      delete _cachedSecrets[cacheKey];
    } catch (error) {
      console.error('Failed to delete secret:', error);
      throw error;
    }
  },
};
