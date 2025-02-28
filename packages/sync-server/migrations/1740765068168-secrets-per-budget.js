import { getAccountDb } from '../src/account-db.js';

export const up = async function () {
  const accountDb = getAccountDb();

  accountDb.exec(
    `
    ALTER TABLE secrets
        ADD COLUMN file_id TEXT;
    `,
  );
};

export const down = async function () {
  await getAccountDb().exec(
    `
      BEGIN TRANSACTION;

      CREATE TABLE secrets_backup (
        name TEXT PRIMARY KEY,
        value BLOB
      );

      INSERT INTO secrets_backup (name, value)
      SELECT name, value FROM secrets;

      DROP TABLE secrets;

      ALTER TABLE secrets_backup RENAME TO secrets;

      COMMIT;
      `,
  );
};
