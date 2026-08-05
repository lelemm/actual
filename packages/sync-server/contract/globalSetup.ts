import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';

import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  // An interface is required for Vitest's module augmentation.
  // oxlint-disable-next-line typescript/consistent-type-definitions
  export interface ProvidedContext {
    contractServerUrl: string;
    simpleFinMockUrl: string;
    openIdMockUrl: string;
    pluggyMockUrl: string;
    akahuMockUrl: string;
    corsProxyMockUrl: string;
    enableBankingMockUrl: string;
    enableBankingSecretKey: string;
    goCardlessMockUrl: string;
  }
}

const packageRoot = resolve(fileURLToPath(import.meta.url), '../..');

async function getAvailablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a contract-test port');
  }
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function assertLoopback(url: string) {
  const hostname = new URL(url).hostname;
  if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
    throw new Error(
      'ACTUAL_CONTRACT_SERVER_URL must target an isolated loopback server',
    );
  }
}

async function waitUntilHealthy(url: string, child: ChildProcess) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Contract server exited with code ${child.exitCode}`);
    }
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Contract server did not become healthy within 20 seconds');
}

async function startSimpleFinMock() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const openIdRequests = new Map<string, string>();
  const requests: Array<{
    origin: 'primary' | 'redirect';
    method?: string;
    url?: string;
    authorization?: string;
    contentType?: string;
    contentLength?: string;
    body: string;
  }> = [];
  const recordRequest = (
    request: IncomingMessage,
    origin: 'primary' | 'redirect',
  ) => {
    const recorded = {
      origin,
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'],
      contentLength: request.headers['content-length'],
      body: '',
    };
    requests.push(recorded);
    request.on('data', chunk => {
      recorded.body += Buffer.from(chunk).toString();
    });
  };
  const redirectServer = createHttpServer((request, response) => {
    recordRequest(request, 'redirect');
    if (request.url === '/cross/step') {
      response.writeHead(302, { location: '/cross/final' }).end();
      return;
    }
    if (request.url === '/cross/final') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          accounts: [
            {
              id: 'redirected-account',
              currency: 'USD',
              balance: '10.00',
              'balance-date': 1704067200,
              org: { name: 'Redirect Bank' },
              transactions: [],
            },
          ],
          errors: [],
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  const server = createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/contract/requests') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(requests));
      return;
    }
    if (request.method === 'POST' && request.url === '/contract/reset') {
      requests.length = 0;
      response.writeHead(204).end();
      return;
    }

    const simpleFinUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (
      simpleFinUrl.pathname.startsWith('/claim') ||
      simpleFinUrl.pathname.startsWith('/simplefin')
    ) {
      recordRequest(request, 'primary');
    }

    if (request.method === 'POST' && simpleFinUrl.pathname === '/claim') {
      const address = server.address();
      if (!address || typeof address === 'string') {
        response.writeHead(500).end();
        return;
      }
      response
        .writeHead(200, { 'content-type': 'text/plain' })
        .end(
          `http://contract-user:contract-password@127.0.0.1:${address.port}/simplefin`,
        );
      return;
    }

    if (
      request.method === 'POST' &&
      simpleFinUrl.pathname === '/claim-forbidden'
    ) {
      response
        .writeHead(403, { 'content-type': 'text/plain' })
        .end('Forbidden (was it already claimed?)');
      return;
    }
    if (
      request.method === 'POST' &&
      simpleFinUrl.pathname === '/claim-redirect'
    ) {
      response.writeHead(302, { location: '/claim' }).end();
      return;
    }
    if (request.method === 'POST' && simpleFinUrl.pathname === '/claim-502') {
      response
        .writeHead(502, { 'content-type': 'text/plain' })
        .end('Bad Gateway');
      return;
    }
    if (
      request.method === 'POST' &&
      simpleFinUrl.pathname === '/claim-json-error'
    ) {
      response
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'claim failed' }));
      return;
    }
    if (
      request.method === 'POST' &&
      simpleFinUrl.pathname === '/claim-invalid-access-key'
    ) {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<html>not an access key</html>');
      return;
    }

    const address = server.address();
    const baseUrl =
      address && typeof address !== 'string'
        ? `http://127.0.0.1:${address.port}`
        : null;
    if (
      request.method === 'GET' &&
      request.url === '/.well-known/openid-configuration' &&
      baseUrl
    ) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/oauth/authorize`,
          token_endpoint: `${baseUrl}/oauth/token`,
          userinfo_endpoint: `${baseUrl}/oauth/userinfo`,
          jwks_uri: `${baseUrl}/oauth/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        }),
      );
      return;
    }

    if (request.method === 'GET' && request.url === '/.well-known/malformed') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{');
      return;
    }

    if (request.method === 'GET' && request.url === '/oauth/jwks') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          keys: [
            {
              ...publicJwk,
              kid: 'contract-key',
              use: 'sig',
              alg: 'RS256',
            },
          ],
        }),
      );
      return;
    }

    if (
      request.method === 'GET' &&
      request.url?.startsWith('/oauth/authorize?') &&
      baseUrl
    ) {
      const authorizationUrl = new URL(request.url, baseUrl);
      const state = authorizationUrl.searchParams.get('state');
      const redirectUri = authorizationUrl.searchParams.get('redirect_uri');
      if (!state || !redirectUri) {
        response.writeHead(400).end();
        return;
      }
      const nonce = authorizationUrl.searchParams.get('nonce') ?? state;
      const code = `contract-code-${openIdRequests.size}`;
      openIdRequests.set(code, nonce);
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', state);
      callback.searchParams.set('iss', baseUrl);
      response.writeHead(302, { location: callback.toString() }).end();
      return;
    }

    if (
      request.method === 'POST' &&
      request.url === '/oauth/token' &&
      baseUrl
    ) {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        if (!openIdRequests.has(form.get('code') ?? '')) {
          response.writeHead(400).end();
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(
          JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'contract-key' }),
        ).toString('base64url');
        const payload = Buffer.from(
          JSON.stringify({
            iss: baseUrl,
            aud: 'contract-client',
            sub: 'contract-openid-subject',
            iat: now,
            exp: now + 600,
          }),
        ).toString('base64url');
        const unsigned = `${header}.${payload}`;
        const signature = sign(
          'RSA-SHA256',
          Buffer.from(unsigned),
          privateKey,
        ).toString('base64url');
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            access_token: 'contract-openid-access-token',
            token_type: 'Bearer',
            expires_in: 600,
            id_token: `${unsigned}.${signature}`,
          }),
        );
      });
      return;
    }

    if (
      request.method === 'GET' &&
      request.url === '/oauth/userinfo' &&
      request.headers.authorization === 'Bearer contract-openid-access-token'
    ) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          sub: 'contract-openid-subject',
          preferred_username: 'contract-basic',
          name: 'Contract Basic',
        }),
      );
      return;
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const hasSimpleFinAuth =
      request.headers.authorization ===
      `Basic ${Buffer.from('contract-user:contract-password').toString('base64')}`;
    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/plain-error/accounts'
    ) {
      response
        .writeHead(502, { 'content-type': 'text/plain' })
        .end('Bad Gateway');
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/json-error/accounts'
    ) {
      response
        .writeHead(502, { 'content-type': 'application/json' })
        .end(JSON.stringify({ message: 'upstream failed' }));
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/forbidden/accounts'
    ) {
      response
        .writeHead(403, { 'content-type': 'text/plain' })
        .end('Forbidden');
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/invalid-json/accounts'
    ) {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('not JSON');
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/non-object-array/accounts'
    ) {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify([]));
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/non-object-null/accounts'
    ) {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end('null');
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/non-object-string/accounts'
    ) {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify('valid JSON string'));
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/accounts-without-errors/accounts'
    ) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          accounts: [
            {
              id: 'missing-errors-account',
              currency: 'USD',
              balance: '10.00',
              'balance-date': 1704067200,
              org: { name: 'Missing Errors Bank' },
              transactions: [],
            },
          ],
        }),
      );
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/redirect-same/accounts'
    ) {
      response
        .writeHead(302, { location: '/simplefin/redirect-final/accounts' })
        .end();
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/redirect-final/accounts' &&
      hasSimpleFinAuth
    ) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          accounts: [{ id: 'same-origin-account' }],
          errors: [],
        }),
      );
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/redirect-cross/accounts'
    ) {
      const address = redirectServer.address();
      if (!address || typeof address === 'string') {
        response.writeHead(500).end();
        return;
      }
      response
        .writeHead(302, {
          location: `http://127.0.0.1:${address.port}/cross/step`,
        })
        .end();
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/redirect-link-local/accounts'
    ) {
      response
        .writeHead(302, {
          location: 'http://169.254.169.254/latest/meta-data/',
        })
        .end();
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/redirect-mapped-link-local/accounts'
    ) {
      response
        .writeHead(302, {
          location: 'http://[::ffff:169.254.169.254]/latest/meta-data/',
        })
        .end();
      return;
    }
    if (
      request.method === 'GET' &&
      (url.pathname === '/simplefin/redirect-loop/accounts' ||
        /^\/simplefin\/redirect-loop-\d+$/.test(url.pathname))
    ) {
      const current = Number(url.pathname.match(/redirect-loop-(\d+)$/)?.[1]);
      response.writeHead(302, {
        location: `/simplefin/redirect-loop-${Number.isNaN(current) ? 1 : current + 1}`,
      });
      response.end();
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/edges/accounts' &&
      hasSimpleFinAuth
    ) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          accounts: [
            {
              id: 'edge-account',
              name: 'Edge checking',
              currency: 'CAD',
              balance: '-12.34',
              'balance-date': 1704240000,
              org: { name: 'Edge Bank' },
              transactions: [
                {
                  id: 'edge-booked',
                  pending: false,
                  posted: 1704240000,
                  transacted_at: 1704153600,
                  amount: '-2.50',
                  payee: 'Edge Grocery',
                  description: 'Booked edge transaction',
                },
                {
                  id: 'edge-pending',
                  pending: 'false',
                  posted: 0,
                  transacted_at: 1704326400,
                  amount: '-1.25',
                  payee: 'Edge Fuel',
                  description: 'Truthy pending marker',
                },
                {
                  id: 'edge-old',
                  posted: 1704067200,
                  amount: '-9.00',
                  payee: 'Filtered',
                  description: 'Before this account start date',
                },
              ],
            },
          ],
          errors: ['Connection to Edge Bank may need attention: reconnect'],
        }),
      );
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/accounts' &&
      url.searchParams.get('balances-only') === '1' &&
      hasSimpleFinAuth
    ) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
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
        }),
      );
      return;
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/simplefin/accounts' &&
      url.searchParams.get('pending') === '1' &&
      url.searchParams.getAll('account').includes('contract-account') &&
      hasSimpleFinAuth
    ) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          accounts: [
            {
              id: 'contract-account',
              name: 'Contract checking',
              currency: 'USD',
              balance: '123.45',
              'balance-date': 1704240000,
              org: { name: 'Contract Bank' },
              transactions: [
                {
                  id: 'booked-transaction',
                  posted: 1704240000,
                  transacted_at: 1704153600,
                  amount: '-10.00',
                  payee: 'Contract Grocery',
                  description: 'Booked transaction',
                },
                {
                  id: 'pending-transaction',
                  pending: true,
                  posted: 0,
                  transacted_at: 1704326400,
                  amount: '-5.00',
                  payee: 'Contract Fuel',
                  description: 'Pending transaction',
                },
                {
                  id: 'old-transaction',
                  posted: 1672531200,
                  amount: '-1.00',
                  payee: 'Old transaction',
                  description: 'Filtered by start date',
                },
              ],
            },
          ],
          errors: [],
        }),
      );
      return;
    }

    response.writeHead(404).end();
  });
  redirectServer.listen(0, '127.0.0.1');
  server.listen(0, '127.0.0.1');
  await Promise.all([
    once(redirectServer, 'listening'),
    once(server, 'listening'),
  ]);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start the SimpleFIN contract server');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      Promise.all([
        new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          redirectServer.close(error => (error ? reject(error) : resolve())),
        ),
      ]).then(() => undefined),
  };
}

