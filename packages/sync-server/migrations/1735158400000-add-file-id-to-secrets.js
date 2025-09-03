import { getAccountDb } from '../src/account-db.js';

export const up = async function () {
  const db = getAccountDb();

  // Add file_id column to secrets table
  await db.exec(`
    ALTER TABLE secrets ADD COLUMN file_id TEXT;
  `);

  // Create a composite index for performance
  await db.exec(`
    CREATE INDEX idx_secrets_file_id_name ON secrets(file_id, name);
  `);

  // Create a unique constraint for the combination
  // This will allow both global secrets (file_id = NULL) and per-file secrets
  await db.exec(`
    CREATE UNIQUE INDEX idx_secrets_unique_file_name 
    ON secrets(COALESCE(file_id, ''), name);
  `);
};

export const down = async function () {
  const db = getAccountDb();

  // Drop the indexes
  await db.exec(`
    DROP INDEX IF EXISTS idx_secrets_file_id_name;
  `);

  await db.exec(`
    DROP INDEX IF EXISTS idx_secrets_unique_file_name;
  `);

  // Remove the file_id column (SQLite doesn't support DROP COLUMN easily)
  // We'll need to recreate the table
  await db.exec(`
    CREATE TABLE secrets_backup AS SELECT name, value FROM secrets;
  `);

  await db.exec(`
    DROP TABLE secrets;
  `);

  await db.exec(`
    CREATE TABLE secrets (
      name TEXT PRIMARY KEY,
      value BLOB
    );
  `);

  await db.exec(`
    INSERT INTO secrets (name, value) SELECT name, value FROM secrets_backup;
  `);

  await db.exec(`
    DROP TABLE secrets_backup;
  `);
};
