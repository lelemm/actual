import { gzipSync } from 'node:zlib';

import {
  create,
  fromBinary,
  MessageEnvelopeSchema,
  SyncRequestSchema,
  SyncResponseSchema,
  toBinary,
} from '@actual-app/crdt';
import { inject } from 'vitest';

const serverUrl = inject('contractServerUrl');
const simpleFinMockUrl = inject('simpleFinMockUrl');
const openIdMockUrl = inject('openIdMockUrl');
const pluggyMockUrl = inject('pluggyMockUrl');
const akahuMockUrl = inject('akahuMockUrl');

async function request(path: string, init?: RequestInit) {
  return fetch(`${serverUrl}${path}`, init);
}

function readToken(body: unknown) {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('data' in body) ||
    typeof body.data !== 'object' ||
    body.data === null ||
    !('token' in body.data) ||
    typeof body.data.token !== 'string'
  ) {
    throw new Error('Bootstrap response did not contain a token');
  }
  return body.data.token;
}

function readGroupId(body: unknown) {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('groupId' in body) ||
    typeof body.groupId !== 'string'
  ) {
    throw new Error('Upload response did not contain a groupId');
  }
  return body.groupId;
}

describe.runIf(!process.env.ACTUAL_CONTRACT_VARIANT)(
  'sync-server HTTP contract',
  () => {
    let token: string;
    let groupId: string;
    const fileId = '0123456789abcdef0123456789abcdef';
    const fileContent = new TextEncoder().encode('contract budget bytes\n');

    it('reports its health and build identity', async () => {
      const health = await request('/health');
      expect(health.status).toBe(200);
      expect(health.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      expect(health.headers.get('access-control-allow-origin')).toBe('*');
      expect(health.headers.get('content-security-policy')).toBeNull();
      expect(await health.json()).toEqual({ status: 'UP' });

      const info = await request('/info');
      expect(info.status).toBe(200);
      expect(info.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      expect(await info.json()).toEqual({
        build: {
          name: '@actual-app/sync-server',
          description: 'actual syncing server',
          version: '26.8.0',
        },
      });

      const mode = await request('/mode');
      expect(mode.status).toBe(200);
      expect(mode.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await mode.text()).toBe('development');

      const metrics = await request('/metrics');
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      const metricBody = (await metrics.json()) as {
        mem: Record<string, number>;
        uptime: number;
      };
      expect(metricBody).toEqual({
        mem: {
          rss: expect.any(Number),
          heapTotal: expect.any(Number),
          heapUsed: expect.any(Number),
          external: expect.any(Number),
          arrayBuffers: expect.any(Number),
        },
        uptime: expect.any(Number),
      });
      expect(Object.values(metricBody.mem).every(value => value > 0)).toBe(
        true,
      );
      expect(metricBody.uptime).toBeGreaterThan(0);

      const preflight = await request('/health', {
        method: 'OPTIONS',
        headers: { 'access-control-request-headers': 'X-Actual-Token' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      expect(preflight.headers.get('access-control-allow-methods')).toBe(
        'GET,HEAD,PUT,PATCH,POST,DELETE',
      );
      expect(preflight.headers.get('access-control-allow-headers')).toBe(
        'X-Actual-Token',
      );
      expect(preflight.headers.get('vary')).toBe(
        'Access-Control-Request-Headers',
      );

      const frontend = await request('/contract/frontend');
      expect(frontend.status).toBe(200);
      expect(frontend.headers.get('content-type')).toBe(
        'text/html; charset=utf-8',
      );
      expect(await frontend.text()).toBe('<!doctype html>contract frontend');
      expect(frontend.headers.get('cross-origin-opener-policy')).toBe(
        'same-origin',
      );
      expect(frontend.headers.get('cross-origin-embedder-policy')).toBe(
        'require-corp',
      );
      expect(frontend.headers.get('content-security-policy')).toBe(
        "default-src 'self' blob:; img-src 'self' blob: data:; script-src 'self' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src http: https:",
      );

      const missingPost = await request('/contract/frontend', {
        method: 'POST',
      });
      expect(missingPost.status).toBe(404);
      expect(missingPost.headers.get('content-type')).toBe(
        'text/html; charset=utf-8',
      );
      expect(missingPost.headers.get('content-security-policy')).toBe(
        "default-src 'none'",
      );
      expect(await missingPost.text()).toContain(
        'Cannot POST /contract/frontend',
      );
      expect(missingPost.headers.get('cross-origin-opener-policy')).toBe(
        'same-origin',
      );
      expect(missingPost.headers.get('cross-origin-embedder-policy')).toBe(
        'require-corp',
      );

      const malformed = await request('/contract/missing', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: '{',
      });
      expect(malformed.status).toBe(400);
      expect(malformed.headers.get('content-type')).toBe(
        'text/html; charset=utf-8',
      );
      expect(malformed.headers.get('content-security-policy')).toBe(
        "default-src 'none'",
      );
    });

    it('applies JSON limits to the decoded compressed body', async () => {
      const megabyte = 1024 * 1024;
      const boundary = gzipSync(
        JSON.stringify({ x: 'x'.repeat(20 * megabyte - 8) }),
      );
      const bomb = gzipSync(
        JSON.stringify({ x: 'x'.repeat(20 * megabyte - 7) }),
      );
      expect(bomb.byteLength).toBeLessThan(32 * 1024);

      const accepted = await request('/contract/compressed-boundary', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
        },
        body: boundary,
      });
      expect(accepted.status).toBe(404);

      const rejected = await request('/contract/compressed-bomb', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
        },
        body: bomb,
      });
      expect(rejected.status).toBe(413);
    }, 30_000);

    it('bootstraps password authentication once', async () => {
      const initial = await request('/account/needs-bootstrap');
      expect(initial.status).toBe(200);
      expect(await initial.json()).toEqual({
        status: 'ok',
        data: {
          bootstrapped: false,
          loginMethod: 'password',
          availableLoginMethods: [],
          multiuser: false,
        },
      });

      const bootstrap = await request('/account/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'contract-password' }),
      });
      expect(bootstrap.status).toBe(200);
      const body = await bootstrap.json();
      expect(body).toMatchObject({
        status: 'ok',
        data: { token: expect.any(String) },
      });
      token = readToken(body);

      const repeated = await request('/account/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'different-password' }),
      });
      expect(repeated.status).toBe(400);
      expect(await repeated.json()).toEqual({
        status: 'error',
        reason: 'already-bootstrapped',
      });
    });

    it('rejects an absent token and validates the bootstrap token', async () => {
      const unauthorized = await request('/account/validate');
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toEqual({
        status: 'error',
        reason: 'unauthorized',
        details: 'token-not-found',
      });

      const validated = await request('/account/validate', {
        headers: { 'x-actual-token': token },
      });
      expect(validated.status).toBe(200);
      expect(await validated.json()).toMatchObject({
        status: 'ok',
        data: {
          validated: true,
          permission: 'ADMIN',
          loginMethod: 'password',
          prefs: {},
        },
      });
    });

    it('preserves sync file lookup and malformed-ID error responses', async () => {
      for (const fileId of [null, 7, {}, 'budget@invalid']) {
        const malformed = await request('/sync/user-get-key', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-actual-token': token,
          },
          body: JSON.stringify({ fileId }),
        });
        expect(malformed.status, JSON.stringify(fileId)).toBe(400);
        expect(await malformed.text(), JSON.stringify(fileId)).toBe(
          'invalid fileId',
        );
      }

      const missingKey = await request('/sync/user-get-key', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({ fileId: 'missing' }),
      });
      expect(missingKey.status).toBe(400);
      expect(await missingKey.text()).toBe('file-not-found');

      const missingReset = await request('/sync/reset-user-file', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({ fileId: 'missing' }),
      });
      expect(missingReset.status).toBe(400);
      expect(await missingReset.text()).toBe('User or file not found');

      const missingInfo = await request('/sync/get-user-file-info', {
        headers: {
          'x-actual-token': token,
          'x-actual-file-id': 'missing',
        },
      });
      expect(missingInfo.status).toBe(400);
      expect(await missingInfo.json()).toEqual({
        status: 'error',
        reason: 'file-not-found',
      });
    });

    it('preserves password login and server preference behavior', async () => {
      const methods = await request('/account/login-methods');
      expect(methods.status).toBe(200);
      expect(await methods.json()).toEqual({
        status: 'ok',
        methods: [{ method: 'password', active: 1, displayName: 'Password' }],
      });

      const rejected = await request('/account/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password' }),
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        status: 'error',
        reason: 'invalid-password',
      });

      const login = await request('/account/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'contract-password' }),
      });
      expect(login.status).toBe(200);
      expect(await login.json()).toEqual({ status: 'ok', data: { token } });

      const invalidPrefs = await request('/account/server-prefs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({ prefs: 'invalid' }),
      });
      expect(invalidPrefs.status).toBe(400);
      expect(await invalidPrefs.json()).toEqual({
        status: 'error',
        reason: 'invalid-prefs',
      });

      const prefs = { 'flags.plugins': 'true' };
      const saved = await request('/account/server-prefs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({ prefs }),
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ status: 'ok', data: {} });

      const validated = await request('/account/validate', {
        headers: { 'x-actual-token': token },
      });
      expect(validated.status).toBe(200);
      expect(await validated.json()).toMatchObject({
        status: 'ok',
        data: { validated: true, prefs },
      });
    });

    it('persists and returns a user file byte-for-byte', async () => {
      const missingMediaType = await request('/sync/upload-user-file', {
        method: 'POST',
        headers: {
          'x-actual-token': token,
          'x-actual-name': encodeURIComponent('Missing media type'),
          'x-actual-file-id': 'MissingMediaType',
          'x-actual-format': '2',
        },
        body: fileContent,
      });
      expect(missingMediaType.status).toBe(500);
      expect(await missingMediaType.json()).toEqual({ status: 'error' });

      for (const [invalidId, extraHeaders] of [
        [
          'MalformedName',
          { 'x-actual-name': '%ZZ', 'x-actual-encrypt-meta': undefined },
        ],
        [
          'MalformedEncryptMeta',
          { 'x-actual-name': 'Budget', 'x-actual-encrypt-meta': '{' },
        ],
        [
          'NullEncryptMeta',
          { 'x-actual-name': 'Budget', 'x-actual-encrypt-meta': 'null' },
        ],
      ] as const) {
        const response = await request('/sync/upload-user-file', {
          method: 'POST',
          headers: {
            'content-type': 'application/encrypted-file',
            'x-actual-token': token,
            'x-actual-file-id': invalidId,
            'x-actual-format': '2',
            ...Object.fromEntries(
              Object.entries(extraHeaders).filter(([, value]) => value),
            ),
          },
          body: fileContent,
        });
        expect(response.status).toBe(500);
      }

      const upload = await request('/sync/upload-user-file', {
        method: 'POST',
        headers: {
          'content-type': 'application/encrypted-file',
          'x-actual-token': token,
          'x-actual-name': encodeURIComponent('Contract budget'),
          'x-actual-file-id': fileId,
          'x-actual-format': '2',
        },
        body: fileContent,
      });
      expect(upload.status).toBe(200);
      const uploadBody = await upload.json();
      expect(uploadBody).toMatchObject({
        status: 'ok',
        groupId: expect.any(String),
      });
      groupId = readGroupId(uploadBody);

      const files = await request('/sync/list-user-files', {
        headers: { 'x-actual-token': token },
      });
      expect(files.status).toBe(200);
      expect(await files.json()).toMatchObject({
        status: 'ok',
        data: [
          {
            deleted: 0,
            fileId,
            groupId,
            name: 'Contract budget',
            encryptKeyId: null,
            owner: expect.any(String),
            usersWithAccess: [
              {
                userId: expect.any(String),
                userName: '',
                displayName: '',
                owner: true,
              },
            ],
          },
        ],
      });

      const info = await request('/sync/get-user-file-info', {
        headers: {
          'x-actual-token': token,
          'x-actual-file-id': fileId,
        },
      });
      expect(info.status).toBe(200);
      expect(await info.json()).toEqual({
        status: 'ok',
        data: {
          deleted: 0,
          fileId,
          groupId,
          name: 'Contract budget',
          encryptMeta: null,
          usersWithAccess: [
            {
              userId: expect.any(String),
              userName: '',
              displayName: '',
              owner: true,
            },
          ],
        },
      });

      const numericName = await request('/sync/update-user-filename', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: `{"fileId":"${fileId}","name":1e20}`,
      });
      expect(numericName.status).toBe(200);
      const renamedInfo = await request('/sync/get-user-file-info', {
        headers: {
          'x-actual-token': token,
          'x-actual-file-id': fileId,
        },
      });
      const renamedBody = (await renamedInfo.json()) as {
        data: { name: string };
      };
      expect(renamedBody.data.name).toBe('1.0e+20');

      const negativeZeroName = await request('/sync/update-user-filename', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: `{"fileId":"${fileId}","name":-0}`,
      });
      expect(negativeZeroName.status).toBe(200);
      const negativeZeroInfo = await request('/sync/get-user-file-info', {
        headers: {
          'x-actual-token': token,
          'x-actual-file-id': fileId,
        },
      });
      expect(
        ((await negativeZeroInfo.json()) as { data: { name: string } }).data
          .name,
      ).toBe('0.0');

      const download = await request('/sync/download-user-file', {
        headers: {
          'x-actual-token': token,
          'x-actual-file-id': fileId,
        },
      });
      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toBe(
        `attachment;filename=${fileId}`,
      );
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(fileContent);
    });

    it('exchanges the CRDT protocol as application/actual-sync', async () => {
      const invalid = await request('/sync/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/actual-sync',
          'x-actual-token': token,
        },
        body: 'invalid protobuf',
      });
      expect(invalid.status).toBe(500);
      expect(await invalid.json()).toEqual({
        status: 'error',
        reason: 'internal-error',
      });

      const withoutSince = create(SyncRequestSchema, { fileId, groupId });
      const missingSince = await request('/sync/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/actual-sync',
          'x-actual-token': token,
        },
        body: toBinary(SyncRequestSchema, withoutSince),
      });
      expect(missingSince.status).toBe(422);
      expect(await missingSince.json()).toEqual({
        status: 'error',
        reason: 'unprocessable-entity',
        details: 'since-required',
      });

      const syncRequest = create(SyncRequestSchema, {
        fileId,
        groupId,
        since: '2024-01-01T00:00:00.000Z',
      });
      const response = await request('/sync/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/actual-sync',
          'x-actual-token': token,
        },
        body: toBinary(SyncRequestSchema, syncRequest),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'application/actual-sync',
      );
      expect(response.headers.get('x-actual-sync-method')).toBe('simple');
      expect(
        fromBinary(
          SyncResponseSchema,
          new Uint8Array(await response.arrayBuffer()),
        ),
      ).toMatchObject({ merkle: '{}', messages: [] });

      const earlier = {
        timestamp: '2026-01-01T00:00:00.001Z-0000-0000000000000001',
        isEncrypted: false,
        content: new Uint8Array([1, 2, 3]),
      };
      const later = {
        timestamp: '2026-01-01T00:00:00.002Z-0000-0000000000000002',
        isEncrypted: true,
        content: new Uint8Array([4, 5, 6]),
      };
      const expectedEarlier = create(MessageEnvelopeSchema, earlier);
      const expectedLater = create(MessageEnvelopeSchema, later);
      async function exchange(
        messages: Array<{
          timestamp: string;
          isEncrypted: boolean;
          content: Uint8Array;
        }>,
        since: string,
      ) {
        const result = await request('/sync/sync', {
          method: 'POST',
          headers: {
            'content-type': 'application/actual-sync',
            'x-actual-token': token,
          },
          body: toBinary(
            SyncRequestSchema,
            create(SyncRequestSchema, {
              fileId,
              groupId,
              since,
              messages,
            }),
          ),
        });
        expect(result.status).toBe(200);
        return fromBinary(
          SyncResponseSchema,
          new Uint8Array(await result.arrayBuffer()),
        );
      }

      const negativeCounter = await request('/sync/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/actual-sync',
          'x-actual-token': token,
        },
        body: toBinary(
          SyncRequestSchema,
          create(SyncRequestSchema, {
            fileId,
            groupId,
            since: '2025-01-01T00:00:00.000Z',
            messages: [
              {
                timestamp: '2026-01-01T00:00:00.000Z--1-node',
                isEncrypted: false,
                content: new Uint8Array([0]),
              },
            ],
          }),
        ),
      });
      expect(negativeCounter.status).toBe(500);

      const inserted = await exchange(
        [later, earlier],
        '2025-01-01T00:00:00.000Z',
      );
      expect(inserted.messages).toEqual([]);
      expect(inserted.merkle).toBe(
        '{"2":{"0":{"0":{"1":{"1":{"0":{"2":{"1":{"0":{"1":{"2":{"2":{"2":{"0":{"0":{"0":{"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395}',
      );

      const readBack = await exchange([], '2025-01-01T00:00:00.000Z');
      expect(readBack.merkle).toBe(inserted.merkle);
      expect(readBack.messages).toEqual([expectedEarlier, expectedLater]);

      const duplicate = await exchange(
        [{ ...earlier, content: new Uint8Array([9, 9, 9]) }],
        '2025-01-01T00:00:00.000Z',
      );
      expect(duplicate.merkle).toBe(inserted.merkle);
      expect(duplicate.messages).toEqual([expectedEarlier, expectedLater]);

      const afterEarlier = await exchange(
        [],
        '2026-01-01T00:00:00.001Z-0000-0000000000000001',
      );
      expect(afterEarlier.messages).toEqual([expectedLater]);

      const nonCanonical = {
        timestamp: '2026-01-01T00:00:00.003+00:00-0x10-1',
        isEncrypted: false,
        content: new Uint8Array([7]),
      };
      const canonical = {
        ...nonCanonical,
        timestamp: '2026-01-01T00:00:00.003Z-0010-0000000000000001',
        content: new Uint8Array([8]),
      };
      const nonCanonicalResult = await exchange(
        [nonCanonical],
        '2025-01-01T00:00:00.000Z',
      );
      expect(JSON.parse(nonCanonicalResult.merkle).hash).not.toBe(471510395);
      const canonicalResult = await exchange(
        [canonical],
        '2025-01-01T00:00:00.000Z',
      );
      expect(JSON.parse(canonicalResult.merkle).hash).toBe(471510395);

      const signed = {
        timestamp: '2026-01-01T00:00:00.004+00:00-+10-2',
        isEncrypted: false,
        content: new Uint8Array([9]),
      };
      const signedCanonical = {
        ...signed,
        timestamp: '2026-01-01T00:00:00.004Z-0010-0000000000000002',
        content: new Uint8Array([10]),
      };
      const signedResult = await exchange([signed], '2025-01-01T00:00:00.000Z');
      expect(JSON.parse(signedResult.merkle).hash).not.toBe(471510395);
      const signedCanonicalResult = await exchange(
        [signedCanonical],
        '2025-01-01T00:00:00.000Z',
      );
      expect(JSON.parse(signedCanonicalResult.merkle).hash).toBe(471510395);
    });

    it('serves the GoCardless callback and reports credential status', async () => {
      const link = await request('/gocardless/link');
      expect(link.status).toBe(200);
      expect(link.headers.get('content-type')).toContain('text/html');
      expect(await link.text()).toContain('window.close();');

      const unconfigured = await request('/gocardless/status', {
        method: 'POST',
        headers: { 'x-actual-token': token },
      });
      expect(unconfigured.status).toBe(200);
      expect(await unconfigured.json()).toEqual({
        status: 'ok',
        data: { configured: false },
      });

      const invalidCountry = await request('/gocardless/get-banks', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({ country: '../' }),
      });
      expect(invalidCountry.status).toBe(200);
      expect(await invalidCountry.json()).toEqual({
        status: 'ok',
        data: {
          error_code: 'INTERNAL_ERROR',
          error_type: 'Invalid GoCardless identifier: ../',
        },
      });

      for (const [name, value] of [
        ['gocardless_secretId', 'contract-secret-id'],
        ['gocardless_secretKey', 'contract-secret-key'],
      ]) {
        const secret = await request('/secret/', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-actual-token': token,
          },
          body: JSON.stringify({ name, value }),
        });
        expect(secret.status).toBe(200);
      }

      const configured = await request('/gocardless/status', {
        method: 'POST',
        headers: { 'x-actual-token': token },
      });
      expect(configured.status).toBe(200);
      expect(await configured.json()).toEqual({
        status: 'ok',
        data: { configured: true },
      });
    });

    it('claims a SimpleFIN token and returns bank accounts', async () => {
      const setupToken = Buffer.from(`${simpleFinMockUrl}/claim`).toString(
        'base64',
      );
      const secret = await request('/secret/', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({ name: 'simplefin_token', value: setupToken }),
      });
      expect(secret.status).toBe(200);
      expect(await secret.json()).toEqual({ status: 'ok' });

      const status = await request('/simplefin/status', {
        method: 'POST',
        headers: { 'x-actual-token': token },
      });
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({
        status: 'ok',
        data: { configured: true },
      });

      const accounts = await request('/simplefin/accounts', {
        method: 'POST',
        headers: { 'x-actual-token': token },
      });
      expect(accounts.status).toBe(200);
      expect(await accounts.json()).toEqual({
        status: 'ok',
        data: {
          accounts: [
            {
              id: 'contract-account',
              name: 'Contract checking',
              currency: 'USD',
              balance: '123.45',
              'balance-date': 1704067200,
              org: { name: 'Contract Bank' },
              transactions: [],
            },
          ],
        },
      });

      const claimedAccessKey = await request('/secret/simplefin_accessKey', {
        headers: { 'x-actual-token': token },
      });
      expect(claimedAccessKey.status).toBe(204);

      const transactions = await request('/simplefin/transactions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({
          accountId: 'contract-account',
          startDate: '2024-01-01',
        }),
      });
      expect(transactions.status).toBe(200);
      expect(await transactions.json()).toEqual({
        status: 'ok',
        data: {
          balances: [
            {
              balanceAmount: { amount: '123.45', currency: 'USD' },
              balanceType: 'expected',
              referenceDate: '2024-01-03',
            },
            {
              balanceAmount: { amount: '123.45', currency: 'USD' },
              balanceType: 'interimAvailable',
              referenceDate: '2024-01-03',
            },
          ],
          startingBalance: 12345,
          transactions: {
            all: [
              {
                booked: false,
                sortOrder: 1704326400,
                date: '2024-01-04',
                payeeName: 'Contract Fuel',
                notes: 'Pending transaction',
                transactionAmount: { amount: '-5.00', currency: 'USD' },
                transactionId: 'pending-transaction',
                transactedDate: '2024-01-04',
              },
              {
                booked: true,
                sortOrder: 1704240000,
                date: '2024-01-03',
                payeeName: 'Contract Grocery',
                notes: 'Booked transaction',
                transactionAmount: { amount: '-10.00', currency: 'USD' },
                transactionId: 'booked-transaction',
                transactedDate: '2024-01-02',
                postedDate: '2024-01-03',
              },
            ],
            booked: [
              {
                booked: true,
                sortOrder: 1704240000,
                date: '2024-01-03',
                payeeName: 'Contract Grocery',
                notes: 'Booked transaction',
                transactionAmount: { amount: '-10.00', currency: 'USD' },
                transactionId: 'booked-transaction',
                transactedDate: '2024-01-02',
                postedDate: '2024-01-03',
              },
            ],
            pending: [
              {
                booked: false,
                sortOrder: 1704326400,
                date: '2024-01-04',
                payeeName: 'Contract Fuel',
                notes: 'Pending transaction',
                transactionAmount: { amount: '-5.00', currency: 'USD' },
                transactionId: 'pending-transaction',
                transactedDate: '2024-01-04',
              },
            ],
          },
        },
      });
    });

    it('uses Pluggy credentials, pagination, and transaction normalization', async () => {
      const unconfigured = await request('/pluggyai/status', {
        method: 'POST',
        headers: { 'x-actual-token': token },
      });
      expect(unconfigured.status).toBe(200);
      expect(await unconfigured.json()).toEqual({
        status: 'ok',
        data: { configured: false, source: null },
      });

      for (const [name, value] of [
        ['pluggyai_clientId', 'contract-client'],
        ['pluggyai_clientSecret', 'contract-secret'],
        ['pluggyai_itemIds', ' contract-item, '],
      ]) {
        const secret = await request('/secret/', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-actual-token': token,
          },
          body: JSON.stringify({ name, value }),
        });
        expect(secret.status).toBe(200);
      }

      const configured = await request('/pluggyai/status', {
        method: 'POST',
        headers: { 'x-actual-token': token },
      });
      expect(await configured.json()).toEqual({
        status: 'ok',
        data: { configured: true, source: 'global' },
      });

      const accounts = await request('/pluggyai/accounts', {
        method: 'POST',
        headers: { 'x-actual-token': token },
      });
      expect(accounts.status).toBe(200);
      expect(await accounts.json()).toEqual({
        status: 'ok',
        data: {
          accounts: [
            {
              id: 'contract-account',
              itemId: 'contract-item',
              name: 'Contract checking',
              type: 'BANK',
              balance: 100.125,
              currencyCode: 'BRL',
              updatedAt: '2024-03-31T12:00:00.000Z',
            },
          ],
        },
      });

      const transactions = await request('/pluggyai/transactions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({
          accountId: 'contract-account',
          startDate: '2024-01-01',
        }),
      });
      expect(transactions.status).toBe(200);
      const transactionsBody = (await transactions.json()) as {
        status: string;
        data: {
          balances: unknown;
          startingBalance: number;
          transactions: { all: Array<Record<string, unknown>> };
        };
      };
      expect(transactionsBody).toMatchObject({
        status: 'ok',
        data: {
          balances: [
            {
              balanceAmount: { amount: 10013, currency: 'BRL' },
              balanceType: 'expected',
              referenceDate: '2024-03-31',
            },
          ],
          startingBalance: 10013,
          transactions: {
            all: [
              {
                booked: false,
                date: '2024-04-01',
                originalDate: '2024-04-01',
                payeeName: 'Contract Payer',
                notes: 'Pending transfer',
                transactionAmount: { amount: 5, currency: 'BRL' },
                transactionId: 'pluggy-pending',
                sortOrder: 1711969200000,
                'paymentData.payer.name': 'Contract Payer',
              },
              {
                booked: true,
                date: '2024-02-29',
                originalDate: '2024-03-31',
                payeeName: 'Contract Market',
                notes: 'Raw description',
                transactionAmount: { amount: -12.34, currency: 'BRL' },
                transactionId: 'pluggy-booked',
                sortOrder: 1711879200000,
                'merchant.name': 'Contract Market',
                'creditCardMetadata.installmentNumber': 2,
              },
            ],
          },
        },
      });

      const upstream = await fetch(`${pluggyMockUrl}/contract/requests`);
      const upstreamRequests = (await upstream.json()) as Array<{
        method: string;
        url: string;
        apiKey?: string;
        contentType?: string;
        body: string;
      }>;
      expect(
        upstreamRequests.map(({ method, url }) => ({ method, url })),
      ).toEqual([
        { method: 'POST', url: '/auth' },
        { method: 'GET', url: '/accounts?itemId=contract-item' },
        { method: 'GET', url: '/accounts/contract-account' },
        {
          method: 'GET',
          url: '/v2/transactions?dateFrom=2024-01-01&accountId=contract-account',
        },
        {
          method: 'GET',
          url: '/v2/transactions?dateFrom=2024-01-01&after=contract-cursor&accountId=contract-account',
        },
        { method: 'GET', url: '/accounts/contract-account' },
      ]);
      expect(JSON.parse(upstreamRequests[0].body)).toEqual({
        clientId: 'contract-client',
        clientSecret: 'contract-secret',
        nonExpiring: false,
      });
      for (const upstreamRequest of upstreamRequests.slice(1)) {
        expect(upstreamRequest.apiKey).toMatch(
          /^[^.]+\.[^.]+\.contract-client$/,
        );
        expect(upstreamRequest.contentType).toBe('application/json');
      }
    });

    it('uses Akahu credentials, pagination, and New Zealand dates', async () => {
      const unconfigured = await request('/akahu/status', {
        method: 'POST',
        headers: { 'x-actual-token': token },
      });
      expect(await unconfigured.json()).toEqual({
        status: 'ok',
        data: { configured: false },
      });

      for (const [name, value] of [
        ['akahu_userToken', 'user_token_contract'],
        ['akahu_appToken', 'app_token_contract'],
      ]) {
        const secret = await request('/secret/', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-actual-token': token,
          },
          body: JSON.stringify({ name, value }),
        });
        expect(secret.status).toBe(200);
      }

      const configured = await request('/akahu/status', {
        method: 'POST',
        headers: { 'x-actual-token': token },
      });
      expect(await configured.json()).toEqual({
        status: 'ok',
        data: { configured: true },
      });

      const accounts = await request('/akahu/accounts', {
        method: 'POST',
        headers: { 'x-actual-token': token },
      });
      expect(await accounts.json()).toEqual({
        status: 'ok',
        data: {
          accounts: [
            {
              _id: 'acc-contract',
              name: 'Contract account',
              balance: {
                current: -1.005,
                available: 50,
                currency: 'NZD',
              },
              refreshed: {
                balance: '2024-01-01T11:30:00.000Z',
                transactions: '2099-01-01T00:00:00.000Z',
              },
            },
          ],
        },
      });

      const transactions = await request('/akahu/transactions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({
          accountId: 'acc-contract',
          startDate: '2024-01-01',
        }),
      });
      expect(await transactions.json()).toEqual({
        status: 'ok',
        data: {
          balances: [
            {
              balanceAmount: { amount: -100, currency: 'NZD' },
              balanceType: 'expected',
              referenceDate: '2024-01-02',
            },
            {
              balanceAmount: { amount: 5000, currency: 'NZD' },
              balanceType: 'interimAvailable',
              referenceDate: '2024-01-02',
            },
          ],
          startingBalance: -100,
          transactions: {
            all: [
              {
                date: '2024-01-04',
                description: 'Pending description',
                amount: -2.345,
                type: 'DEBIT',
                meta: { other_account: 'Contract Other Account' },
                booked: false,
                payeeName: 'Contract Other Account',
                merchant: { name: 'Contract Other Account' },
                notes: 'Pending description',
                sortOrder: Date.parse('2024-01-03T11:30:00.000Z'),
                transactionAmount: { amount: -2.35, currency: 'NZD' },
              },
              {
                _id: 'akahu-booked',
                date: '2024-01-03',
                description: 'Booked description',
                amount: -1.005,
                type: 'EFTPOS',
                merchant: { name: 'Contract Merchant' },
                category: 'Shopping',
                booked: true,
                payeeName: 'Contract Merchant',
                notes: 'Booked description',
                sortOrder: Date.parse('2024-01-02T11:30:00.000Z'),
                transactionAmount: { amount: -1, currency: 'NZD' },
                transactionId: 'akahu-booked',
              },
            ],
            booked: [
              {
                _id: 'akahu-booked',
                date: '2024-01-03',
                description: 'Booked description',
                amount: -1.005,
                type: 'EFTPOS',
                merchant: { name: 'Contract Merchant' },
                category: 'Shopping',
                booked: true,
                payeeName: 'Contract Merchant',
                notes: 'Booked description',
                sortOrder: Date.parse('2024-01-02T11:30:00.000Z'),
                transactionAmount: { amount: -1, currency: 'NZD' },
                transactionId: 'akahu-booked',
              },
            ],
            pending: [
              {
                date: '2024-01-04',
                description: 'Pending description',
                amount: -2.345,
                type: 'DEBIT',
                meta: { other_account: 'Contract Other Account' },
                booked: false,
                payeeName: 'Contract Other Account',
                merchant: { name: 'Contract Other Account' },
                notes: 'Pending description',
                sortOrder: Date.parse('2024-01-03T11:30:00.000Z'),
                transactionAmount: { amount: -2.35, currency: 'NZD' },
              },
            ],
          },
        },
      });

      const upstream = await fetch(`${akahuMockUrl}/../contract/requests`);
      const upstreamRequests = (await upstream.json()) as Array<{
        method: string;
        url: string;
        authorization?: string;
        appToken?: string;
        sdk?: string;
      }>;
      expect(
        upstreamRequests.map(({ method, url }) => ({
          method,
          pathname: new URL(url, akahuMockUrl).pathname,
        })),
      ).toEqual([
        { method: 'GET', pathname: '/v1/accounts' },
        { method: 'GET', pathname: '/v1/accounts/acc-contract' },
        {
          method: 'GET',
          pathname: '/v1/accounts/acc-contract/transactions',
        },
        {
          method: 'GET',
          pathname: '/v1/accounts/acc-contract/transactions',
        },
        {
          method: 'GET',
          pathname: '/v1/accounts/acc-contract/transactions/pending',
        },
      ]);
      const firstPage = new URL(upstreamRequests[2].url, akahuMockUrl);
      expect(firstPage.searchParams.get('start')).toBe(
        '2024-01-01T00:00:00.000Z',
      );
      expect(firstPage.searchParams.get('end')).toMatch(
        /^\d{4}-\d{2}-01T\d{2}:00:00\.000Z$/,
      );
      expect(firstPage.searchParams.has('cursor')).toBe(false);
      const secondPage = new URL(upstreamRequests[3].url, akahuMockUrl);
      expect(secondPage.searchParams.get('cursor')).toBe('cursor two/+value');
      for (const upstreamRequest of upstreamRequests) {
        expect(upstreamRequest.authorization).toBe(
          'Bearer user_token_contract',
        );
        expect(upstreamRequest.appToken).toBe('app_token_contract');
        expect(upstreamRequest.sdk).toBe('akahu-sdk-js/2.5.1');
      }
    });

    it('manages users and budget access as an administrator', async () => {
      const ownerCreated = await request('/admin/owner-created/');
      expect(ownerCreated.status).toBe(200);
      expect(await ownerCreated.json()).toBe(false);

      const initiallyVisible = await request('/admin/users/', {
        headers: { 'x-actual-token': token },
      });
      expect(initiallyVisible.status).toBe(200);
      expect(await initiallyVisible.json()).toEqual([]);

      const created = await request('/admin/users', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({
          userName: 'contract-basic',
          displayName: 'Contract Basic',
          enabled: true,
          role: 'BASIC',
        }),
      });
      expect(created.status).toBe(200);
      const createdBody = await created.json();
      expect(createdBody).toMatchObject({
        status: 'ok',
        data: { id: expect.any(String) },
      });
      const userId = (createdBody as { data: { id: string } }).data.id;

      const updated = await request('/admin/users', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({
          id: userId,
          userName: 'contract-basic',
          displayName: 'Contract Basic',
          enabled: true,
          role: 'BASIC',
        }),
      });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toEqual({
        status: 'ok',
        data: { id: userId },
      });

      const granted = await request('/admin/access', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({ fileId, userId }),
      });
      expect(granted.status).toBe(200);
      expect(await granted.json()).toEqual({ status: 'ok', data: {} });

      const usersWithAccess = await request(
        `/admin/access/users?fileId=${fileId}`,
        { headers: { 'x-actual-token': token } },
      );
      expect(usersWithAccess.status).toBe(200);
      expect(await usersWithAccess.json()).toEqual([
        {
          userId,
          userName: 'contract-basic',
          displayName: 'Contract Basic',
          haveAccess: 1,
          owner: 0,
        },
      ]);

      const transferred = await request('/admin/access/transfer-ownership/', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({ fileId, newUserId: userId }),
      });
      expect(transferred.status).toBe(200);
      expect(await transferred.json()).toEqual({ status: 'ok', data: {} });

      const removed = await request(`/admin/access?fileId=${fileId}`, {
        method: 'DELETE',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({ ids: [userId] }),
      });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({
        status: 'ok',
        data: { someDeletionsFailed: false },
      });

      const ownership = await request(`/admin/access/users?fileId=${fileId}`, {
        headers: { 'x-actual-token': token },
      });
      expect(ownership.status).toBe(200);
      expect(await ownership.json()).toEqual([
        {
          userId,
          userName: 'contract-basic',
          displayName: 'Contract Basic',
          haveAccess: 0,
          owner: 1,
        },
      ]);
    });

    it('completes an OpenID authorization-code login', async () => {
      const missingClient = await request('/openid/enable', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({
          openId: {
            issuer: openIdMockUrl,
            client_secret: 'contract-secret',
            server_hostname: serverUrl,
          },
        }),
      });
      expect(missingClient.status).toBe(500);
      expect(await missingClient.json()).toEqual({
        status: 'error',
        reason: 'missing-client-id',
      });

      const malformedDiscovery = await request('/openid/enable', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({
          openId: {
            issuer: `${openIdMockUrl}/.well-known/malformed`,
            client_id: 'contract-client',
            client_secret: 'contract-secret',
            server_hostname: serverUrl,
          },
        }),
      });
      expect(malformedDiscovery.status).toBe(500);
      expect(await malformedDiscovery.json()).toEqual({
        status: 'error',
        reason: 'configuration-error',
      });

      const enabled = await request('/openid/enable', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actual-token': token,
        },
        body: JSON.stringify({
          openId: {
            issuer: openIdMockUrl,
            client_id: 'contract-client',
            client_secret: 'contract-secret',
            server_hostname: serverUrl,
            authMethod: 'openid',
          },
        }),
      });
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toEqual({ status: 'ok' });

      const passwordLogin = await request('/account/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          loginMethod: 'password',
          password: 'contract-password',
        }),
      });
      expect(passwordLogin.status).toBe(200);
      token = readToken(await passwordLogin.json());

      const setup = await request('/account/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          loginMethod: 'openid',
          returnUrl: serverUrl,
        }),
      });
      expect(setup.status).toBe(200);
      const setupBody = (await setup.json()) as {
        status: string;
        data: { returnUrl: string };
      };
      expect(setupBody.status).toBe('ok');
      const authorizationUrl = new URL(setupBody.data.returnUrl);
      expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
        `${openIdMockUrl}/oauth/authorize`,
      );
      expect(authorizationUrl.searchParams.get('client_id')).toBe(
        'contract-client',
      );
      expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe(
        'S256',
      );
      const state = authorizationUrl.searchParams.get('state');
      expect(state).toEqual(expect.any(String));

      const authorization = await fetch(authorizationUrl, {
        redirect: 'manual',
      });
      expect(authorization.status).toBe(302);
      const callbackUrl = authorization.headers.get('location');
      expect(callbackUrl).toEqual(expect.any(String));
      const callback = await fetch(callbackUrl ?? serverUrl, {
        redirect: 'manual',
      });
      expect(callback.status).toBe(302);
      const location = callback.headers.get('location');
      expect(location).toEqual(expect.any(String));
      const redirect = new URL(location ?? serverUrl);
      expect(`${redirect.origin}${redirect.pathname}`).toBe(
        `${serverUrl}/openid-cb`,
      );
      const openIdToken = redirect.searchParams.get('token');
      expect(openIdToken).toEqual(expect.any(String));

      const validated = await request('/account/validate', {
        headers: { 'x-actual-token': openIdToken ?? '' },
      });
      expect(validated.status).toBe(200);
      expect(await validated.json()).toMatchObject({
        status: 'ok',
        data: {
          validated: true,
          userName: 'contract-basic',
          displayName: 'Contract Basic',
          permission: 'BASIC',
          loginMethod: 'openid',
        },
      });
    });
  },
);