async function startPluggyMock(requestedUrl?: string) {
  const requests: Array<{
    method?: string;
    url?: string;
    apiKey?: string;
    contentType?: string;
    userAgent?: string;
    accept?: string;
    acceptEncoding?: string;
    body: string;
    receivedAt: number;
  }> = [];
  const authCounts = new Map<string, number>();
  const rateLimitCounts = new Map<string, number>();
  const jwt = (clientId: string, expired = false) => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({
        clientId,
        exp: Math.floor(Date.now() / 1000) + (expired ? -60 : 600),
      }),
    ).toString('base64url');
    return `${header}.${payload}.${clientId}`;
  };
  const sendJson = (
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    response
      .writeHead(status, { 'content-type': 'application/json', ...headers })
      .end(JSON.stringify(body));
  };
  const server = createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/contract/requests') {
      sendJson(response, 200, requests);
      return;
    }
    if (request.method === 'POST' && request.url === '/contract/reset') {
      requests.splice(0);
      authCounts.clear();
      rateLimitCounts.clear();
      response.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      requests.push({
        method: request.method,
        url: request.url,
        apiKey: request.headers['x-api-key'] as string | undefined,
        contentType: request.headers['content-type'],
        userAgent: request.headers['user-agent'],
        accept: request.headers.accept,
        acceptEncoding: request.headers['accept-encoding'],
        body,
        receivedAt: Date.now(),
      });
      if (request.method === 'POST' && request.url === '/auth') {
        const credentials = JSON.parse(body) as { clientId: string };
        const count = (authCounts.get(credentials.clientId) ?? 0) + 1;
        authCounts.set(credentials.clientId, count);
        if (
          credentials.clientId === 'auth-flaky-network-client' &&
          count === 1
        ) {
          request.socket.destroy();
          return;
        }
        if (credentials.clientId === 'auth-error-client') {
          sendJson(response, 502, { message: 'Pluggy auth failed' });
          return;
        }
        if (credentials.clientId === 'auth-malformed-client') {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end('{');
          return;
        }
        sendJson(response, 200, {
          apiKey: jwt(
            credentials.clientId,
            credentials.clientId === 'expired-client' && count === 1,
          ),
        });
        return;
      }
      const url = new URL(request.url ?? '/', 'http://pluggy.contract');
      if (
        request.method === 'GET' &&
        url.pathname === '/accounts' &&
        url.searchParams.get('itemId') !== 'contract-item'
      ) {
        const itemId = url.searchParams.get('itemId');
        if (itemId === 'error-item') {
          sendJson(response, 502, { message: 'Pluggy accounts failed' });
          return;
        }
        if (itemId === 'malformed-item') {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end('{');
          return;
        }
        if (itemId === 'malformed-token-item') {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end('not-json');
          return;
        }
        if (itemId === 'malformed-array-item') {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end('[');
          return;
        }
        if (itemId === 'malformed-value-item') {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end('{"x":}');
          return;
        }
        if (itemId === 'malformed-trailing-item') {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end('nullx');
          return;
        }
        if (itemId === 'malformed-key-item') {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end('{x:1}');
          return;
        }
        const eofBodies: Record<string, string> = {
          'malformed-string-item': '"foo{',
          'malformed-object-string-item': '{"x":"{',
          'malformed-dangling-escape-item': '{"x":"foo\\',
          'malformed-unicode-escape-item': '{"x":"\\u',
          'malformed-partial-unicode-escape-item': '{"x":"\\u12',
          'malformed-incomplete-true-item': '{"x":tru',
          'malformed-trailing-newline-item': '{\n',
          'malformed-utf16-item': '{"😀":1',
          'malformed-utf16-newline-item': '{\n"😀":1',
          'malformed-array-object-item': '[{',
          'malformed-nested-start-item': '{"x": {',
          'malformed-nested-value-item': '{"x":{"y":1',
        };
        if (itemId && itemId in eofBodies) {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(eofBodies[itemId]);
          return;
        }
        if (itemId === 'error-without-message-item') {
          sendJson(response, 502, { code: 'NO_MESSAGE' });
          return;
        }
        if (itemId === 'error-number-message-item') {
          sendJson(response, 502, { message: 42 });
          return;
        }
        if (itemId === 'error-null-message-item') {
          sendJson(response, 502, { message: null });
          return;
        }
        if (itemId === 'flaky-network-item') {
          const count = (rateLimitCounts.get(itemId) ?? 0) + 1;
          rateLimitCounts.set(itemId, count);
          if (count === 1) {
            request.socket.destroy();
            return;
          }
        }
        if (itemId === 'network-item') {
          const count = (rateLimitCounts.get(itemId) ?? 0) + 1;
          rateLimitCounts.set(itemId, count);
          if (count < 3) {
            sendJson(
              response,
              429,
              { message: 'Pluggy rate limited before network failure' },
              { 'retry-after': '0.001' },
            );
            return;
          }
          request.socket.destroy();
          return;
        }
        if (itemId === 'rate-item') {
          const count = (rateLimitCounts.get(itemId) ?? 0) + 1;
          rateLimitCounts.set(itemId, count);
          if (count < 3) {
            sendJson(
              response,
              429,
              { message: 'Pluggy rate limited' },
              { 'retry-after': '0.05' },
            );
            return;
          }
        }
        if (
          itemId === 'rate-missing-hint-item' ||
          itemId === 'rate-invalid-hint-item' ||
          itemId === 'rate-zero-hint-item'
        ) {
          const count = (rateLimitCounts.get(itemId) ?? 0) + 1;
          rateLimitCounts.set(itemId, count);
          if (count < 3) {
            sendJson(
              response,
              429,
              { message: 'Pluggy rate limited without a usable hint' },
              itemId === 'rate-invalid-hint-item'
                ? { 'retry-after': 'not-a-delay' }
                : itemId === 'rate-zero-hint-item'
                  ? { 'retry-after': '0' }
                  : {},
            );
            return;
          }
        }
        if (itemId === 'body-reset-item') {
          const count = (rateLimitCounts.get(itemId) ?? 0) + 1;
          rateLimitCounts.set(itemId, count);
          if (count === 1) {
            response.writeHead(200, {
              'content-type': 'application/json',
              'content-length': '100',
            });
            response.write('{"results":');
            response.destroy();
            return;
          }
        }
        if (itemId?.startsWith('truncated-compressed-')) {
          const encoding = itemId.slice('truncated-compressed-'.length);
          const payload = Buffer.from('{"results":[],"total":0}');
          const compressed =
            encoding === 'gzip'
              ? gzipSync(payload)
              : encoding === 'deflate'
                ? deflateSync(payload)
                : brotliCompressSync(payload);
          const truncated = compressed.subarray(0, compressed.length - 4);
          response
            .writeHead(200, {
              'content-type': 'application/json',
              'content-encoding': encoding,
              'content-length': String(truncated.length),
            })
            .end(truncated);
          return;
        }
        if (itemId === 'results-missing-item') {
          sendJson(response, 200, { total: 0 });
          return;
        }
        if (itemId === 'results-null-item') {
          sendJson(response, 200, { results: null, total: 0 });
          return;
        }
        if (itemId === 'results-object-item') {
          sendJson(response, 200, {
            results: { id: 'object-result' },
            total: 1,
          });
          return;
        }
        const accountId =
          itemId === 'budget-item'
            ? 'budget-account'
            : itemId === 'credit-item'
              ? 'credit-account'
              : itemId === 'sandbox-item'
                ? 'sandbox-account'
                : `${itemId ?? 'missing'}-account`;
        sendJson(response, 200, {
          results: [
            {
              id: accountId,
              itemId,
              name: `${itemId} account`,
              type: itemId === 'credit-item' ? 'CREDIT' : 'BANK',
              balance: itemId === 'credit-item' ? 321.456 : 100.125,
              currencyCode: 'BRL',
              updatedAt: '2024-03-31T12:00:00.000Z',
              ...(itemId === 'missing-item'
                ? { balance: null, updatedAt: null }
                : {}),
            },
          ],
          total: 1,
        });
        return;
      }
      if (
        request.method === 'GET' &&
        request.url === '/accounts?itemId=contract-item'
      ) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            results: [
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
            total: 1,
          }),
        );
        return;
      }
      if (
        request.method === 'GET' &&
        request.url === '/accounts/contract-account'
      ) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: 'contract-account',
            owner: 'Contract Owner',
            type: 'BANK',
            balance: 100.125,
            currencyCode: 'BRL',
            updatedAt: '2024-03-31T12:00:00.000Z',
          }),
        );
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/accounts/')) {
        const accountId = url.pathname.slice('/accounts/'.length);
        if (accountId === 'error-account') {
          sendJson(response, 503, { message: 'Pluggy account failed' });
          return;
        }
        if (accountId === 'malformed-account') {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end('{');
          return;
        }
        const credit = accountId === 'credit-account';
        const sandbox = accountId === 'sandbox-account';
        sendJson(response, 200, {
          id: accountId,
          owner: sandbox ? 'John Doe' : 'Contract Owner',
          type: credit ? 'CREDIT' : 'BANK',
          ...(accountId === 'omitted-balance-account'
            ? {}
            : {
                balance:
                  accountId === 'null-balance-account'
                    ? null
                    : accountId === 'nan-balance-account'
                      ? 'NaN'
                      : credit
                        ? 321.456
                        : 100.125,
              }),
          currencyCode: 'BRL',
          updatedAt:
            accountId === 'missing-account'
              ? null
              : accountId === 'invalid-date-account'
                ? '2024-99-99T99:99:99.999Z'
                : accountId === 'rollover-date-account'
                  ? '2024-02-30T12:00:00.000Z'
                  : accountId === 'impossible-date-account'
                    ? '2024-13-01T12:00:00.000Z'
                    : '2024-03-31T12:00:00.000Z',
        });
        return;
      }
      if (
        request.method === 'GET' &&
        request.url ===
          '/v2/transactions?dateFrom=2024-01-01&accountId=contract-account'
      ) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            results: [
              {
                id: 'pluggy-booked',
                status: 'POSTED',
                type: 'DEBIT',
                date: '2024-03-31T10:00:00.000Z',
                amount: -12.345,
                currencyCode: 'BRL',
                description: 'Fallback description',
                descriptionRaw: 'Raw description',
                merchant: { name: 'Contract Market', category: null },
                creditCardMetadata: {
                  installmentNumber: 2,
                  purchaseDate: '2024-01-31T10:00:00.000Z',
                },
              },
            ],
            next: '/v2/transactions?after=contract-cursor',
          }),
        );
        return;
      }
      if (
        request.method === 'GET' &&
        request.url ===
          '/v2/transactions?dateFrom=2024-01-01&after=contract-cursor&accountId=contract-account'
      ) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            results: [
              {
                id: 'pluggy-pending',
                status: 'PENDING',
                type: 'CREDIT',
                date: '2024-04-01T11:00:00.000Z',
                amount: 5,
                currencyCode: 'BRL',
                description: 'Pending transfer',
                paymentData: { payer: { name: 'Contract Payer' } },
              },
            ],
            next: null,
          }),
        );
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v2/transactions') {
        const accountId = url.searchParams.get('accountId');
        if (accountId === 'error-account') {
          sendJson(response, 502, { message: 'Pluggy transactions failed' });
          return;
        }
        if (accountId === 'malformed-account') {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end('{');
          return;
        }
        const sandbox = accountId === 'sandbox-account';
        const credit = accountId === 'credit-account';
        const after = url.searchParams.get('after');
        if (!after) {
          sendJson(response, 200, {
            results: [
              {
                id: `${accountId}-booked`,
                status: 'POSTED',
                type: 'DEBIT',
                date:
                  accountId === 'missing-transaction-date-account'
                    ? undefined
                    : sandbox
                      ? '2001-01-31T10:00:00.000Z'
                      : '2024-03-31T10:00:00.000Z',
                amount: credit ? 12.345 : -12.345,
                amountInAccountCurrency: credit ? 10.005 : undefined,
                currencyCode: 'BRL',
                description: 'Fallback description',
                descriptionRaw: 'Raw description',
                merchant: { name: 'Contract Market', category: null },
                creditCardMetadata: credit
                  ? {
                      installmentNumber: 2,
                      purchaseDate: '2024-01-31T10:00:00.000Z',
                    }
                  : undefined,
              },
              ...(sandbox ? [] : [{}, 'ignored']),
            ],
            next: `/v2/transactions?after=${accountId}-cursor`,
          });
          return;
        }
        sendJson(response, 200, {
          results: [
            {
              id: `${accountId}-pending`,
              status: 'PENDING',
              type: 'CREDIT',
              date: sandbox
                ? '2001-02-01T11:00:00.000Z'
                : '2024-04-01T11:00:00.000Z',
              amount: credit ? -5 : 5,
              currencyCode: 'BRL',
              description: 'Pending transfer',
              paymentData: {
                payer: { documentNumber: { value: 'payer-document' } },
              },
            },
          ],
          next: null,
        });
        return;
      }
      response.writeHead(404).end();
    });
  });
  const requested = requestedUrl ? new URL(requestedUrl) : undefined;
  server.listen(requested ? Number(requested.port) : 0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start the Pluggy contract server');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  };
}

