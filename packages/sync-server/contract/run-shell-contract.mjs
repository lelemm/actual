import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { get as httpsGet } from 'node:https';
import {
  connect as connectTcp,
  createServer as createNetServer,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const implementation = process.argv[2];
assert.ok(
  implementation === 'node' || implementation === 'rust',
  'Usage: node contract/run-shell-contract.mjs <node|rust>',
);

const packageRoot = resolve(fileURLToPath(import.meta.url), '../..');
const frontendCsp =
  "default-src 'self' blob:; img-src 'self' blob: data:; script-src 'self' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src http: https:";
const developmentCsp =
  "default-src 'self' blob:; img-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws: wss: http: https:";

function serverCommand() {
  return implementation === 'node'
    ? [process.execPath, ['build/app.js']]
    : [join(packageRoot, 'target/debug/actual-server'), []];
}

async function availablePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function requestHttps(url) {
  return new Promise((resolve, reject) => {
    httpsGet(url, { rejectUnauthorized: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    }).on('error', reject);
  });
}

async function waitUntilHealthy(url, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited with code ${child.exitCode}`);
    }
    try {
      const response = url.startsWith('https:')
        ? await requestHttps(`${url}/health`)
        : await fetch(`${url}/health`);
      if (response.status === 200) return;
    } catch {
      // The server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become healthy within 120 seconds');
}

async function startServer(environment, extraEnv = {}, options = {}) {
  const ownsRoot = !options.root;
  const root =
    options.root ??
    (await mkdtemp(join(tmpdir(), `actual-shell-${implementation}-`)));
  const data = join(root, 'data');
  const web = join(root, 'web');
  await Promise.all([
    mkdir(data, { recursive: true }),
    mkdir(web, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(web, 'index.html'), '<!doctype html>shell contract'),
    writeFile(join(web, 'asset.txt'), 'static asset'),
  ]);
  const port = await availablePort();
  const configPath = join(root, 'config.json');
  const config =
    typeof options.config === 'function'
      ? options.config({ root, data, web, port })
      : options.config;
  if (config) await writeFile(configPath, JSON.stringify(config));
  const command = serverCommand();
  const env = {
    ...process.env,
    NODE_ENV: environment,
    ACTUAL_CONFIG_PATH: config ? configPath : join(root, 'missing-config.json'),
    ACTUAL_PORT: String(port),
    ACTUAL_HOSTNAME: '127.0.0.1',
    ACTUAL_DATA_DIR: data,
    ACTUAL_SERVER_FILES: join(data, 'server-files'),
    ACTUAL_USER_FILES: join(data, 'user-files'),
    ACTUAL_WEB_ROOT: web,
    ACTUAL_HTTPS_KEY: '',
    ACTUAL_HTTPS_CERT: '',
    ...extraEnv,
  };
  if (options.configPaths) {
    delete env.ACTUAL_SERVER_FILES;
    delete env.ACTUAL_USER_FILES;
    delete env.ACTUAL_WEB_ROOT;
  }
  let stdout = '';
  const child = spawn(command[0], command[1], {
    cwd: packageRoot,
    env,
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  const protocol = extraEnv.ACTUAL_HTTPS_KEY ? 'https' : 'http';
  const url = `${protocol}://127.0.0.1:${port}`;
  try {
    await waitUntilHealthy(url, child);
    assert.match(
      stdout,
      new RegExp(`Listening on 127\\.0\\.0\\.1:${port}\\.\\.\\.`),
    );
  } catch (error) {
    child.kill();
    if (ownsRoot) await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    url,
    root,
    output: () => stdout,
    async close() {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit');
      }
      if (ownsRoot) await rm(root, { recursive: true, force: true });
    },
  };
}

