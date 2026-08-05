import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from './db.js';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    join(packageRoot, '..', 'contract', 'fixtures', 'db-golden.json'),
    'utf8',
  ),
);

function temporaryRoot(label) {
  return mkdtempSync(join(tmpdir(), `actual-ts-db-${label}-`));
}

function mutationResult(result) {
  return {
    changes: result.changes,
    insertId: Number(result.insertId),
  };
}

function errorCode(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  throw new Error('Expected database operation to fail');
}

it('matches the shared query, binding, mutation, and persistence fixture', () => {
  expect(fixture.version).toBe(1);
  const root = temporaryRoot('operations');
  const path = join(root, 'database.sqlite');
  try {
    const database = openDatabase(path);
    const execResult = database.exec(`
      CREATE TABLE values_table (
        id INTEGER PRIMARY KEY,
        text_value TEXT NOT NULL,
        number_value REAL,
        nullable_value TEXT,
        blob_value BLOB
      );
      CREATE TABLE exec_marker (value TEXT);
      INSERT INTO exec_marker VALUES ('batch-one'), ('batch-two');
    `);
    expect(execResult).toBe(database.db);

    expect(
      mutationResult(
        database.mutate(
          'INSERT INTO values_table(text_value, number_value, nullable_value, blob_value) VALUES (?, ?, ?, ?)',
          ['alpha', 7, null, Buffer.from([0, 1, 127, 255])],
        ),
      ),
    ).toEqual(fixture.mutation.firstInsert);
    expect(
      mutationResult(
        database.mutate(
          'INSERT INTO values_table(text_value, number_value, nullable_value, blob_value) VALUES (?, ?, ?, ?)',
          ['', -1.25, undefined, Buffer.alloc(0)],
        ),
      ),
    ).toEqual(fixture.mutation.secondInsert);

    expect(
      database.all(`
        SELECT id, text_value textValue, number_value numberValue,
               nullable_value nullableValue, lower(hex(blob_value)) blobHex
          FROM values_table ORDER BY id
      `),
    ).toEqual(fixture.rows);
    expect(
      database.first('SELECT * FROM values_table WHERE id = ?', [99]),
    ).toBe(null);
    expect(database.first('SELECT count(*) count FROM exec_marker')).toEqual({
      count: 2,
    });

    expect(
      mutationResult(
        database.mutate('UPDATE values_table SET text_value = ?', ['updated']),
      ),
    ).toEqual(fixture.mutation.update);
    expect(
      mutationResult(
        database.mutate('UPDATE values_table SET text_value = ? WHERE id = ?', [
          'missing',
          99,
        ]),
      ),
    ).toEqual(fixture.mutation.noChange);
    database.close();
    database.close();

    const reopened = openDatabase(path);
    expect(
      reopened.all('SELECT text_value FROM values_table ORDER BY id'),
    ).toEqual([{ text_value: 'updated' }, { text_value: 'updated' }]);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('records the exact better-sqlite3 Number binding boundary', () => {
  const database = openDatabase(':memory:');
  try {
    for (const vector of fixture.numberBindings) {
      const value = Number(vector.source);
      const row = database.first('SELECT typeof(?) storageClass, ? readValue', [
        value,
        value,
      ]);
      expect(row.storageClass, vector.id).toBe(vector.jsStorageClass);
      expect(String(row.readValue), vector.id).toBe(vector.readValue);
      expect(Object.is(row.readValue, -0), vector.id).toBe(
        vector.isNegativeZero,
      );
      expect(Number.isSafeInteger(value), vector.id).toBe(vector.isSafeInteger);
    }
  } finally {
    database.close();
  }
});

it('matches callback returns, rollback, and nested savepoint behavior', () => {
  const root = temporaryRoot('transactions');
  try {
    const database = openDatabase(join(root, 'database.sqlite'));
    database.exec(
      'CREATE TABLE values_table (id INTEGER PRIMARY KEY, text_value TEXT)',
    );
    database.mutate('INSERT INTO values_table(text_value) VALUES (?), (?)', [
      'updated',
      'updated',
    ]);

    expect(
      database.transaction(() => {
        database.mutate('INSERT INTO values_table(text_value) VALUES (?)', [
          'committed',
        ]);
        return fixture.transaction.returnValue;
      }),
    ).toBe(fixture.transaction.returnValue);
    const sentinel = new Error('rollback sentinel');
    expect(() =>
      database.transaction(() => {
        database.mutate('INSERT INTO values_table(text_value) VALUES (?)', [
          'rolled-back',
        ]);
        throw sentinel;
      }),
    ).toThrow(sentinel);
    expect(
      database
        .all('SELECT text_value FROM values_table ORDER BY id')
        .map(row => row.text_value),
    ).toEqual(fixture.transaction.afterRollback);

    database.transaction(() => {
      database.mutate('INSERT INTO values_table(text_value) VALUES (?)', [
        'outer',
      ]);
      try {
        database.transaction(() => {
          database.mutate('INSERT INTO values_table(text_value) VALUES (?)', [
            'inner',
          ]);
          throw new Error('inner sentinel');
        });
      } catch (error) {
        expect(error.message).toBe('inner sentinel');
      }
    });
    expect(
      database
        .all('SELECT text_value FROM values_table ORDER BY id')
        .map(row => row.text_value),
    ).toEqual(fixture.transaction.afterNestedRollback);
    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('propagates constraint, locking, invalid-file, path, and closed errors', () => {
  const root = temporaryRoot('errors');
  try {
    const path = join(root, 'database.sqlite');
    const first = openDatabase(path);
    first.exec('CREATE TABLE values_table (value TEXT UNIQUE)');
    first.mutate('INSERT INTO values_table VALUES (?)', ['duplicate']);
    expect(
      errorCode(() =>
        first.mutate('INSERT INTO values_table VALUES (?)', ['duplicate']),
      ),
    ).toBe(fixture.errors.constraintCode);

    const second = openDatabase(path);
    second.exec('PRAGMA busy_timeout = 1');
    first.exec('BEGIN EXCLUSIVE');
    expect(
      errorCode(() =>
        second.mutate('INSERT INTO values_table VALUES (?)', ['locked']),
      ),
    ).toBe(fixture.errors.lockedCode);
    first.exec('ROLLBACK');
    second.close();
    first.close();
    expect(() => first.all('SELECT 1')).toThrow(
      'The database connection is not open',
    );
    expect(() => first.exec('SELECT 1')).toThrow(
      'The database connection is not open',
    );
    expect(() => first.mutate('CREATE TABLE closed (value)')).toThrow(
      'The database connection is not open',
    );

    const invalidFile = join(root, 'invalid.sqlite');
    writeFileSync(invalidFile, 'not a sqlite database');
    const invalid = openDatabase(invalidFile);
    expect(errorCode(() => invalid.all('SELECT * FROM sqlite_master'))).toBe(
      fixture.errors.invalidDatabaseCode,
    );
    invalid.close();
    expect(errorCode(() => openDatabase(root))).toBe(
      fixture.errors.invalidPathCode,
    );

    const readOnlyPath = join(root, 'read-only.sqlite');
    const writable = openDatabase(readOnlyPath);
    writable.exec('CREATE TABLE persisted (value TEXT)');
    writable.mutate('INSERT INTO persisted VALUES (?)', ['readable']);
    writable.close();
    chmodSync(readOnlyPath, 0o444);
    const readOnly = openDatabase(readOnlyPath);
    expect(readOnly.first('SELECT value FROM persisted')).toEqual({
      value: 'readable',
    });
    expect(
      errorCode(() =>
        readOnly.mutate('INSERT INTO persisted VALUES (?)', ['no']),
      ),
    ).toBe(fixture.errors.readOnlyCode);
    readOnly.close();
    chmodSync(readOnlyPath, 0o644);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
