-- Add a scope column for plugin-based bank sync secrets usage.
-- 'global' means use global secrets scope (no x-actual-file-id header).
-- 'file' means use file-scoped secrets for the current budget file (x-actual-file-id header).

ALTER TABLE accounts ADD COLUMN account_sync_scope TEXT DEFAULT 'global';

UPDATE accounts
SET account_sync_scope = 'global'
WHERE account_sync_scope IS NULL;

