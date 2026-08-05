import { spawn } from 'node:child_process';
import path from 'node:path';

const packageRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(packageRoot, '../..');
const manifest = path.join(repositoryRoot, 'packages/sync-server/Cargo.toml');
const binary = path.join(
  repositoryRoot,
  'packages/sync-server/target/debug',
  process.platform === 'win32' ? 'actual-server.exe' : 'actual-server',
);

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

await run('cargo', [
  'build',
  '--manifest-path',
  manifest,
  '--bin',
  'actual-server',
]);
await run('yarn', ['build:desktop', '--skip-exe-build', '--skip-translations']);
await run(
  'yarn',
  [
    'workspace',
    'desktop-electron',
    'exec',
    'playwright',
    'test',
    'e2e/onboarding.test.ts',
    '--grep',
    'starts the sync server',
  ],
  {
    ...process.env,
    ACTUAL_ELECTRON_SYNC_SERVER: 'rust',
    ACTUAL_RUST_SERVER_BINARY: binary,
  },
);