async function startAkahuMock(requestedUrl?: string) {
  const requests: Array<{
    method?: string;
    url?: string;
    authorization?: string;
    appToken?: string;
    sdk?: string;
    idempotencyKey?: string;
    userAgent?: string;
    accept?: string;
    acceptEncoding?: string;
    contentType?: string;
    contentLength?: string;
    body: string;
  }> = [];
  const refreshPolls = new Map<string, number>();
  const account = {
    _id: 'acc-contract',
    name: 'Contract account',
    balance: { current: -1.005, available: 50, currency: 'NZD' },
    refreshed: {
      balance: '2024-01-01T11:30:00.000Z',
      transactions: '2099-01-01T00:00:00.000Z',
    },
  };
  const server = createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/contract/requests') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(requests));
      return;
    }
    if (request.method === 'POST' && request.url === '/contract/reset') {
      requests.length = 0;
      refreshPolls.clear();
      response.writeHead(204).end();
      return;
    }
    const recorded = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      appToken: request.headers['x-akahu-id'] as string | undefined,
      sdk: request.headers['x-akahu-sdk'] as string | undefined,
      idempotencyKey: request.headers['idempotency-key'] as string | undefined,
      userAgent: request.headers['user-agent'],
      accept: request.headers.accept,
      acceptEncoding: request.headers['accept-encoding'],
      contentType: request.headers['content-type'],
      contentLength: request.headers['content-length'],
      body: '',
    };
    requests.push(recorded);
    request.on('data', chunk => {
      recorded.body += Buffer.from(chunk).toString();
    });
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/accounts') {
      if (
        request.headers.authorization === 'Bearer user_token_connection-reset'
      ) {
        request.socket.destroy();
        return;
      }
      if (request.headers.authorization === 'Bearer user_token_stalled') {
        setTimeout(() => {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ success: true, items: [account] }));
        }, 250);
        return;
      }
      if (request.headers.authorization === 'Bearer user_token_http-error') {
        response
          .writeHead(503, { 'content-type': 'application/json' })
          .end(
            JSON.stringify({ success: false, message: 'Akahu unavailable' }),
          );
        return;
      }
      if (request.headers.authorization === 'Bearer user_token_non-json') {
        response
          .writeHead(200, { 'content-type': 'text/plain' })
          .end('not json');
        return;
      }
      if (request.headers.authorization === 'Bearer user_token_rejected') {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ success: false, message: 'Akahu rejected' }));
        return;
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ success: true, items: [account] }));
      return;
    }
    const accountMatch = /^\/v1\/accounts\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && accountMatch) {
      const accountId = accountMatch[1];
      if (accountId === 'missing-account') {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ success: true }));
        return;
      }
      if (accountId === 'account-http-error') {
        response
          .writeHead(502, { 'content-type': 'application/json' })
          .end(JSON.stringify({ success: false, message: 'Account failed' }));
        return;
      }
      const polls = refreshPolls.get(accountId) ?? 0;
      refreshPolls.set(accountId, polls + 1);
      const stale =
        accountId === 'timeout-account' ||
        (accountId === 'refresh-account' && polls === 0) ||
        accountId === 'refresh-failure-account';
      const item = {
        ...account,
        _id: accountId,
        ...(accountId === 'missing-balance-account'
          ? { balance: undefined }
          : {}),
        refreshed: {
          balance:
            accountId === 'malformed-balance-date-account'
              ? 'not-a-date'
              : account.refreshed.balance,
          transactions: stale
            ? '2000-01-01T00:00:00.000Z'
            : accountId === 'malformed-refresh-date-account'
              ? 'not-a-date'
              : account.refreshed.transactions,
        },
      };
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ success: true, item }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/refresh') {
      if (
        request.headers.authorization === 'Bearer user_token_refresh-failure'
      ) {
        response
          .writeHead(500, { 'content-type': 'application/json' })
          .end(JSON.stringify({ success: false, message: 'Refresh failed' }));
        return;
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ success: true }));
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/v1/accounts/acc-contract'
    ) {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ success: true, item: account }));
      return;
    }
    if (
      request.method === 'GET' &&
      /^\/v1\/accounts\/[^/]+\/transactions$/.test(url.pathname)
    ) {
      const accountId = url.pathname.split('/').at(-2);
      if (accountId === 'transactions-http-error') {
        response
          .writeHead(500, { 'content-type': 'application/json' })
          .end(
            JSON.stringify({ success: false, message: 'Transactions failed' }),
          );
        return;
      }
      const isSecondPage =
        url.searchParams.get('cursor') === 'cursor two/+value';
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          success: true,
          items: isSecondPage
            ? []
            : [
                {
                  _id: 'akahu-booked',
                  date: '2024-01-02T11:30:00.000Z',
                  description: 'Booked description',
                  amount: -1.005,
                  type: 'EFTPOS',
                  merchant: { name: 'Contract Merchant' },
                  category: { name: 'Shopping' },
                },
                ...(accountId === 'malformed-transaction-date-account'
                  ? [
                      {
                        _id: 'bad-date',
                        date: 'not-a-date',
                        description: 'Malformed date',
                        amount: 1,
                      },
                    ]
                  : []),
                {
                  _id: 'akahu-old',
                  date: '2023-12-01T00:00:00.000Z',
                  description: 'Filtered transaction',
                  amount: -10,
                  type: 'EFTPOS',
                },
              ],
          cursor: { next: isSecondPage ? null : 'cursor two/+value' },
        }),
      );
      return;
    }
    if (
      request.method === 'GET' &&
      /^\/v1\/accounts\/[^/]+\/transactions\/pending$/.test(url.pathname)
    ) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          success: true,
          items: [
            {
              date: '2024-01-03T11:30:00.000Z',
              description: 'Pending description',
              amount: -2.345,
              type: 'DEBIT',
              meta: { other_account: 'Contract Other Account' },
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        success: false,
        message: `Unexpected Akahu request: ${request.method} ${request.url}`,
      }),
    );
  });
  const requested = requestedUrl ? new URL(requestedUrl) : undefined;
  server.listen(requested ? Number(requested.port) : 0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start the Akahu contract server');
  }
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  };
}