function assertFrontendHeaders(headers, csp) {
  assert.equal(headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(headers.get('content-security-policy'), csp);
}

async function productionContract() {
  const server = await startServer('production');
  try {
    const asset = await fetch(`${server.url}/asset.txt`);
    assert.equal(asset.status, 200);
    assert.equal(
      asset.headers.get('content-type'),
      'text/plain; charset=utf-8',
    );
    assert.equal(await asset.text(), 'static asset');
    assertFrontendHeaders(asset.headers, frontendCsp);

    const fallback = await fetch(`${server.url}/missing/route?query=kept`);
    assert.equal(fallback.status, 200);
    assert.equal(
      fallback.headers.get('content-type'),
      'text/html; charset=utf-8',
    );
    assert.equal(await fallback.text(), '<!doctype html>shell contract');
    assertFrontendHeaders(fallback.headers, frontendCsp);

    const metrics = await fetch(`${server.url}/metrics`);
    const metricBody = await metrics.json();
    assert.ok(
      Object.values(metricBody.mem).every(value => value > 0),
      'every memory metric must report live data',
    );
    assert.ok(metricBody.uptime > 0);

    const megabyte = 1024 * 1024;
    const compressedBoundary = gzipSync(
      JSON.stringify({ x: 'x'.repeat(20 * megabyte - 8) }),
    );
    const compressedBomb = gzipSync(
      JSON.stringify({ x: 'x'.repeat(20 * megabyte - 7) }),
    );
    assert.ok(compressedBomb.byteLength < 32 * 1024);
    const boundary = await fetch(`${server.url}/contract/compressed-boundary`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: compressedBoundary,
    });
    assert.equal(boundary.status, 404);
    const bomb = await fetch(`${server.url}/contract/compressed-bomb`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: compressedBomb,
    });
    assert.equal(bomb.status, 413);

    const nonGet = await fetch(`${server.url}/asset.txt`, { method: 'POST' });
    assert.equal(nonGet.status, 404);
    assert.equal(
      nonGet.headers.get('content-type'),
      'text/html; charset=utf-8',
    );
    assert.equal(
      nonGet.headers.get('content-security-policy'),
      "default-src 'none'",
    );
    assert.match(await nonGet.text(), /Cannot POST \/asset\.txt/);
  } finally {
    await server.close();
  }
}

