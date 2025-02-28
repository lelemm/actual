import createDebug from 'debug';

import { getAccountDb } from '../account-db.js';
import { config } from '../load-config.js';

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
};

class SecretsDb {
  constructor() {
    this.debug = createDebug('actual:secrets-db');
    this.db = null;
  }

  open() {
    return getAccountDb();
  }

  set(name, value, fileId) {
    if (!this.db) {
      this.db = this.open();
    }

    this.debug(
      `setting secret '${name}' to '${value} for ${
        config.secretsPerBudget ? `file ${fileId}` : `serverwide`
      }'`,
    );
    const result = this.db.mutate(
      `INSERT OR REPLACE INTO secrets (name, value, file_id) VALUES (?,?,?)`,
      [name, value, config.secretsPerBudget ? fileId : null],
    );
    return result;
  }

  get(name, fileId) {
    if (!this.db) {
      this.db = this.open();
    }

    this.debug(
      `getting secret '${name}' for ${
        config.secretsPerBudget ? `file ${fileId}` : `serverwide`
      }`,
    );
    const result = this.db.first(
      `SELECT value FROM secrets WHERE name = ? and ifnull(file_id, '') = ?`,
      [name, config.secretsPerBudget ? fileId : ''],
    );
    return result;
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
   * @param {string} fileId - The file id associated to this secret.*
   * @returns {string|null} The value of the secret, or null if the secret does not exist.
   */
  get: (name, fileId) => {
    return (
      _cachedSecrets.get(
        config.secretsPerBudget ? `${name}:${fileId}` : name,
      ) ??
      secretsDb.get(name, fileId)?.value ??
      null
    );
  },

  /**
   * Sets the value of a secret by name.
   * @param {SecretName} name - The name of the secret to set.
   * @param {string} value - The value to set for the secret.
   * @param {string} fileId - The file id associated to this secret.
   * @returns {Object}
   */
  set: (name, value, fileId) => {
    const result = secretsDb.set(name, value, fileId);

    if (result.changes === 1) {
      _cachedSecrets.set(`${name}:${fileId}`, value);
    }
    return result;
  },

  /**
   * Determines whether a secret with the given name exists.
   * @param {SecretName} name - The name of the secret to check for existence.
   * * @param {string} fileId - The file id associated to this secret.
   * @returns {boolean} True if a secret with the given name exists, false otherwise.
   */
  exists: (name, fileId) => {
    return Boolean(secretsService.get(`${name}:${fileId}`));
  },
};
