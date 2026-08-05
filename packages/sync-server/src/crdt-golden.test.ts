import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  create,
  fromBinary,
  MessageEnvelopeSchema,
  SyncRequestSchema,
  SyncResponseSchema,
  toBinary,
} from '@actual-app/crdt';
import type { MessageEnvelope } from '@actual-app/crdt';

import { config } from './load-config.js';
import { sync } from './sync-simple.js';

const fixturePath = fileURLToPath(
  new URL('../contract/fixtures/crdt-sync-golden.json', import.meta.url),
);
const beforeAllMessages = '2025-01-01T00:00:00.000Z';
const plainTimestamp = '2026-01-01T00:00:00.001Z-0000-0000000000000001';
const encryptedTimestamp = '2026-01-01T00:00:00.002Z-0000-0000000000000002';

type SyncResult = {
  trie: object;
  newMessages: MessageEnvelope[];
};

type FixtureMessage = {
  id: string;
  timestamp: string;
  isEncrypted: boolean;
  contentHex: string;
  envelopeHex: string;
};

type GoldenFixture = {
  version: number;
  messages: FixtureMessage[];
  emptyMerkle: string;
  insertionOrder: string[];
  merkle: string;
  readOrder: string[];
  sinceCases: Array<{ since: string; ids: string[] }>;
  duplicate: {
    id: string;
    conflictingContentHex: string;
    exactMerkle: string;
    conflictingMerkle: string;
    retainedContentHex: string;
  };
  syncRequest: {
    fileId: string;
    groupId: string;
    keyId: string;
    since: string;
    messageIds: string[];
    encodedHex: string;
  };
  syncResponseHex: string;
  malformedPayloadHex: string;
  malformedTimestamp: string;
};

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function messageId(message: MessageEnvelope): string {
  if (message.timestamp === plainTimestamp) {
    return 'plain-unicode';
  }
  if (message.timestamp === encryptedTimestamp) {
    return 'encrypted-binary';
  }
  throw new Error(`Unknown fixture timestamp: ${message.timestamp}`);
}

function runSync(
  messages: MessageEnvelope[],
  since: string,
  groupId: string,
): SyncResult {
  const result: unknown = sync(messages, since, groupId);
  if (
    typeof result !== 'object' ||
    result === null ||
    !('trie' in result) ||
    typeof result.trie !== 'object' ||
    result.trie === null ||
    !('newMessages' in result) ||
    !Array.isArray(result.newMessages)
  ) {
    throw new Error('Invalid sync result');
  }
  return { trie: result.trie, newMessages: result.newMessages };
}

