import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitUntilHealthy(url, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'Rust OpenID server exited early');
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {
      // The Rust build or listener is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Rust OpenID server did not become healthy');
}

async function runVariant(variant) {
  const root = await mkdtemp(join(tmpdir(), `actual-openid-rust-${variant}-`));
  const data = join(root, 'data');
  const web = join(root, 'web');
  await Promise.all([mkdir(data), mkdir(web)]);
  await writeFile(join(web, 'index.html'), '<!doctype html>contract frontend');
  const [
    serverPort,
    pluggyPort,
    akahuPort,
    corsPort,
    enablePort,
    goCardlessPort,
  ] = await Promise.all(Array.from({ length: 6 }, availablePort));
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const contractEnv = {
    ...process.env,
    ACTUAL_CONTRACT_SERVER_URL: serverUrl,
    ACTUAL_CONTRACT_PLUGGY_URL: `http://127.0.0.1:${pluggyPort}`,
    ACTUAL_CONTRACT_AKAHU_URL: `http://127.0.0.1:${akahuPort}`,
    ACTUAL_CONTRACT_CORS_URL: `http://127.0.0.1:${corsPort}`,
    ACTUAL_CONTRACT_ENABLEBANKING_URL: `http://127.0.0.1:${enablePort}`,
    ACTUAL_CONTRACT_GOCARDLESS_URL: `http://127.0.0.1:${goCardlessPort}/api/v2`,
  };
  const rust = spawn('cargo', ['run', '--bin', 'actual-server'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ACTUAL_HOSTNAME: '127.0.0.1',
      ACTUAL_PORT: String(serverPort),
      ACTUAL_DATA_DIR: data,
      ACTUAL_SERVER_FILES: join(data, 'server-files'),
      ACTUAL_USER_FILES: join(data, 'user-files'),
      ACTUAL_WEB_ROOT: web,
      PLUGGY_API_URL: contractEnv.ACTUAL_CONTRACT_PLUGGY_URL,
      AKAHU_API_URL: `${contractEnv.ACTUAL_CONTRACT_AKAHU_URL}/v1`,
      ENABLEBANKING_API_URL: contractEnv.ACTUAL_CONTRACT_ENABLEBANKING_URL,
      GOCARDLESS_API_URL: contractEnv.ACTUAL_CONTRACT_GOCARDLESS_URL,
    },
    stdio: 'inherit',
  });

  try {
    await waitUntilHealthy(serverUrl, rust);
    const args =
      variant === 'normal'
        ? ['test:contract', '--', 'contract/server.contract.test.ts']
        : ['test:contract:rate-limit'];
    const test = spawn('yarn', args, {
      cwd: packageRoot,
      env: contractEnv,
      stdio: 'inherit',
    });
    const [code] = await once(test, 'exit');
    assert.equal(code, 0, `Rust OpenID ${variant} contract failed`);
  } finally {
    if (rust.exitCode === null) {
      rust.kill();
      await once(rust, 'exit');
    }
    await rm(root, { recursive: true, force: true });
  }
}

await runVariant('normal');
await runVariant('rate-limit');
console.log('rust OpenID contracts passed');
