import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
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
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {
      // The Rust build or server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Rust server did not become healthy within 120 seconds');
}

const dataDir = await mkdtemp(join(tmpdir(), 'actual-akahu-rust-contract-'));
const [serverPort, upstreamPort] = await Promise.all([
  availablePort(),
  availablePort(),
]);
const serverUrl = `http://127.0.0.1:${serverPort}`;
const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;
const rust = spawn('cargo', ['run', '--bin', 'actual-server'], {
  cwd: packageRoot,
  env: {
    ...process.env,
    ACTUAL_DATA_DIR: dataDir,
    ACTUAL_HOSTNAME: '127.0.0.1',
    ACTUAL_PORT: String(serverPort),
    AKAHU_API_URL: `${upstreamUrl}/v1`,
  },
  stdio: 'inherit',
});

try {
  await waitUntilHealthy(serverUrl, rust);
  const test = spawn('yarn', ['test:contract:akahu'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ACTUAL_CONTRACT_SERVER_URL: serverUrl,
      ACTUAL_CONTRACT_AKAHU_URL: upstreamUrl,
    },
    stdio: 'inherit',
  });
  const [code] = await once(test, 'exit');
  if (code !== 0) process.exitCode = code ?? 1;
} finally {
  if (rust.exitCode === null) {
    rust.kill();
    await once(rust, 'exit');
  }
  await rm(dataDir, { recursive: true, force: true });
}
