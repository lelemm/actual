const path = require('path');

const esbuild = require('esbuild');

const packageRoot = path.join(__dirname, '..');

esbuild.buildSync({
  entryPoints: [path.join(packageRoot, 'syncserver', 'index.ts')],
  outfile: path.join(packageRoot, 'dist', 'plugin', 'syncserver', 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
});