async function buildFixture(): Promise<GoldenFixture> {
  const userFiles = await mkdtemp(join(tmpdir(), 'actual-crdt-golden-'));
  const originalUserFiles = config.get('userFiles');
  config.set('userFiles', userFiles);
  try {
    const plain = create(MessageEnvelopeSchema, {
      timestamp: plainTimestamp,
      isEncrypted: false,
      content: new TextEncoder().encode(
        JSON.stringify({ memo: 'café 💰', amount: -12.34 }),
      ),
    });
    const encrypted = create(MessageEnvelopeSchema, {
      timestamp: encryptedTimestamp,
      isEncrypted: true,
      content: new Uint8Array([0, 255, 1, 128, 222, 173, 190, 239]),
    });
    const messages = [
      { id: 'plain-unicode', value: plain },
      { id: 'encrypted-binary', value: encrypted },
    ];
    const records = messages.map(({ id, value }) => ({
      id,
      timestamp: value.timestamp,
      isEncrypted: value.isEncrypted,
      contentHex: hex(value.content),
      envelopeHex: hex(toBinary(MessageEnvelopeSchema, value)),
    }));

    const emptyMerkle = JSON.stringify(
      runSync([], beforeAllMessages, 'golden-empty').trie,
    );
    const inserted = runSync(
      [encrypted, plain],
      beforeAllMessages,
      'golden-main',
    );
    const merkle = JSON.stringify(inserted.trie);
    const readBack = runSync([], beforeAllMessages, 'golden-main');
    const exact = runSync([plain], beforeAllMessages, 'golden-main');
    const conflict = create(MessageEnvelopeSchema, {
      ...plain,
      content: new Uint8Array([9, 9, 9]),
    });
    const conflicting = runSync([conflict], beforeAllMessages, 'golden-main');
    const sinceCases = [
      beforeAllMessages,
      plainTimestamp,
      '2026-01-01T00:00:00.001Z-0000-0000000000000002',
      encryptedTimestamp,
    ].map(since => ({
      since,
      ids: runSync([], since, 'golden-main').newMessages.map(messageId),
    }));
    const syncRequest = create(SyncRequestSchema, {
      fileId: 'fixture-file',
      groupId: 'fixture-group',
      keyId: 'fixture-key',
      since: beforeAllMessages,
      messages: [encrypted, plain],
    });
    const syncResponse = create(SyncResponseSchema, {
      messages: readBack.newMessages,
      merkle,
    });

    expect(() =>
      fromBinary(MessageEnvelopeSchema, Buffer.from('0aff', 'hex')),
    ).toThrow();
    expect(() =>
      runSync(
        [
          create(MessageEnvelopeSchema, {
            timestamp: 'not-a-timestamp',
            content: new Uint8Array([1]),
          }),
        ],
        beforeAllMessages,
        'golden-malformed',
      ),
    ).toThrow();

    return {
      version: 1,
      messages: records,
      emptyMerkle,
      insertionOrder: ['encrypted-binary', 'plain-unicode'],
      merkle,
      readOrder: readBack.newMessages.map(messageId),
      sinceCases,
      duplicate: {
        id: 'plain-unicode',
        conflictingContentHex: hex(conflict.content),
        exactMerkle: JSON.stringify(exact.trie),
        conflictingMerkle: JSON.stringify(conflicting.trie),
        retainedContentHex: hex(readBack.newMessages[0].content),
      },
      syncRequest: {
        fileId: syncRequest.fileId,
        groupId: syncRequest.groupId,
        keyId: syncRequest.keyId,
        since: syncRequest.since,
        messageIds: syncRequest.messages.map(messageId),
        encodedHex: hex(toBinary(SyncRequestSchema, syncRequest)),
      },
      syncResponseHex: hex(toBinary(SyncResponseSchema, syncResponse)),
      malformedPayloadHex: '0aff',
      malformedTimestamp: 'not-a-timestamp',
    };
  } finally {
    config.set('userFiles', originalUserFiles);
    rmSync(userFiles, { recursive: true, force: true });
  }
}

it('matches the language-independent CRDT golden fixture', async () => {
  const actual = await buildFixture();
  if (process.env.UPDATE_CRDT_GOLDEN === '1') {
    writeFileSync(fixturePath, `${JSON.stringify(actual, null, 2)}\n`);
  }
  const expected = JSON.parse(
    readFileSync(fixturePath, 'utf8'),
  ) as GoldenFixture;
  expect(actual).toEqual(expected);

  for (const record of expected.messages) {
    const decoded = fromBinary(
      MessageEnvelopeSchema,
      Buffer.from(record.envelopeHex, 'hex'),
    );
    expect(hex(toBinary(MessageEnvelopeSchema, decoded))).toBe(
      record.envelopeHex,
    );
  }
  const decodedRequest = fromBinary(
    SyncRequestSchema,
    Buffer.from(expected.syncRequest.encodedHex, 'hex'),
  );
  expect(hex(toBinary(SyncRequestSchema, decodedRequest))).toBe(
    expected.syncRequest.encodedHex,
  );
  const decodedResponse = fromBinary(
    SyncResponseSchema,
    Buffer.from(expected.syncResponseHex, 'hex'),
  );
  expect(hex(toBinary(SyncResponseSchema, decodedResponse))).toBe(
    expected.syncResponseHex,
  );
});