function websocketAccept(key) {
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

async function startDevelopmentUpstream() {
  const requests = [];
  const upgrades = [];
  const sockets = new Set();
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        host: request.headers.host,
        marker: request.headers['x-shell-contract'],
        body: Buffer.concat(chunks).toString(),
      });
      response
        .writeHead(201, {
          'content-type': 'text/plain',
          'x-upstream-response': 'proxied',
        })
        .end('development upstream');
    });
  });
  server.on('upgrade', (request, socket, head) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    upgrades.push({
      url: request.url,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      origin: request.headers.origin,
      protocol: request.headers['sec-websocket-protocol'],
    });
    if (request.url === '/hmr-reject') {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nContent-Length: 8\r\nX-Upstream-Rejection: preserved\r\nConnection: close\r\n\r\nrejected',
      );
      return;
    }
    const key = request.headers['sec-websocket-key'];
    assert.equal(typeof key, 'string');
    const protocol = request.headers['sec-websocket-protocol'];
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${websocketAccept(key)}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''}\r\n`,
    );
    if (request.url !== '/hmr?contract=yes') return;
    const echo = frame => {
      assert.ok(frame.length > 0, 'proxy must forward the WebSocket frame');
      const message = Buffer.from('echo:shell-contract');
      socket.write(
        Buffer.concat([Buffer.from([0x81, message.length]), message]),
      );
    };
    if (head.length) echo(head);
    else socket.once('data', echo);
  });
  server.listen(3001, '127.0.0.1');
  await once(server, 'listening');
  return {
    requests,
    upgrades,
    close: () => {
      sockets.forEach(socket => socket.destroy());
      return new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function rawWebSocketUpgrade(serverUrl, path, headers = {}) {
  const url = new URL(serverUrl);
  const socket = connectTcp(Number(url.port), url.hostname);
  await once(socket, 'connect');
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: ${url.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: c2hlbGwtY29udHJhY3QhIQ==',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '',
      '',
    ].join('\r\n'),
  );
  let response = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('WebSocket upgrade timed out')),
      5_000,
    );
    socket.on('data', chunk => {
      response += chunk;
      if (
        response.startsWith('HTTP/1.1 101') ||
        response.includes('\r\n\r\nrejected')
      ) {
        clearTimeout(timeout);
        resolve();
      }
    });
    socket.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  socket.destroy();
  return response;
}

async function websocketEcho(serverUrl) {
  const url = new URL('/hmr?contract=yes', serverUrl);
  url.protocol = 'ws:';
  const websocket = new WebSocket(url);
  await once(websocket, 'open');
  websocket.send('shell-contract');
  try {
    const event = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('WebSocket echo timed out')),
        5_000,
      );
      websocket.addEventListener('message', event => {
        clearTimeout(timeout);
        resolve(event);
      });
      websocket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket proxy failed'));
      });
      websocket.addEventListener('close', () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket proxy closed before echo'));
      });
    });
    assert.equal(event.data, 'echo:shell-contract');
  } finally {
    websocket.close();
  }
}

async function developmentContract() {
  const upstream = await startDevelopmentUpstream();
  const server = await startServer('development');
  try {
    const response = await fetch(`${server.url}/dev/path?value=1`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-shell-contract': 'forwarded',
      },
      body: 'proxy body',
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('content-type'), 'text/plain');
    assert.equal(response.headers.get('x-upstream-response'), 'proxied');
    assert.equal(await response.text(), 'development upstream');
    assertFrontendHeaders(response.headers, developmentCsp);
    assert.deepEqual(upstream.requests, [
      {
        method: 'POST',
        url: '/dev/path?value=1',
        host: 'localhost:3001',
        marker: 'forwarded',
        body: 'proxy body',
      },
    ]);
    await websocketEcho(server.url);

    const acceptedUpgrade = await rawWebSocketUpgrade(
      server.url,
      '/hmr-headers',
      {
        Cookie: 'actual-session=contract',
        Authorization: 'Bearer shell-contract',
        Origin: 'https://actual.example',
        'Sec-WebSocket-Protocol': 'actual-v1',
      },
    );
    assert.match(acceptedUpgrade, /^HTTP\/1\.1 101 /);
    assert.match(acceptedUpgrade, /Sec-WebSocket-Protocol: actual-v1/i);

    const rejectedUpgrade = await rawWebSocketUpgrade(
      server.url,
      '/hmr-reject',
    );
    assert.match(rejectedUpgrade, /^HTTP\/1\.1 401 /);
    assert.match(rejectedUpgrade, /X-Upstream-Rejection: preserved/i);
    assert.match(rejectedUpgrade, /\r\n\r\nrejected$/);
    assert.deepEqual(upstream.upgrades, [
      {
        url: '/hmr?contract=yes',
        cookie: undefined,
        authorization: undefined,
        origin: undefined,
        protocol: undefined,
      },
      {
        url: '/hmr-headers',
        cookie: 'actual-session=contract',
        authorization: 'Bearer shell-contract',
        origin: 'https://actual.example',
        protocol: 'actual-v1',
      },
      {
        url: '/hmr-reject',
        cookie: undefined,
        authorization: undefined,
        origin: undefined,
        protocol: undefined,
      },
    ]);
  } finally {
    await server.close();
    await upstream.close();
  }
}

async function tlsContract() {
  const fixtureRoot = join(packageRoot, 'rust/util');
  const root = await mkdtemp(join(tmpdir(), 'actual-shell-tls-material-'));
  const key = join(root, 'server-key.pem');
  const cert = join(root, 'server-cert.pem');
  await Promise.all([
    writeFile(
      key,
      await readFile(join(fixtureRoot, 'http-test-server-key.txt')),
    ),
    writeFile(
      cert,
      await readFile(join(fixtureRoot, 'http-test-server-cert.txt')),
    ),
  ]);
  let fileServer;
  let inlineServer;
  try {
    fileServer = await startServer('production', {
      ACTUAL_HTTPS_KEY: key,
      ACTUAL_HTTPS_CERT: cert,
    });
    const fileHealth = await requestHttps(`${fileServer.url}/health`);
    assert.equal(fileHealth.status, 200);
    assert.equal(
      fileHealth.headers['content-type'],
      'application/json; charset=utf-8',
    );
    assert.equal(fileHealth.body, '{"status":"UP"}');
    await fileServer.close();
    fileServer = undefined;

    inlineServer = await startServer('production', {
      ACTUAL_HTTPS_KEY: await readFile(key, 'utf8'),
      ACTUAL_HTTPS_CERT: await readFile(cert, 'utf8'),
    });
    const inlineHealth = await requestHttps(`${inlineServer.url}/health`);
    assert.equal(inlineHealth.status, 200);
    assert.equal(
      inlineHealth.headers['content-type'],
      'application/json; charset=utf-8',
    );
    assert.equal(inlineHealth.body, '{"status":"UP"}');
  } finally {
    await fileServer?.close();
    await inlineServer?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function configAndPersistenceContract() {
  const root = await mkdtemp(
    join(tmpdir(), `actual-shell-config-${implementation}-`),
  );
  const config = ({ root, web }) => ({
    mode: 'test',
    port: 1,
    hostname: '192.0.2.1',
    serverFiles: join(root, 'persistent-server-files'),
    userFiles: join(root, 'persistent-user-files'),
    webRoot: web,
  });
  let server;
  try {
    server = await startServer(
      'production',
      {},
      {
        root,
        config,
        configPaths: true,
      },
    );
    const mode = await fetch(`${server.url}/mode`);
    assert.equal(mode.status, 200);
    assert.equal(await mode.text(), 'test');
    const frontend = await fetch(`${server.url}/configured/frontend`);
    assert.equal(await frontend.text(), '<!doctype html>shell contract');

    const bootstrap = await fetch(`${server.url}/account/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'contract-password' }),
    });
    assert.equal(bootstrap.status, 200);
    assert.equal((await bootstrap.json()).status, 'ok');
    await server.close();

    server = await startServer(
      'production',
      {},
      {
        root,
        config,
        configPaths: true,
      },
    );
    const persisted = await fetch(`${server.url}/account/needs-bootstrap`);
    assert.equal(persisted.status, 200);
    assert.deepEqual(await persisted.json(), {
      status: 'ok',
      data: {
        bootstrapped: true,
        loginMethod: 'password',
        availableLoginMethods: [
          { method: 'password', active: 1, displayName: 'Password' },
        ],
        multiuser: false,
      },
    });
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function startupOpenIdContract() {
  const server = await startServer(
    'production',
    {},
    {
      config: ({ port }) => ({
        openId: {
          discoveryURL: '',
          issuer: {
            name: 'https://issuer.example',
            authorization_endpoint: 'https://issuer.example/authorize',
            token_endpoint: 'https://issuer.example/token',
            userinfo_endpoint: 'https://issuer.example/userinfo',
          },
          client_id: 'shell-contract-client',
          client_secret: 'shell-contract-secret',
          server_hostname: `http://127.0.0.1:${port}`,
          authMethod: 'openid',
        },
      }),
    },
  );
  try {
    assert.match(server.output(), /OpenID configured!/);
    const response = await fetch(`${server.url}/account/needs-bootstrap`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ok',
      data: {
        bootstrapped: true,
        loginMethod: 'openid',
        availableLoginMethods: [
          { method: 'openid', active: 1, displayName: 'OpenID' },
        ],
        multiuser: true,
      },
    });
  } finally {
    await server.close();
  }
}

