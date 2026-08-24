import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3-multiple-ciphers';

import { createEncryptedDatabase } from './encrypted-database';

describe('encrypted mirror database', () => {
  it('copies a snapshot without creating a plaintext SQLite file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'actual-mirror-test-'));
    const destination = join(directory, 'mirror.sqlite');
    const key = Buffer.alloc(32, 9).toString('hex');
    const source = new Database(':memory:');
    source.exec(`
      CREATE TABLE example (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX example_value ON example(value);
      INSERT INTO example VALUES ('one', 'sensitive mirror value');
    `);
    const snapshot = source.serialize();
    source.close();

    try {
      createEncryptedDatabase(snapshot, destination, key);
      const bytes = await readFile(destination);
      expect(bytes.subarray(0, 16).toString('utf8')).not.toBe(
        'SQLite format 3\0',
      );
      expect(bytes.includes(Buffer.from('sensitive mirror value'))).toBe(false);

      const wrongKey = new Database(destination);
      wrongKey.pragma("cipher = 'chacha20'");
      wrongKey.pragma(`key = "raw:${Buffer.alloc(32, 8).toString('hex')}"`);
      expect(() => wrongKey.prepare('SELECT * FROM example').all()).toThrow();
      wrongKey.close();

      const mirror = new Database(destination);
      mirror.pragma("cipher = 'chacha20'");
      mirror.pragma(`key = "raw:${key}"`);
      expect(mirror.prepare('SELECT * FROM example').all()).toEqual([
        { id: 'one', value: 'sensitive mirror value' },
      ]);
      mirror.pragma('journal_mode = WAL');
      mirror
        .prepare('INSERT INTO example VALUES (?, ?)')
        .run('two', 'sensitive WAL value');
      const wal = await readFile(`${destination}-wal`);
      expect(wal.includes(Buffer.from('sensitive WAL value'))).toBe(false);
      mirror.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
