import { defineConfig } from 'vite';
import path from 'path';
import { federation } from '@module-federation/vite';

export default defineConfig({
    server: {
        origin: 'http://localhost:2000',
        port: 2000,
      },
      base: "http://localhost:2000",
  build: {
    outDir: 'build',
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'), // Adjust if needed
      name: 'plugin-dummy',
      fileName: (format) => `plugin-dummy.${format}.js`,
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        globals: {
        },
      },
    },
  },
  plugins: [
    federation({
      name: 'vite_provider',
      manifest: true,
      exposes: {
        '.': './src/index.ts',
      },
      shared: {
      },
    }),
  ]
});
