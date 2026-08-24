import { getAccountDb } from '../src/account-db';

export const up = async function () {
  await getAccountDb().exec(`
    ALTER TABLE files ADD COLUMN server_access_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE files ADD COLUMN server_access_pending BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE files ADD COLUMN server_access_fingerprint TEXT;
    ALTER TABLE files ADD COLUMN server_access_sealed_key TEXT;
    ALTER TABLE files ADD COLUMN automation_timezone TEXT;
    ALTER TABLE files ADD COLUMN automation_last_run TEXT;
  `);
};

export const down = async function () {
  await getAccountDb().exec(`
    ALTER TABLE files DROP COLUMN automation_last_run;
    ALTER TABLE files DROP COLUMN automation_timezone;
    ALTER TABLE files DROP COLUMN server_access_sealed_key;
    ALTER TABLE files DROP COLUMN server_access_fingerprint;
    ALTER TABLE files DROP COLUMN server_access_pending;
    ALTER TABLE files DROP COLUMN server_access_enabled;
  `);
};
