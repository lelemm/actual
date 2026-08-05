import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { vi } from 'vitest';

import { config } from './load-config.js';
import { sync } from './sync-simple.js';

const packageRoot = dirname(new URL(import.meta.url).pathname);
const fixturePath = join(
  packageRoot,
  '..',
  'contract',
  'fixtures',
  'historical-sqlite-golden.json',
);
const migrationsDirectory = join(packageRoot, '..', 'migrations');
const beforeAllMessages = '2025-01-01T00:00:00.000Z';

type AccountStep = { completed: number; sql: string };
type StateVariant = {
  id: string;
  completed: number;
  format:
    | 'absent'
    | 'empty'
    | 'legacy-position'
    | 'unknown-unrun'
    | 'unknown-run';
  title?: string;
  result: 'success' | 'missing-migration';
  expectedError?: string;
};
type MessageState = {
  id: string;
  groupId: string;
  sql: string | null;
  expectedMessages: number;
  expectedRows: Array<{
    timestamp: string;
    isEncrypted: number;
    contentHex: string;
  }>;
  expectedMerkle: string;
};
type MigrationState = {
  lastRun: string | null;
  migrations: Array<{ title: string; timestamp: number | null }>;
};
type GoldenRowValue = string | number | null | { blobHex: string };
type DowngradeState = {
  title: string;
  directoriesExist: boolean;
  accountDatabaseExists: boolean;
  tables: string[];
  schema: Record<string, string[]>;
  rows: Record<string, GoldenRowValue[][]>;
};
type GoldenFixture = {
  version: number;
  migrationTitles: string[];
  storedPaths: {
    migrationState: string;
    accountDatabase: string;
    messageDatabasePattern: string;
  };
  accountBaseSql: string;
  accountSteps: AccountStep[];
  currentAccountTables: string[];
  currentAccountSchema: Record<string, string[]>;
  stateVariants: StateVariant[];
  rollback: {
    completed: number;
    conflictSql: string;
    expectedLastRun: string;
    expectedSessionsColumns: string[];
    expectedUserAccessColumns: string[];
  };
  downgradeStates: DowngradeState[];
  downgradeRollback: {
    conflictSql: string;
    expectedLastRun: string;
    expectedTables: string[];
    expectedConflictSchema: string[];
    expectedRows: Record<string, GoldenRowValue[][]>;
  };
  messageSchema: Record<string, string[]>;
  messageStates: MessageState[];
};

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as GoldenFixture;
const originalUserFiles = config.get('userFiles');

function temporaryRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `actual-ts-historical-${label}-`));
}

function migrationState(completed: number): MigrationState {
  return {
    lastRun: completed === 0 ? null : fixture.migrationTitles[completed - 1],
    migrations: fixture.migrationTitles
      .slice(0, completed)
      .map((title, index) => ({
        title,
        timestamp: index + 1,
      })),
  };
}

function materializeAccountState(root: string, completed: number): void {
  if (completed >= 1) {
    mkdirSync(join(root, 'server-files'), { recursive: true });
    mkdirSync(join(root, 'user-files'), { recursive: true });
  }
  if (completed > 1) {
    const database = new Database(
      join(root, fixture.storedPaths.accountDatabase),
    );
    database.exec(fixture.accountBaseSql);
    for (const step of fixture.accountSteps) {
      if (step.completed <= completed) database.exec(step.sql);
    }
    database.close();
  }
  writeFileSync(
    join(root, fixture.storedPaths.migrationState),
    `${JSON.stringify(migrationState(completed), null, 2)}\n`,
  );
}

