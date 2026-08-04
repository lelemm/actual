import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const server = createHttpServer((request, response) => {
    if (request.method === 'POST' && request.url === '/claim') {
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
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start the SimpleFIN contract server');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  };
}

async function startPluggyMock(requestedUrl?: string) {
  const requests: Array<{
    method?: string;
    url?: string;
    apiKey?: string;
    contentType?: string;
    body: string;
  }> = [];
  const server = createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/contract/requests') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(requests));
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
        body,
      });
      if (request.method === 'POST' && request.url === '/auth') {
        const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
          'base64url',
        );
        const payload = Buffer.from(
          JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600 }),
        ).toString('base64url');
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ apiKey: `${header}.${payload}.signature` }));
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
  }> = [];
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
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      appToken: request.headers['x-akahu-id'] as string | undefined,
      sdk: request.headers['x-akahu-sdk'] as string | undefined,
      idempotencyKey: request.headers['idempotency-key'] as string | undefined,
    });
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/accounts') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ success: true, items: [account] }));
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
      url.pathname === '/v1/accounts/acc-contract/transactions'
    ) {
      const isSecondPage = url.searchParams.get('cursor') === 'cursor-two';
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
                {
                  _id: 'akahu-old',
                  date: '2023-12-01T00:00:00.000Z',
                  description: 'Filtered transaction',
                  amount: -10,
                  type: 'EFTPOS',
                },
              ],
          cursor: { next: isSecondPage ? null : 'cursor-two' },
        }),
      );
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/v1/accounts/acc-contract/transactions/pending'
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
  }> = [];
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
    requests.push({
      method: request.method,
      url: request.url,
      token: request.headers['x-actual-token'] as string | undefined,
      cookie: request.headers.cookie,
      custom: request.headers['x-contract-custom'] as string | undefined,
    });
    if (request.method === 'GET' && request.url === '/plugins.json') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify([{ url: origin + '/repo' }]));
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
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const secretKey = privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const requests: Array<{
    method?: string;
    url?: string;
    authorization?: string;
    psuIp?: string;
    psuUserAgent?: string;
    body?: unknown;
  }> = [];
  const server = createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/contract/requests') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(requests));
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
        body,
      });
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const json = (status: number, value: unknown) =>
        response
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(value));
      if (request.method === 'GET' && url.pathname === '/application') {
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
        url.pathname === '/accounts/contract-enablebanking-account/balances'
      ) {
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
        url.pathname === '/accounts/contract-enablebanking-account/transactions'
      ) {
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
  const server = createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/contract/requests') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(requests));
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
        request.method === 'POST' &&
        url.pathname === '/api/v2/agreements/enduser/'
      ) {
        json(200, {
          id: 'contract-agreement',
          created: '2026-08-01T00:00:00Z',
          max_historical_days: 730,
          access_valid_for_days: 90,
          access_scope: ['balances', 'details', 'transactions'],
          accepted: null,
          institution_id: 'CONTRACT_BANK',
        });
        return;
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/api/v2/requisitions/'
      ) {
        json(200, {
          id: 'contract-requisition',
          created: '2026-08-01T00:00:00Z',
          redirect: (body as { redirect?: string })?.redirect,
          status: 'CR',
          institution_id: 'CONTRACT_BANK',
          agreement: 'contract-agreement',
          reference: (body as { reference?: string })?.reference,
          accounts: [],
          user_language: 'en',
          link: 'https://contract-bank.example/authorize',
          ssn: null,
          account_selection: true,
          redirect_immediate: false,
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
