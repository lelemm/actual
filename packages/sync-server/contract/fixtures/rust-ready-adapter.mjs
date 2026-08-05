import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const listener = createServer();
listener.listen(0, '127.0.0.1');
await new Promise((resolve, reject) => {
  listener.once('listening', resolve);
  listener.once('error', reject);
});
const address = listener.address();
if (!address || typeof address === 'string') {
  throw new Error('Could not allocate the Rust readiness channel');
}

let messageCount = 0;
listener.on('connection', socket => {
  let value = '';
  socket.on('data', chunk => {
    value += chunk;
  });
  socket.on('end', () => {
    const lines = value.split('\n');
    if (lines.length !== 2 || lines[1] !== '' || messageCount !== 0) {
      throw new Error('Rust readiness channel must contain exactly one line');
    }
    messageCount++;
    process.send?.(JSON.parse(lines[0]));
    listener.close();
  });
});

const child = spawn(process.env.ACTUAL_RUST_BINARY, [], {
  env: {
    ...process.env,
    ACTUAL_SERVER_READY_PORT: String(address.port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

let isStopping = false;
process.on('message', message => {
  if (message === 'stop') {
    isStopping = true;
    child.kill();
  }
});
child.on('exit', code => process.exit(isStopping ? 0 : (code ?? 1)));
