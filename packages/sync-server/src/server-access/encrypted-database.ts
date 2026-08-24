import { chmodSync } from 'node:fs';

import Database from 'better-sqlite3-multiple-ciphers';

type SchemaRow = {
  type: 'table' | 'index' | 'trigger' | 'view';
  name: string;
  sql: string;
};

type ColumnRow = { name: string; hidden: number };

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function createEncryptedDatabase(
  databaseBytes: Uint8Array,
  destination: string,
  rawKey: string,
) {
  if (!/^[a-f0-9]{64}$/i.test(rawKey)) {
    throw new Error('invalid-database-key');
  }

  const source = new Database(Buffer.from(databaseBytes));
  const target = new Database(destination);
  try {
    target.pragma("cipher = 'chacha20'");
    target.pragma('hmac_check = 1');
    target.pragma(`key = "raw:${rawKey}"`);
    target.pragma('foreign_keys = OFF');
    target.pragma('temp_store = MEMORY');

    const schema = source
      .prepare(
        `SELECT type, name, sql
         FROM sqlite_master
         WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
         ORDER BY CASE type
           WHEN 'table' THEN 0
           WHEN 'index' THEN 1
           WHEN 'trigger' THEN 2
           ELSE 3
         END, name`,
      )
      .all() as SchemaRow[];

    if (schema.some(row => /^CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql))) {
      throw new Error('virtual-tables-are-not-supported');
    }

    const tables = schema.filter(row => row.type === 'table');
    for (const table of tables) {
      target.exec(table.sql);
    }

    target.transaction(() => {
      for (const table of tables) {
        const tableName = quoteIdentifier(table.name);
        const columns = source
          .prepare(`PRAGMA table_xinfo(${tableName})`)
          .all() as ColumnRow[];
        const writableColumns = columns.filter(column => column.hidden === 0);
        if (writableColumns.length === 0) {
          continue;
        }
        const columnSql = writableColumns
          .map(column => quoteIdentifier(column.name))
          .join(', ');
        const insert = target.prepare(
          `INSERT INTO ${tableName} (${columnSql}) VALUES (${writableColumns
            .map(() => '?')
            .join(', ')})`,
        );
        const rows = source.prepare(`SELECT ${columnSql} FROM ${tableName}`);
        for (const row of rows.iterate() as Iterable<Record<string, unknown>>) {
          insert.run(...writableColumns.map(column => row[column.name]));
        }
      }

      const hasSourceSequence = source
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
        )
        .get();
      const hasTargetSequence = target
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
        )
        .get();
      if (hasSourceSequence && hasTargetSequence) {
        target.prepare('DELETE FROM sqlite_sequence').run();
        const insertSequence = target.prepare(
          'INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)',
        );
        for (const row of source
          .prepare('SELECT name, seq FROM sqlite_sequence')
          .iterate() as Iterable<{ name: string; seq: number }>) {
          insertSequence.run(row.name, row.seq);
        }
      }
    })();

    for (const row of schema.filter(item => item.type !== 'table')) {
      target.exec(row.sql);
    }

    const applicationId = Number(
      source.pragma('application_id', { simple: true }),
    );
    const userVersion = Number(source.pragma('user_version', { simple: true }));
    target.pragma(`application_id = ${applicationId}`);
    target.pragma(`user_version = ${userVersion}`);
    target.pragma('journal_mode = WAL');
    target.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    target.close();
    source.close();
  }
  chmodSync(destination, 0o600);
}
