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
  server: {
    origin: 'http://localhost:2002',
    port: 2002,
  },
  preview: {
    port: 2002,
    host: '0.0.0.0',
  },
  base: 'http://localhost:2002',
  build: {
    target: 'es2022',
    outDir: 'frontend-build',
    lib: {
      entry: path.resolve(__dirname, 'frontend/src/index.tsx'),
      name: manifest.name,
      fileName: format => `${manifest.name}.${format}.js`,
      formats: ['es'],
    },
    rollupOptions: {
      input: path.resolve(__dirname, 'frontend/src/index.tsx'),
      output: {
        globals: {},
      },
      external: [],
    },
  },
  ssr: {
    noExternal: [
      '@actual-app/plugins-core',
      '@actual-app/components',
      'react',
      'react-dom',
    ],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(
      process.env.NODE_ENV || 'production',
    ),
  },
  plugins: [
    federation({
      name: manifest.name,
      ignoreOrigin: true,
      manifest: true,
      dev: {
        disableDynamicRemoteTypeHints: true,
        remoteHmr: true,
      },
      exposes: {
        '.': './frontend/src/index.tsx',
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
        'react-i18next': {
          singleton: true,
          requiredVersion: '^17.0.8',
        },
        i18next: {
          singleton: true,
          requiredVersion: '^26.3.1',
        },
      },
    }),
    react(),
  ],
});
