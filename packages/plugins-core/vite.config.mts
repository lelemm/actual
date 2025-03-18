import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'actual-plugins-core',
      fileName: (format: string) => `actual-plugins-core.${format}.js`
    },
    rollupOptions: {
      external: [
        'react'
      ],
      output: {
        globals: {
          react: 'react'
        }
      }
    }
  }
});
