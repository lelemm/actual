import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

async function main() {
  const binary = process.env.ACTUAL_RUST_SERVER_BINARY;
  if (!binary) {
    throw new Error('ACTUAL_RUST_SERVER_BINARY is required');
  }

  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    listener.once('listening', resolve);
    listener.once('error', reject);
  });

  const address = listener.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate the Rust readiness channel');
  }

  let messageCount = 0;
  let isStopping = false;

  const child = spawn(binary, [], {
    env: {
      ...process.env,
      ACTUAL_SERVER_READY_PORT: String(address.port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);

  function stopChild() {
    if (!child.killed) {
      child.kill(process.platform === 'win32' ? undefined : 'SIGINT');
    }
  }

  listener.on('connection', socket => {
    let value = '';
    socket.on('data', chunk => {
      value += chunk;
    });
    socket.on('end', () => {
      const lines = value.split('\n');
      if (lines.length !== 2 || lines[1] !== '' || messageCount !== 0) {
        console.error('Rust readiness channel must contain exactly one line');
        stopChild();
        process.exit(1);
      }
      messageCount += 1;
      process.parentPort.postMessage(JSON.parse(lines[0]));
      listener.close();
    });
  });

  process.parentPort.on('message', ({ data }) => {
    if (data?.type === 'stop') {
      isStopping = true;
      listener.close();
      stopChild();
    }
  });

  process.once('exit', stopChild);
  child.once('error', error => {
    console.error(`Failed to start Rust sync server: ${error.message}`);
    listener.close();
    process.exit(1);
  });
  child.once('exit', code => {
    listener.close();
    process.exit(isStopping ? 0 : (code ?? 1));
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
