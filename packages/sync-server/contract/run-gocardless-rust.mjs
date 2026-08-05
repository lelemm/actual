import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(import.meta.url), '../..');

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a contract-test port');
  }
  await new Promise((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitUntilHealthy(url, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Rust server exited with code ${child.exitCode}`);
    }
    try {
      if ((await fetch(`${url}/health`)).ok) {
        return;
      }
    } catch {
      // The Rust build or server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Rust server did not become healthy within 120 seconds');
}

async function stop(child) {
  if (child.exitCode === null) {
    child.kill();
    await once(child, 'exit');
  }
}

const dataDir = await mkdtemp(
  join(tmpdir(), 'actual-gocardless-rust-contract-'),
);
const [serverPort, upstreamPort] = await Promise.all([
  availablePort(),
  availablePort(),
]);
const serverUrl = `http://127.0.0.1:${serverPort}`;
const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;
const expectedCredentials = {
  secret_id: 'restart-secret-id',
  secret_key: 'restart-secret-key',
};
const startRust = () =>
  spawn('cargo', ['run', '--bin', 'actual-server'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ACTUAL_DATA_DIR: dataDir,
      ACTUAL_HOSTNAME: '127.0.0.1',
      ACTUAL_PORT: String(serverPort),
      GOCARDLESS_API_URL: `${upstreamUrl}/api/v2`,
    },
    stdio: 'inherit',
  });

let rust = startRust();
let persistenceMock;
try {
  await waitUntilHealthy(serverUrl, rust);
  const test = spawn('yarn', ['test:contract:gocardless'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ACTUAL_CONTRACT_SERVER_URL: serverUrl,
      ACTUAL_CONTRACT_GOCARDLESS_URL: `${upstreamUrl}/api/v2`,
    },
    stdio: 'inherit',
  });
  const [code] = await once(test, 'exit');
  if (code !== 0) {
    throw new Error(`GoCardless contract exited with code ${code}`);
  }

  const beforeRestartLogin = await fetch(`${serverUrl}/account/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'contract-password' }),
  });
  const beforeRestartToken = (await beforeRestartLogin.json()).data?.token;
  if (!beforeRestartLogin.ok || !beforeRestartToken) {
    throw new Error('Could not log in before restart');
  }
  for (const [name, value] of [
    ['gocardless_secretId', expectedCredentials.secret_id],
    ['gocardless_secretKey', expectedCredentials.secret_key],
  ]) {
    const secret = await fetch(`${serverUrl}/secret/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actual-token': beforeRestartToken,
      },
      body: JSON.stringify({ name, value }),
    });
    if (!secret.ok) {
      throw new Error(`Could not set ${name} before restart`);
    }
  }

  await stop(rust);
  let credentials;
  persistenceMock = createHttpServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      if (request.method === 'POST' && request.url === '/api/v2/token/new/') {
        credentials = JSON.parse(Buffer.concat(chunks).toString());
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            access: 'restart.eyJleHAiOjQxMDI0NDQ4MDB9.signature',
            refresh: 'restart-refresh',
            access_expires: 86_400,
            refresh_expires: 2_592_000,
          }),
        );
        return;
      }
      if (
        request.method === 'GET' &&
        request.url === '/api/v2/institutions/?country=FI'
      ) {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify([{ id: 'RESTART_BANK', name: 'Restart Bank' }]));
        return;
      }
      response.writeHead(404).end();
    });
  });
  persistenceMock.listen(upstreamPort, '127.0.0.1');
  await once(persistenceMock, 'listening');

  rust = startRust();
  await waitUntilHealthy(serverUrl, rust);
  const login = await fetch(`${serverUrl}/account/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'contract-password' }),
  });
  const token = (await login.json()).data?.token;
  if (!login.ok || !token) {
    throw new Error('Could not log in after restart');
  }

  const headers = {
    'content-type': 'application/json',
    'x-actual-token': token,
  };
  const status = await fetch(`${serverUrl}/gocardless/status`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const statusBody = await status.json();
  if (!status.ok || statusBody.data?.configured !== true) {
    throw new Error('GoCardless credentials were not configured after restart');
  }

  const banks = await fetch(`${serverUrl}/gocardless/get-banks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ country: 'FI' }),
  });
  const banksBody = await banks.json();
  if (!banks.ok || banksBody.data?.[0]?.id !== 'RESTART_BANK') {
    throw new Error('GoCardless provider route failed after restart');
  }
  if (
    credentials?.secret_id !== expectedCredentials.secret_id ||
    credentials?.secret_key !== expectedCredentials.secret_key
  ) {
    throw new Error(
      'Persisted GoCardless credentials did not reach the provider',
    );
  }
  console.log('rust GoCardless restart contract passed');
} finally {
  await stop(rust);
  if (persistenceMock) {
    await new Promise((resolve, reject) =>
      persistenceMock.close(error => (error ? reject(error) : resolve())),
    );
  }
  await rm(dataDir, { recursive: true, force: true });
}