async function startCorsProxyMock(requestedUrl?: string) {
  const requests: Array<{
    method?: string;
    url?: string;
    token?: string;
    cookie?: string;
    custom?: string;
    authorization?: string;
    userAgent?: string;
    body?: string;
  }> = [];
  let allowlistMode: 'success' | 'network-error' | 'http-error' | 'invalid' =
    'success';
  const server = createHttpServer((request, response) => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      response.writeHead(500).end();
      return;
    }
    const origin = 'http://127.0.0.1:' + address.port;
    if (request.method === 'GET' && request.url === '/contract/requests') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(requests));
      return;
    }
    if (request.method === 'POST' && request.url === '/contract/reset') {
      requests.length = 0;
      allowlistMode = 'success';
      response.writeHead(204).end();
      return;
    }
    if (
      request.method === 'POST' &&
      request.url?.startsWith('/contract/allowlist/')
    ) {
      const mode = request.url.slice('/contract/allowlist/'.length);
      if (
        mode === 'success' ||
        mode === 'network-error' ||
        mode === 'http-error' ||
        mode === 'invalid'
      ) {
        allowlistMode = mode;
        response.writeHead(204).end();
      } else {
        response.writeHead(400).end();
      }
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        token: request.headers['x-actual-token'] as string | undefined,
        cookie: request.headers.cookie,
        custom: request.headers['x-contract-custom'] as string | undefined,
        authorization: request.headers.authorization,
        userAgent: request.headers['user-agent'],
        body: Buffer.concat(chunks).toString(),
      });
    });
    if (request.method === 'GET' && request.url === '/plugins.json') {
      if (allowlistMode === 'network-error') {
        request.socket.destroy();
        return;
      }
      if (allowlistMode === 'http-error') {
        response.writeHead(503).end();
        return;
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify(
            allowlistMode === 'invalid'
              ? [{ url: 'invalid-url' }]
              : [{ url: origin + '/repo' }],
          ),
        );
      return;
    }
    if (request.method === 'GET' && request.url === '/repo/data.json') {
      response
        .writeHead(201, { 'content-type': 'application/json' })
        .end(JSON.stringify({ provider: 'contract-cors-proxy' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/repo/readme.txt') {
      response
        .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        .end('contract text');
      return;
    }
    if (request.method === 'GET' && request.url === '/repo/file.bin') {
      response
        .writeHead(200, { 'content-type': 'application/octet-stream' })
        .end(Buffer.from([1, 2, 3, 4, 5]));
      return;
    }
    if (request.method === 'GET' && request.url === '/repo/invalid.json') {
      response
        .writeHead(200, { 'content-type': 'text/plain' })
        .end('not valid json');
      return;
    }
    if (request.method === 'GET' && request.url === '/repo/package.json') {
      response
        .writeHead(200, { 'content-type': 'text/plain' })
        .end(JSON.stringify({ package: true }));
      return;
    }
    if (request.method === 'GET' && request.url === '/repo/manifest') {
      response
        .writeHead(200, { 'content-type': 'text/plain' })
        .end(JSON.stringify({ manifest: true }));
      return;
    }
    if (request.method === 'GET' && request.url === '/repo/status') {
      response
        .writeHead(418, { 'content-type': 'text/plain', 'x-upstream': 'kept?' })
        .end('teapot');
      return;
    }
    if (request.method === 'GET' && request.url === '/repo/network-error') {
      request.socket.destroy();
      return;
    }
    if (request.method === 'GET' && request.url === '/repo/redirect') {
      response.writeHead(302, { location: '/repo/readme.txt' }).end();
      return;
    }
    if (request.method === 'GET' && request.url === '/repo/redirect-private') {
      response.writeHead(302, { location: 'http://127.0.0.1:1/private' }).end();
      return;
    }
    if (request.method === 'GET' && request.url === '/repo/slow') {
      setTimeout(() => {
        response
          .writeHead(200, { 'content-type': 'text/plain' })
          .end('slow response');
      }, 250);
      return;
    }
    if (request.method === 'GET' && request.url === '/repo/echo') {
      setImmediate(() => {
        const recorded = requests.at(-1);
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(recorded));
      });
      return;
    }
    if (request.method === 'HEAD' && request.url === '/repo/readme.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end();
      return;
    }
    response.writeHead(404).end();
  });
  const requested = requestedUrl ? new URL(requestedUrl) : undefined;
  server.listen(requested ? Number(requested.port) : 0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start the CORS proxy contract server');
  }
  return {
    url: 'http://127.0.0.1:' + address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  };
}