function writeStateVariant(root: string, variant: StateVariant): string {
  const statePath = join(root, fixture.storedPaths.migrationState);
  if (variant.format === 'absent') {
    rmSync(statePath);
    return '';
  } else if (variant.format === 'empty') {
    writeFileSync(statePath, '');
  } else if (variant.format === 'legacy-position') {
    writeFileSync(
      statePath,
      `${JSON.stringify({
        pos: variant.completed,
        migrations: fixture.migrationTitles
          .slice(0, variant.completed)
          .map((title, index) => ({ title, timestamp: index + 1 })),
      })}\n`,
    );
  } else {
    const state = migrationState(variant.completed);
    state.migrations.push({
      title: variant.title ?? '',
      timestamp: variant.format === 'unknown-run' ? 42 : null,
    });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
  return readFileSync(statePath, 'utf8');
}

async function runMigrations(
  root: string,
  direction: 'up' | 'down' = 'up',
): Promise<void> {
  const environment = {
    NODE_ENV: 'development',
    ACTUAL_DATA_DIR: root,
    ACTUAL_SERVER_FILES: join(root, 'server-files'),
    ACTUAL_USER_FILES: join(root, 'user-files'),
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map(key => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  vi.resetModules();
  try {
    const { run } = await import('./migrations.js');
    await run(direction);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.resetModules();
  }
}

function writeSingleMigrationState(root: string, title: string): void {
  writeFileSync(
    join(root, fixture.storedPaths.migrationState),
    `${JSON.stringify(
      {
        lastRun: title,
        migrations: fixture.migrationTitles.map(migrationTitle => ({
          title: migrationTitle,
          timestamp: migrationTitle === title ? 1 : null,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

function columns(database: Database.Database, table: string): string[] {
  return (
    database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).map(row => row.name);
}

function schema(database: Database.Database, table: string): string[] {
  return (
    database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>
  ).map(
    row =>
      `${row.name}|${row.type}|${row.notnull}|${row.dflt_value ?? ''}|${row.pk}`,
  );
}

function tables(database: Database.Database): string[] {
  return (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map(row => row.name);
}

function rows(
  database: Database.Database,
  table: string,
  columnCount: number,
): GoldenRowValue[][] {
  const order = Array.from(
    { length: columnCount },
    (_, index) => index + 1,
  ).join(', ');
  return (
    database
      .prepare(`SELECT * FROM ${table} ORDER BY ${order}`)
      .raw()
      .all() as unknown[][]
  ).map(row =>
    row.map(value =>
      Buffer.isBuffer(value)
        ? { blobHex: value.toString('hex') }
        : (value as string | number | null),
    ),
  );
}

function assertDowngradeState(root: string, state: DowngradeState): void {
  const serverFiles = join(root, 'server-files');
  const userFiles = join(root, 'user-files');
  const databasePath = join(root, fixture.storedPaths.accountDatabase);
  expect(existsSync(serverFiles), state.title).toBe(state.directoriesExist);
  expect(existsSync(userFiles), state.title).toBe(state.directoriesExist);
  expect(existsSync(databasePath), state.title).toBe(
    state.accountDatabaseExists,
  );
  if (!state.accountDatabaseExists) return;

  const database = new Database(databasePath, { readonly: true });
  expect(tables(database), state.title).toEqual(state.tables);
  for (const [table, expected] of Object.entries(state.schema)) {
    expect(schema(database, table), `${state.title}:${table}`).toEqual(
      expected,
    );
  }

  expect(Object.keys(state.rows).sort(), `${state.title}:row tables`).toEqual(
    state.tables,
  );
  for (const [table, expected] of Object.entries(state.rows)) {
    expect(
      rows(database, table, state.schema[table].length),
      `${state.title}:${table}:rows`,
    ).toEqual(expected);
  }
  database.close();
}

function assertCurrentAccountState(root: string, completed: number): void {
  const serverFiles = join(root, 'server-files');
  const userFiles = join(root, 'user-files');
  const accountDatabase = join(root, fixture.storedPaths.accountDatabase);
  expect(serverFiles).not.toBe(userFiles);
  expect(existsSync(serverFiles)).toBe(true);
  expect(existsSync(userFiles)).toBe(true);
  expect(existsSync(accountDatabase)).toBe(true);
  const database = new Database(accountDatabase, { readonly: true });
  const tables = (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map(row => row.name);
  expect(tables).toEqual(fixture.currentAccountTables);
  for (const [table, expectedSchema] of Object.entries(
    fixture.currentAccountSchema,
  )) {
    expect(schema(database, table), table).toEqual(expectedSchema);
  }
  expect(columns(database, 'auth')).toEqual([
    'method',
    'display_name',
    'extra_data',
    'active',
  ]);
  expect(columns(database, 'sessions')).toEqual([
    'token',
    'expires_at',
    'user_id',
    'auth_method',
  ]);
  expect(columns(database, 'files')).toEqual([
    'id',
    'group_id',
    'sync_version',
    'encrypt_meta',
    'encrypt_keyid',
    'encrypt_salt',
    'encrypt_test',
    'deleted',
    'name',
    'owner',
  ]);

  if (completed > 1) {
    const auth = database
      .prepare(
        "SELECT display_name, extra_data, active FROM auth WHERE method = 'password'",
      )
      .get();
    expect(auth).toEqual({
      display_name: 'Password',
      extra_data: 'legacy-password-hash',
      active: 1,
    });
    const admin = database
      .prepare("SELECT id FROM users WHERE role = 'ADMIN' ORDER BY id LIMIT 1")
      .get() as { id: string };
    expect(
      database
        .prepare("SELECT * FROM sessions WHERE token = 'legacy-session'")
        .get(),
    ).toEqual({
      token: 'legacy-session',
      expires_at: -1,
      user_id: admin.id,
      auth_method: 'password',
    });
    expect(
      database.prepare("SELECT * FROM files WHERE id = 'file-id'").get(),
    ).toEqual({
      id: 'file-id',
      group_id: 'group-id',
      sync_version: 7,
      encrypt_meta: 'encrypt-meta',
      encrypt_keyid: 'encrypt-key-id',
      encrypt_salt: 'encrypt-salt',
      encrypt_test: 'encrypt-test',
      deleted: 0,
      name: 'Budget',
      owner: admin.id,
    });
    if (completed >= 3) {
      const secrets = database
        .prepare(
          "SELECT name, lower(hex(value)) valueHex FROM secrets WHERE name LIKE 'gocardless_%' ORDER BY name",
        )
        .all();
      expect(secrets).toEqual([
        { name: 'gocardless_secretId', valueHex: '00017f80ff' },
        { name: 'gocardless_secretKey', valueHex: 'ff002a' },
      ]);
    }
    expect(
      database
        .prepare(
          "SELECT count(*) count FROM user_access WHERE user_id = ? AND file_id = 'file-id'",
        )
        .get(admin.id),
    ).toEqual({ count: completed >= 6 ? 1 : 0 });
    expect(
      database
        .prepare("SELECT value FROM server_prefs WHERE key = 'prefs-key'")
        .get(),
    ).toEqual(completed >= 7 ? { value: '{"enabled":true}' } : undefined);
    expect(
      database
        .prepare("SELECT count(*) count FROM users WHERE role = 'ADMIN'")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          "SELECT * FROM pending_openid_requests WHERE state = 'openid-state'",
        )
        .get(),
    ).toEqual(
      completed >= 5
        ? {
            state: 'openid-state',
            code_verifier: 'verifier',
            return_url: 'actual://return',
            expiry_time: 4102444800000,
          }
        : undefined,
    );
  }
  database.close();

  const state = JSON.parse(
    readFileSync(join(root, fixture.storedPaths.migrationState), 'utf8'),
  ) as {
    lastRun: string;
    migrations: Array<{ title: string; timestamp: number }>;
  };
  expect(state.lastRun).toBe(fixture.migrationTitles.at(-1));
  expect(state.migrations.map(entry => entry.title)).toEqual(
    fixture.migrationTitles,
  );
  expect(
    state.migrations.every(entry => typeof entry.timestamp === 'number'),
  ).toBe(true);
}

afterAll(() => {
  config.set('userFiles', originalUserFiles);
});

it('tracks every repository migration with the shared fixture', () => {
  expect(fixture.version).toBe(2);
  expect(fixture.migrationTitles).toEqual(
    readdirSync(migrationsDirectory)
      .filter(name => /\.(js|ts)$/.test(name))
      .sort(),
  );
});

it('opens and upgrades every repository-represented account schema in isolation', async () => {
  const roots = new Set<string>();
  for (
    let completed = 0;
    completed <= fixture.migrationTitles.length;
    completed += 1
  ) {
    const root = temporaryRoot(`account-${completed}`);
    roots.add(root);
    try {
      materializeAccountState(root, completed);
      await runMigrations(root);
      assertCurrentAccountState(root, completed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  expect(roots.size).toBe(fixture.migrationTitles.length + 1);
}, 30_000);

it('preserves transaction rollback and migration state on a conflicting schema', async () => {
  const root = temporaryRoot('rollback');
  try {
    materializeAccountState(root, fixture.rollback.completed);
    const databasePath = join(root, fixture.storedPaths.accountDatabase);
    const database = new Database(databasePath);
    database.exec(fixture.rollback.conflictSql);
    database.close();
    await expect(runMigrations(root)).rejects.toThrow();

    const after = new Database(databasePath, { readonly: true });
    expect(columns(after, 'sessions')).toEqual(
      fixture.rollback.expectedSessionsColumns,
    );
    expect(columns(after, 'user_access')).toEqual(
      fixture.rollback.expectedUserAccessColumns,
    );
    expect(
      after
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'",
        )
        .get(),
    ).toBeUndefined();
    after.close();
    const state = JSON.parse(
      readFileSync(join(root, fixture.storedPaths.migrationState), 'utf8'),
    ) as { lastRun: string };
    expect(state.lastRun).toBe(fixture.rollback.expectedLastRun);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it('matches every shared intermediate downgrade schema and retained data state', async () => {
  expect(fixture.downgradeStates.map(state => state.title)).toEqual(
    [...fixture.migrationTitles].reverse(),
  );
  const root = temporaryRoot('downgrade-states');
  try {
    materializeAccountState(root, fixture.migrationTitles.length);
    for (const state of fixture.downgradeStates) {
      writeSingleMigrationState(root, state.title);
      await runMigrations(root, 'down');
      assertDowngradeState(root, state);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it('rolls back a failing transactional downgrade without advancing its state', async () => {
  const root = temporaryRoot('downgrade-rollback');
  try {
    materializeAccountState(root, fixture.migrationTitles.length);
    const databasePath = join(root, fixture.storedPaths.accountDatabase);
    const database = new Database(databasePath);
    database.exec(fixture.downgradeRollback.conflictSql);
    database.close();

    await expect(runMigrations(root, 'down')).rejects.toThrow();

    const after = new Database(databasePath, { readonly: true });
    expect(tables(after)).toEqual(fixture.downgradeRollback.expectedTables);
    expect(schema(after, 'sessions')).toEqual(
      fixture.currentAccountSchema.sessions,
    );
    expect(schema(after, 'user_access')).toEqual(
      fixture.currentAccountSchema.user_access,
    );
    expect(schema(after, 'sessions_backup')).toEqual(
      fixture.downgradeRollback.expectedConflictSchema,
    );
    expect(Object.keys(fixture.downgradeRollback.expectedRows).sort()).toEqual(
      fixture.downgradeRollback.expectedTables,
    );
    for (const [table, expected] of Object.entries(
      fixture.downgradeRollback.expectedRows,
    )) {
      expect(
        rows(after, table, expected[0]?.length ?? 0),
        `rollback:${table}:rows`,
      ).toEqual(expected);
    }
    after.close();
    const state = JSON.parse(
      readFileSync(join(root, fixture.storedPaths.migrationState), 'utf8'),
    ) as MigrationState;
    expect(state.lastRun).toBe(fixture.downgradeRollback.expectedLastRun);
    expect(
      state.migrations
        .filter(migration => migration.timestamp !== null)
        .map(migration => migration.title),
    ).toEqual(
      fixture.migrationTitles.slice(
        0,
        fixture.migrationTitles.indexOf(
          fixture.downgradeRollback.expectedLastRun,
        ) + 1,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it('matches every represented migration state-file format', async () => {
  for (const variant of fixture.stateVariants) {
    const root = temporaryRoot(`state-${variant.id}`);
    try {
      materializeAccountState(root, variant.completed);
      const before = writeStateVariant(root, variant);
      if (variant.result === 'success') {
        await runMigrations(root);
        assertCurrentAccountState(root, variant.completed);
      } else {
        await expect(runMigrations(root)).rejects.toThrow(
          variant.expectedError,
        );
        expect(
          readFileSync(join(root, fixture.storedPaths.migrationState), 'utf8'),
        ).toBe(before);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

it('opens every represented message database state in a unique writable directory', () => {
  expect(fixture.messageStates.some(state => state.sql === null)).toBe(true);
  const roots = new Set<string>();
  for (const state of fixture.messageStates) {
    const root = temporaryRoot(`messages-${state.id}`);
    roots.add(root);
    const userFiles = join(root, 'user-files');
    mkdirSync(userFiles, { recursive: true });
    const databasePath = join(
      root,
      fixture.storedPaths.messageDatabasePattern.replace(
        '{groupId}',
        state.groupId,
      ),
    );
    if (state.sql !== null) {
      const database = new Database(databasePath);
      database.exec(state.sql);
      for (const [table, expected] of Object.entries(fixture.messageSchema)) {
        expect(schema(database, table), `${state.id}:fixture:${table}`).toEqual(
          expected,
        );
      }
      database.close();
    }
    config.set('userFiles', userFiles);
    try {
      const result = sync([], beforeAllMessages, state.groupId);
      expect(result.newMessages).toHaveLength(state.expectedMessages);
      expect(JSON.stringify(result.trie)).toBe(state.expectedMerkle);
      const database = new Database(databasePath, { readonly: true });
      for (const [table, expected] of Object.entries(fixture.messageSchema)) {
        expect(schema(database, table), `${state.id}:opened:${table}`).toEqual(
          expected,
        );
      }
      expect(
        database.prepare('SELECT count(*) count FROM messages_binary').get(),
      ).toEqual({ count: state.expectedMessages });
      expect(
        database
          .prepare(
            'SELECT timestamp, is_encrypted isEncrypted, lower(hex(content)) contentHex FROM messages_binary ORDER BY timestamp',
          )
          .all(),
      ).toEqual(state.expectedRows);
      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  expect(roots.size).toBe(fixture.messageStates.length);
});
