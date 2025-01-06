import * as path from 'path';
import { fileURLToPath } from 'url';

import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [dts({ insertTypesEntry: true, include: ['src'], copyDtsFiles: true })],
  build: {
    outDir: 'build',
    lib: {
      entry: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        'src/index.ts',
      ),
      name: 'Components',
      formats: ['es', 'cjs'],
      fileName: format => `index.${format}.js`,
    },
    rollupOptions: {
      external: ['react', 'react-dom', '@emotion/css', 'react-aria', 'react-aria-components'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
        },
      },
    },
  },
});