async function startEnableBankingMock(requestedUrl?: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const secretKey = privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const requests: Array<{
    method?: string;
    url?: string;
    authorization?: string;
    psuIp?: string;
    psuUserAgent?: string;
    contentType?: string;
    contentLength?: string;
    rawBody: string;
    body?: unknown;
  }> = [];
  const server = createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/contract/requests') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(requests));
      return;
    }
    if (request.method === 'POST' && request.url === '/contract/reset') {
      requests.length = 0;
      response.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString();
      const body = rawBody ? JSON.parse(rawBody) : undefined;
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        psuIp: request.headers['psu-ip-address'] as string | undefined,
        psuUserAgent: request.headers['psu-user-agent'] as string | undefined,
        contentType: request.headers['content-type'],
        contentLength: request.headers['content-length'],
        rawBody,
        body,
      });
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const json = (status: number, value: unknown) =>
        response
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(value));
      const jwt = request.headers.authorization?.replace(/^Bearer /, '');
      const jwtParts = jwt?.split('.');
      const hasValidSignature =
        jwtParts?.length === 3 &&
        verify(
          'RSA-SHA256',
          Buffer.from(`${jwtParts[0]}.${jwtParts[1]}`),
          publicKey,
          Buffer.from(jwtParts[2], 'base64url'),
        );
      if (!hasValidSignature) {
        json(401, { message: 'Invalid Enable Banking credentials' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/application') {
        const header = jwt
          ? JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString())
          : {};
        if (header.kid === 'invalid-enablebanking-app') {
          json(401, { message: 'Invalid Enable Banking credentials' });
          return;
        }
        json(200, { name: 'Contract Enable Banking', status: 'active' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/aspsps') {
        json(200, [
          {
            name: 'Contract Bank',
            country: url.searchParams.get('country') ?? 'FI',
            maximum_consent_validity: 7_776_000,
          },
        ]);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/auth') {
        json(200, {
          url: 'https://contract-bank.example/authorize',
          authorization_id: 'contract-authorization',
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/sessions') {
        if ((body as { code?: string } | undefined)?.code === 'failure-code') {
          json(500, { message: 'Session failed' });
          return;
        }
        json(200, {
          session_id: 'contract-enablebanking-session',
          accounts: [
            {
              uid: 'contract-enablebanking-account',
              account_id: { iban: 'FI001234567890' },
              account_servicer: { name: 'Contract Bank' },
              name: 'Contract current account',
              currency: 'EUR',
            },
          ],
          aspsp: { name: 'Contract Bank', country: 'FI' },
        });
        return;
      }
      if (
        request.method === 'GET' &&
        /^\/accounts\/[^/]+\/balances$/.test(url.pathname)
      ) {
        const accountId = url.pathname.split('/').at(-2);
        if (accountId === 'rate-limited-account') {
          json(429, { message: 'Too many requests' });
          return;
        }
        if (accountId === 'missing-account') {
          json(404, { message: 'Account not found' });
          return;
        }
        if (accountId === 'server-error-account') {
          json(503, { message: 'Enable Banking unavailable' });
          return;
        }
        if (accountId === 'unauthorized-account') {
          json(401, { message: 'Unauthorized' });
          return;
        }
        if (accountId === 'expired-session-account') {
          json(400, { error: 'EXPIRED_SESSION', message: 'expired' });
          return;
        }
        if (accountId === 'non-json-account') {
          response
            .writeHead(502, { 'content-type': 'text/plain' })
            .end('Bad Gateway');
          return;
        }
        if (accountId === 'success-non-json-account') {
          response.writeHead(200, { 'content-type': 'text/plain' }).end('OK');
          return;
        }
        if (accountId === 'network-error-account') {
          request.socket.destroy();
          return;
        }
        if (accountId === 'timeout-account') {
          return;
        }
        if (accountId === 'malformed-balances-account') {
          json(200, { balances: {} });
          return;
        }
        if (accountId === 'empty-balances-account') {
          json(200, { balances: [] });
          return;
        }
        json(200, {
          balances: [
            {
              balance_amount: { currency: 'EUR', amount: '1234.56' },
              balance_type: 'CLAV',
              reference_date: '2026-07-31',
            },
            {
              balance_amount: { currency: 'EUR', amount: '1200.00' },
              balance_type: 'XPCD',
            },
          ],
        });
        return;
      }
      if (
        request.method === 'GET' &&
        /^\/accounts\/[^/]+\/transactions$/.test(url.pathname)
      ) {
        const accountId = url.pathname.split('/').at(-2);
        if (accountId === 'empty-balances-account') {
          json(200, { transactions: [] });
          return;
        }
        if (accountId === 'malformed-transactions-account') {
          json(200, { transactions: {} });
          return;
        }
        if (accountId === 'empty-continuation-account') {
          json(200, { transactions: [], continuation_key: '' });
          return;
        }
        if (!url.searchParams.has('continuation_key')) {
          json(200, {
            transactions: [
              {
                entry_reference: 'enable-booked',
                transaction_amount: { currency: 'EUR', amount: '100.50' },
                credit_debit_indicator: 'CRDT',
                debtor: { name: 'Contract Employer' },
                status: 'BOOK',
                booking_date: '2026-07-30',
                value_date: '2026-07-30',
                remittance_information: ['EREF+salary', 'July'],
              },
            ],
            continuation_key: 'contract-page-2',
          });
          return;
        }
        json(200, {
          transactions: [
            {
              transaction_id: 'enable-pending',
              transaction_amount: { currency: 'EUR', amount: '25.99' },
              credit_debit_indicator: 'DBIT',
              creditor: { name: 'Contract Shop' },
              status: 'PDNG',
              transaction_date: '2026-07-31',
            },
            {
              transaction_id: 'enable-invalid',
              transaction_amount: { currency: 'EUR', amount: '5.00' },
              status: 'PDNG',
            },
          ],
        });
        return;
      }
      json(404, {
        message: `Unexpected Enable Banking request: ${request.method} ${request.url}`,
      });
    });
  });
  const requested = requestedUrl ? new URL(requestedUrl) : undefined;
  server.listen(requested ? Number(requested.port) : 0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start the Enable Banking contract server');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    secretKey,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  };
}

async function startGoCardlessMock(requestedUrl?: string) {
  const requests: Array<{
    method?: string;
    url?: string;
    authorization?: string;
    body?: unknown;
  }> = [];
  const accessPayload = Buffer.from(
    JSON.stringify({ exp: 4_102_444_800 }),
  ).toString('base64url');
  const accessToken = `contract.${accessPayload}.signature`;
  const pendingConcurrentInstitutions: Array<() => void> = [];
  const server = createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/contract/requests') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(requests));
      return;
    }
    if (request.method === 'POST' && request.url === '/contract/reset') {
      requests.length = 0;
      pendingConcurrentInstitutions.length = 0;
      response.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString();
      const body = rawBody ? JSON.parse(rawBody) : undefined;
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const json = (status: number, value: unknown) =>
        response
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(value));
      if (request.method === 'POST' && url.pathname === '/api/v2/token/new/') {
        const credentials = body as { secret_id?: string } | undefined;
        if (credentials?.secret_id === 'contract-invalid-secret-id') {
          json(400, {
            summary: 'Invalid credentials',
            detail: 'Unknown secret id or key',
          });
          return;
        }
        if (credentials?.secret_id === 'contract-expired-secret-id') {
          const expiredPayload = Buffer.from(
            JSON.stringify({ exp: 1 }),
          ).toString('base64url');
          json(200, {
            access: `contract-expired.${expiredPayload}.signature`,
            refresh: 'contract-expired-refresh',
            access_expires: 0,
            refresh_expires: 0,
          });
          return;
        }
        json(200, {
          access: accessToken,
          refresh: 'contract-refresh-token',
          access_expires: 86_400,
          refresh_expires: 2_592_000,
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v2/institutions/'
      ) {
        json(200, [
          {
            id: 'CONTRACT_BANK',
            name: 'Contract Bank',
            bic: 'CONTRACTBIC',
            transaction_total_days: '730',
            max_access_valid_for_days: '90',
            countries: [url.searchParams.get('country') ?? 'FI'],
            supported_features: ['account_selection'],
          },
        ]);
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v2/institutions/CONTRACT_BANK/'
      ) {
        json(200, {
          id: 'CONTRACT_BANK',
          name: 'Contract Bank',
          transaction_total_days: '730',
          max_access_valid_for_days: '90',
          supported_features: ['account_selection'],
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v2/institutions/CONTRACT_BANK_STRICT/'
      ) {
        json(200, {
          id: 'CONTRACT_BANK_STRICT',
          name: 'Contract Strict Bank',
          transaction_total_days: '400',
          max_access_valid_for_days: '60',
          supported_features: [],
        });
        return;
      }
      const numberCoercionInstitution =
        /^\/api\/v2\/institutions\/CONTRACT_NUMBER_(WHITESPACE|FRACTION|EXPONENT|HEX|BIGHEX|UNEVENBIGHEX|EMPTY)\/$/.exec(
          url.pathname,
        );
      if (request.method === 'GET' && numberCoercionInstitution) {
        const values = {
          WHITESPACE: '  ',
          FRACTION: '1.5',
          EXPONENT: '1e2',
          HEX: '0x10',
          BIGHEX: '0x10000000000000000',
          UNEVENBIGHEX: '0x24ded6a2c8489d3',
          EMPTY: '',
        } as const;
        const value =
          values[numberCoercionInstitution[1] as keyof typeof values];
        json(200, {
          id: `CONTRACT_NUMBER_${numberCoercionInstitution[1]}`,
          name: 'Contract Number Coercion Bank',
          transaction_total_days: value,
          max_access_valid_for_days: value,
          supported_features: [],
        });
        return;
      }
      if (
        request.method === 'GET' &&
        /^\/api\/v2\/institutions\/CONTRACT_CONCURRENT_[AB]\/$/.test(
          url.pathname,
        )
      ) {
        const institutionId = url.pathname.split('/').at(-2);
        pendingConcurrentInstitutions.push(() =>
          json(200, {
            id: institutionId,
            name: `Concurrent Bank ${institutionId?.at(-1)}`,
            transaction_total_days: '90',
            max_access_valid_for_days: '90',
            supported_features: [],
          }),
        );
        if (pendingConcurrentInstitutions.length === 2) {
          pendingConcurrentInstitutions.splice(0).forEach(send => send());
        }
        return;
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/api/v2/agreements/enduser/'
      ) {
        const agreement = body as
          | {
              institution_id?: string;
              max_historical_days?: number;
              access_valid_for_days?: number;
            }
          | undefined;
        if (
          agreement?.institution_id === 'CONTRACT_BANK_STRICT' &&
          (agreement.max_historical_days !== 89 ||
            agreement.access_valid_for_days !== 90)
        ) {
          json(400, {
            summary: 'Invalid agreement',
            detail: 'Institution rejects these limits',
          });
          return;
        }
        json(200, {
          id: 'contract-agreement',
          created: '2026-08-01T00:00:00Z',
          max_historical_days: agreement?.max_historical_days ?? 730,
          access_valid_for_days: agreement?.access_valid_for_days ?? 90,
          access_scope: ['balances', 'details', 'transactions'],
          accepted: null,
          institution_id: agreement?.institution_id ?? 'CONTRACT_BANK',
        });
        return;
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/api/v2/requisitions/'
      ) {
        const strict =
          (body as { institution_id?: string })?.institution_id ===
          'CONTRACT_BANK_STRICT';
        json(200, {
          id: strict ? 'contract-strict-requisition' : 'contract-requisition',
          created: '2026-08-01T00:00:00Z',
          redirect: (body as { redirect?: string })?.redirect,
          status: 'CR',
          institution_id:
            (body as { institution_id?: string })?.institution_id ??
            'CONTRACT_BANK',
          agreement: 'contract-agreement',
          reference: (body as { reference?: string })?.reference,
          accounts: [],
          user_language: 'en',
          link: strict
            ? 'https://strict-bank.example/authorize'
            : 'https://contract-bank.example/authorize',
          ssn: null,
          account_selection: true,
          redirect_immediate: false,
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v2/requisitions/contract-pending-requisition/'
      ) {
        json(200, {
          id: 'contract-pending-requisition',
          status: 'CR',
          institution_id: 'CONTRACT_BANK',
          agreement: 'contract-agreement',
          accounts: [],
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v2/requisitions/contract-errors-requisition/'
      ) {
        json(200, {
          id: 'contract-errors-requisition',
          status: 'LN',
          institution_id: 'CONTRACT_BANK',
          agreement: 'contract-agreement',
          accounts: [
            'contract-eua-account',
            'contract-ratelimit-account',
            'contract-unknown-account',
            'contract-unmapped-account',
            'contract-invalid-token-account',
          ],
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v2/requisitions/contract-multi-requisition/'
      ) {
        json(200, {
          id: 'contract-multi-requisition',
          status: 'LN',
          institution_id: 'CONTRACT_BANK',
          agreement: 'contract-agreement',
          accounts: ['contract-gocardless-account', 'contract-second-account'],
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v2/requisitions/contract-concurrent-requisition/'
      ) {
        json(200, {
          id: 'contract-concurrent-requisition',
          status: 'LN',
          institution_id: 'CONTRACT_CONCURRENT_A',
          agreement: 'contract-agreement',
          accounts: ['contract-concurrent-a', 'contract-concurrent-b'],
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname ===
          '/api/v2/requisitions/contract-balance-failure-requisition/'
      ) {
        json(200, {
          id: 'contract-balance-failure-requisition',
          status: 'LN',
          institution_id: 'CONTRACT_BANK',
          agreement: 'contract-agreement',
          accounts: ['contract-balance-failure-account'],
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v2/requisitions/contract-requisition/'
      ) {
        json(200, {
          id: 'contract-requisition',
          status: 'LN',
          institution_id: 'CONTRACT_BANK',
          agreement: 'contract-agreement',
          accounts: ['contract-gocardless-account'],
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v2/requisitions/contract-delete-rejected/'
      ) {
        json(200, {
          id: 'contract-delete-rejected',
          status: 'LN',
          institution_id: 'CONTRACT_BANK',
          agreement: 'contract-agreement',
          accounts: [],
        });
        return;
      }
      if (
        request.method === 'DELETE' &&
        url.pathname === '/api/v2/requisitions/contract-requisition/'
      ) {
        json(200, {
          summary: 'Requisition deleted',
          detail: 'Contract requisition deleted',
        });
        return;
      }
      if (
        request.method === 'DELETE' &&
        url.pathname === '/api/v2/requisitions/contract-delete-rejected/'
      ) {
        json(200, {
          summary: 'Requisition is still linked',
          detail: 'Contract deletion was rejected',
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v2/accounts/contract-gocardless-account/'
      ) {
        json(200, {
          id: 'contract-gocardless-account',
          created: '2026-08-01T00:00:00Z',
          last_accessed: '2026-08-01T00:00:00Z',
          iban: 'FI001234567890',
          institution_id: 'CONTRACT_BANK',
          status: 'READY',
          owner_name: 'Contract Owner',
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v2/accounts/contract-gocardless-account/details/'
      ) {
        json(200, {
          account: {
            id: 'contract-gocardless-account',
            institution_id: 'CONTRACT_BANK',
            iban: 'FI001234567890',
            name: 'Contract checking',
            product: 'Current account',
            currency: 'EUR',
          },
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v2/accounts/contract-second-account/'
      ) {
        json(200, {
          id: 'contract-second-account',
          created: '2026-08-01T00:00:00Z',
          last_accessed: '2026-08-01T00:00:00Z',
          iban: 'FI009999999999',
          institution_id: 'CONTRACT_BANK',
          status: 'READY',
          owner_name: 'Contract Owner',
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v2/accounts/contract-second-account/details/'
      ) {
        json(200, {
          account: {
            id: 'contract-second-account',
            institution_id: 'CONTRACT_BANK',
            iban: 'FI009999999999',
            name: 'Contract savings',
            product: 'Savings account',
            currency: 'EUR',
          },
        });
        return;
      }
      const concurrentAccount = url.pathname.match(
        /^\/api\/v2\/accounts\/contract-concurrent-([ab])\/(details\/)?$/,
      );
      if (request.method === 'GET' && concurrentAccount) {
        const suffix = concurrentAccount[1].toUpperCase();
        const account = {
          id: `contract-concurrent-${concurrentAccount[1]}`,
          institution_id: `CONTRACT_CONCURRENT_${suffix}`,
          iban: `FI00CONCURRENT${suffix}`,
          name: `Concurrent ${suffix}`,
          product: 'Current account',
          currency: 'EUR',
        };
        json(200, concurrentAccount[2] ? { account } : account);
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v2/accounts/contract-eua-account/transactions/'
      ) {
        json(401, {
          summary: 'End User Agreement has expired',
          detail: 'The EUA for this requisition has expired',
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname ===
          '/api/v2/accounts/contract-invalid-token-account/transactions/'
      ) {
        json(401, {
          summary: 'Unauthorized',
          detail: 'Authentication credentials were not provided',
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname ===
          '/api/v2/accounts/contract-ratelimit-account/transactions/'
      ) {
        response
          .writeHead(429, {
            'content-type': 'application/json',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '100',
          })
          .end(
            JSON.stringify({
              summary: 'Rate limit exceeded',
              detail: 'Daily request limit reached',
            }),
          );
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname ===
          '/api/v2/accounts/contract-unknown-account/transactions/'
      ) {
        json(500, {
          summary: 'Institution error',
          detail: 'The institution returned an error',
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname ===
          '/api/v2/accounts/contract-unmapped-account/transactions/'
      ) {
        json(502, {
          summary: 'Bad gateway',
          detail: 'Upstream gateway failure',
        });
        return;
      }
      if (
        request.method === 'GET' &&
        /^\/api\/v2\/accounts\/contract-(eua|ratelimit|unknown|unmapped|invalid-token)-account\/balances\/$/.test(
          url.pathname,
        )
      ) {
        json(200, { balances: [] });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname ===
          '/api/v2/accounts/contract-gocardless-account/balances/'
      ) {
        json(200, {
          balances: [
            {
              balanceAmount: { amount: '1000.00', currency: 'EUR' },
              balanceType: 'closingBooked',
              referenceDate: '2026-07-31',
            },
          ],
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname ===
          '/api/v2/accounts/contract-balance-failure-account/balances/'
      ) {
        json(500, {
          summary: 'Balance failure',
          detail: 'Balance fixture fails before transactions complete',
        });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname ===
          '/api/v2/accounts/contract-balance-failure-account/transactions/'
      ) {
        setTimeout(() => {
          requests.push({
            method: 'EVENT',
            url: '/contract/events/balance-failure-transactions-complete',
          });
          json(200, { transactions: { booked: [], pending: [] } });
        }, 75);
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname ===
          '/api/v2/accounts/contract-gocardless-account/transactions/'
      ) {
        json(200, {
          transactions: {
            booked: [
              {
                transactionId: 'gocardless-booked',
                transactionAmount: { amount: '-10.00', currency: 'EUR' },
                bookingDate: '2026-07-30',
                creditorName: 'Contract Grocery',
                remittanceInformationUnstructured: 'Weekly shop',
              },
            ],
            pending: [
              {
                transactionId: 'gocardless-pending',
                transactionAmount: { amount: '-5.00', currency: 'EUR' },
                valueDate: '2026-07-31',
                creditorName: 'Contract Fuel',
              },
            ],
          },
        });
        return;
      }
      json(404, {
        summary: `Unexpected GoCardless request: ${request.method} ${request.url}`,
      });
    });
  });
  const requested = requestedUrl ? new URL(requestedUrl) : undefined;
  server.listen(requested ? Number(requested.port) : 0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start the GoCardless contract server');
  }
  return {
    url: `http://127.0.0.1:${address.port}/api/v2`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  };
}

export async function setup({ provide }: TestProject) {
  const externalUrl = process.env.ACTUAL_CONTRACT_SERVER_URL;
  const variant = process.env.ACTUAL_CONTRACT_VARIANT;
  if (externalUrl) {
    assertLoopback(externalUrl);
  }

  const simpleFinMock = await startSimpleFinMock();
  const pluggyMock = await startPluggyMock(
    process.env.ACTUAL_CONTRACT_PLUGGY_URL,
  );
  const akahuMock = await startAkahuMock(process.env.ACTUAL_CONTRACT_AKAHU_URL);
  const corsProxyMock = await startCorsProxyMock(
    process.env.ACTUAL_CONTRACT_CORS_URL,
  );
  const enableBankingMock = await startEnableBankingMock(
    process.env.ACTUAL_CONTRACT_ENABLEBANKING_URL,
  );
  const goCardlessMock = await startGoCardlessMock(
    process.env.ACTUAL_CONTRACT_GOCARDLESS_URL,
  );
  provide('simpleFinMockUrl', simpleFinMock.url);
  provide('openIdMockUrl', simpleFinMock.url);
  provide('pluggyMockUrl', pluggyMock.url);
  provide('akahuMockUrl', akahuMock.url);
  provide('corsProxyMockUrl', corsProxyMock.url);
  provide('enableBankingMockUrl', enableBankingMock.url);
  provide('enableBankingSecretKey', enableBankingMock.secretKey);
  provide('goCardlessMockUrl', goCardlessMock.url);

  if (externalUrl) {
    provide('contractServerUrl', externalUrl.replace(/\/$/, ''));
    return async () => {
      await Promise.all([
        simpleFinMock.close(),
        pluggyMock.close(),
        akahuMock.close(),
        corsProxyMock.close(),
        enableBankingMock.close(),
        goCardlessMock.close(),
      ]);
    };
  }

  const root = await mkdtemp(join(tmpdir(), 'actual-contract-'));
  const data = join(root, 'data');
  const web = join(root, 'web');
  await Promise.all([mkdir(data), mkdir(web)]);
  await writeFile(join(web, 'index.html'), '<!doctype html>contract frontend');

  const port = await getAvailablePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['build/app.js'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ACTUAL_PORT: String(port),
      ACTUAL_HOSTNAME: '127.0.0.1',
      ACTUAL_DATA_DIR: data,
      ACTUAL_SERVER_FILES: join(data, 'server-files'),
      ACTUAL_USER_FILES: join(data, 'user-files'),
      ACTUAL_WEB_ROOT: web,
      PLUGGY_API_URL: pluggyMock.url,
      AKAHU_API_URL: akahuMock.url,
      CORS_PROXY_ALLOWLIST_URL: corsProxyMock.url + '/plugins.json',
      CORS_PROXY_TEST_ALLOWED_ORIGIN: corsProxyMock.url,
      ENABLEBANKING_API_URL: enableBankingMock.url,
      ...(variant === 'enablebanking'
        ? { ENABLEBANKING_POLL_TIMEOUT_MS: '150' }
        : {}),
      GOCARDLESS_API_URL: goCardlessMock.url,
      ...(variant === 'header'
        ? {
            ACTUAL_LOGIN_METHOD: 'header',
            ACTUAL_TRUSTED_AUTH_PROXIES: '127.0.0.1/32',
          }
        : {}),
      ...(variant === 'cors-proxy'
        ? {
            ACTUAL_CORS_PROXY_ENABLED: 'true',
            ACTUAL_TRUSTED_PROXIES: '127.0.0.1/32,::1/128',
          }
        : {}),
    },
    stdio: 'inherit',
  });

  try {
    await waitUntilHealthy(url, child);
  } catch (error) {
    child.kill();
    await simpleFinMock.close();
    await pluggyMock.close();
    await akahuMock.close();
    await corsProxyMock.close();
    await enableBankingMock.close();
    await goCardlessMock.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  provide('contractServerUrl', url);
  return async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await simpleFinMock.close();
    await pluggyMock.close();
    await akahuMock.close();
    await corsProxyMock.close();
    await enableBankingMock.close();
    await goCardlessMock.close();
    await rm(root, { recursive: true, force: true });
  };
}
