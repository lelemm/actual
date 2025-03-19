import { defineConfig } from 'vite';
import path from 'path';
import { federation } from '@module-federation/vite';
import { fileURLToPath } from 'url';
import { createWriteStream, rmSync, writeFileSync } from 'fs';
import archiver from "archiver";

import manifest from "./src/manifest";

export default defineConfig({
  server: {
    origin: 'http://localhost:2000',
    port: 2000,
  },
  base: 'http://localhost:2000',
  build: {
    target: 'es2022',
    outDir: 'build',
    lib: {
      entry: path.resolve(__dirname, 'src/index.tsx'),
      name: 'plugin-dummy',
      fileName: format => `plugin-dummy.${format}.js`,
      formats: ['es'],
    },
    rollupOptions: {
      input: path.resolve(__dirname, 'src/index.tsx'),
      output: {
        globals: {},
      },
    },
  },
  plugins: [
    federation({
      name: 'plugin-dummy',
      manifest: true,
      getPublicPath: 'plugin/data/dummy',
      exposes: {
        '.': './src/index.tsx',
      },
      shared: {
        react: {
          singleton: true,
        },
        'react/': {
          singleton: true,
        },
      },
    }),
    {
      name: "vite-plugin-clean-build",
      buildStart() {
        const distPath = path.resolve(__dirname, "build");
        console.log("🧹 Cleaning build folder...");
        rmSync(distPath, { recursive: true, force: true });
        console.log("✅ Build folder cleaned.");
      },
    },
    {
      name: "vite-plugin-generate-manifest",
      closeBundle() {
        const outputPath = path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "build",
          "manifest.json"
        );

        writeFileSync(outputPath, JSON.stringify(manifest, null, 2), "utf-8");
        console.log("✅ manifest.json generated in /build");
      },
    },
    {
      name: "vite-plugin-zip-build",
      closeBundle() {
        const distPath = path.resolve(__dirname, "build");
        const zipName = `payload-${manifest.name}-${manifest.version}.zip`;
        const outputPath = path.resolve(__dirname, "build", zipName);
        const output = createWriteStream(outputPath);
        const archive = (archiver as any)("zip", { zlib: { level: 9 } });

        console.log(`📦 Creating ${zipName}...`);

        archive.glob("**/*", {
          cwd: distPath,
          ignore: [zipName],
        });

        archive.pipe(output);
        archive.finalize();

        archive.on("close", () => {
          console.log(`✅ ${zipName} created (${archive.pointer()} total bytes)`);
        });

        archive.on("error", (err) => {
          console.error("❌ Error creating ZIP file:", err.message);
        });
      },
    },
  ],
});
