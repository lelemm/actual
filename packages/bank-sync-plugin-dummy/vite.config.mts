import path from 'path';
import { fileURLToPath } from 'url';

import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { manifest } from './src/manifest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ['development'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist/plugin/frontend',
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, 'frontend/src/index.ts'),
      name: manifest.name,
      fileName: format => `${manifest.name}.${format}.js`,
      formats: ['es'],
    },
  },
  plugins: [
    federation({
      name: manifest.name,
      ignoreOrigin: true,
      manifest: true,
      dts: false,
      exposes: {
        '.': './frontend/src/index.ts',
      },
      shared: {
        react: {
          singleton: true,
          requiredVersion: '19.2.7',
        },
        'react-dom': {
          singleton: true,
          requiredVersion: '19.2.7',
        },
        'react-dom/client': {
          singleton: true,
          requiredVersion: '19.2.7',
        },
        'react/jsx-runtime': {
          singleton: true,
          requiredVersion: '19.2.7',
        },
      },
    }),
    react(),
  ],
});