async function startOpenIdDiscoveryMock() {
  const requests = [];
  const server = createHttpServer((request, response) => {
    requests.push(request.url);
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const issuer = `http://127.0.0.1:${address.port}`;
    if (request.url === '/.well-known/openid-configuration') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
          claims_supported: ['sub', 'preferred_username'],
        }),
      );
      return;
    }
    if (request.url === '/jwks') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end('{"keys":[]}');
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  };
}

async function discoveryOpenIdRestartContract() {
  const provider = await startOpenIdDiscoveryMock();
  const root = await mkdtemp(
    join(tmpdir(), `actual-shell-discovery-${implementation}-`),
  );
  const config = ({ root, web, port }) => ({
    serverFiles: join(root, 'server-files'),
    userFiles: join(root, 'user-files'),
    webRoot: web,
    openId: {
      discoveryURL: `${provider.url}/.well-known/openid-configuration`,
      client_id: 'discovery-contract-client',
      client_secret: 'discovery-contract-secret',
      server_hostname: `http://127.0.0.1:${port}`,
      authMethod: 'openid',
    },
  });
  let server;
  try {
    server = await startServer(
      'production',
      {},
      {
        root,
        config,
        configPaths: true,
      },
    );
    assert.match(server.output(), /OpenID configured!/);
    await server.close();

    server = await startServer(
      'production',
      {},
      {
        root,
        config,
        configPaths: true,
      },
    );
    assert.match(server.output(), /OpenID configured!/);
    const state = await fetch(`${server.url}/account/needs-bootstrap`);
    assert.equal((await state.json()).data.loginMethod, 'openid');
    assert.deepEqual(provider.requests, [
      '/.well-known/openid-configuration',
      '/.well-known/openid-configuration',
    ]);
  } finally {
    await server?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function failedStartup(extraEnv, port) {
  const root = await mkdtemp(
    join(tmpdir(), `actual-shell-failure-${implementation}-`),
  );
  const readyListener = createNetServer();
  readyListener.listen(0, '127.0.0.1');
  await once(readyListener, 'listening');
  const readyAddress = readyListener.address();
  assert.ok(readyAddress && typeof readyAddress !== 'string');
  let readiness = '';
  readyListener.on('connection', socket => {
    socket.on('data', chunk => {
      readiness += chunk;
    });
  });
  const command = serverCommand();
  let stdout = '';
  let stderr = '';
  const child = spawn(command[0], command[1], {
    cwd: packageRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ACTUAL_CONFIG_PATH: join(root, 'missing-config.json'),
      ACTUAL_PORT: String(port),
      ACTUAL_HOSTNAME: '127.0.0.1',
      ACTUAL_DATA_DIR: root,
      ACTUAL_SERVER_FILES: join(root, 'server-files'),
      ACTUAL_USER_FILES: join(root, 'user-files'),
      ACTUAL_WEB_ROOT: root,
      ACTUAL_SERVER_READY_PORT: String(readyAddress.port),
      ACTUAL_HTTPS_KEY: '',
      ACTUAL_HTTPS_CERT: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  try {
    const exit = once(child, 'exit');
    const [code] = await Promise.race([
      exit,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Invalid server startup hung')),
          10_000,
        ),
      ),
    ]);
    assert.notEqual(code, null, `startup did not exit: ${stdout}${stderr}`);
    assert.doesNotMatch(stdout, /Listening on /);
    assert.equal(readiness, '');
  } finally {
    if (child.exitCode === null) child.kill();
    await new Promise(resolve => readyListener.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

async function failedStartupContract() {
  const occupied = createNetServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const address = occupied.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await failedStartup({}, address.port);
  } finally {
    await new Promise((resolve, reject) =>
      occupied.close(error => (error ? reject(error) : resolve())),
    );
  }

  await failedStartup(
    {
      ACTUAL_HTTPS_KEY:
        '-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----',
      ACTUAL_HTTPS_CERT:
        '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----',
    },
    await availablePort(),
  );
}

async function rustElectronReadyContract() {
  if (implementation !== 'rust') return;
  const root = await mkdtemp(join(tmpdir(), 'actual-shell-electron-rust-'));
  const port = await availablePort();
  const adapter = fork(
    join(packageRoot, 'contract/fixtures/rust-ready-adapter.mjs'),
    [],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        ACTUAL_RUST_BINARY: join(packageRoot, 'target/debug/actual-server'),
        NODE_ENV: 'production',
        ACTUAL_CONFIG_PATH: join(root, 'missing-config.json'),
        ACTUAL_PORT: String(port),
        ACTUAL_HOSTNAME: '127.0.0.1',
        ACTUAL_DATA_DIR: root,
        ACTUAL_SERVER_FILES: join(root, 'server-files'),
        ACTUAL_USER_FILES: join(root, 'user-files'),
        ACTUAL_WEB_ROOT: root,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  adapter.stdout.pipe(process.stdout);
  adapter.stderr.pipe(process.stderr);
  const messages = [];
  adapter.on('message', message => messages.push(message));
  try {
    const [message] = await Promise.race([
      once(adapter, 'message'),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Electron adapter readiness timed out')),
          10_000,
        ),
      ),
    ]);
    assert.deepEqual(message, { type: 'server-started' });
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(messages, [{ type: 'server-started' }]);
  } finally {
    adapter.send('stop');
    await once(adapter, 'exit');
    await rm(root, { recursive: true, force: true });
  }
}

if (implementation === 'rust') {
  const build = spawn('cargo', ['build', '--bin', 'actual-server'], {
    cwd: packageRoot,
    stdio: 'inherit',
  });
  const [code] = await once(build, 'exit');
  assert.equal(code, 0, 'Rust shell build failed');
}

await productionContract();
await developmentContract();
await tlsContract();
await configAndPersistenceContract();
await startupOpenIdContract();
await discoveryOpenIdRestartContract();
await failedStartupContract();
await rustElectronReadyContract();
console.log(`${implementation} app-shell contract passed`);
