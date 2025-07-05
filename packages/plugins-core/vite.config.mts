import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    outDir: 'build',
    lib: {
      entry: 'src/index.ts',
      name: '@actual-app/plugins-core',
      fileName: (format) => format === 'es' ? 'index.js' : 'index.cjs',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: ['react', 'react-dom', '@actual-app/components'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
        },
      },
    },
  },
  plugins: [
    dts({
      insertTypesEntry: true,
      outDir: 'build',
      include: ['src/**/*'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      rollupTypes: false,
      copyDtsFiles: false,
    }),
  ],
});
