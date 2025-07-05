import { defineConfig } from 'vite';
import path from 'path';
import { federation } from '@module-federation/vite';
import { fileURLToPath } from 'url';
import { createWriteStream, rmSync, writeFileSync, mkdirSync } from 'fs';
import archiver from "archiver";
import react from '@vitejs/plugin-react-swc'

import manifest from "./src/manifest";

export default defineConfig({
  server: {
    origin: 'http://localhost:2000',
    port: 2000,
  },
  preview: {
    port: 2000,
  },
  base: 'http://localhost:2000',
  build: {
    target: 'es2022',
    outDir: 'build',
    rollupOptions: {
      input: path.resolve(__dirname, 'src/index.tsx'),
      output: {
        globals: {},
      },
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
  },
  plugins: [
    {
      name: "vite-plugin-clean-build",
      buildStart() {
        const distPath = path.resolve(__dirname, "build");
        console.log("🧹 Cleaning build folder...");
        rmSync(distPath, { recursive: true, force: true });
        console.log("✅ Build folder cleaned.");
      },
    } as any,
    federation({
      name: 'testPlugin',
      ignoreOrigin: true,
      manifest: true,
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
    react({ reactRefreshHost: 'http://localhost:2000' }),
    {
      name: "vite-plugin-generate-manifest",
      closeBundle() {
        const buildDir = path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "build"
        );
        const outputPath = path.resolve(buildDir, "manifest.json");

        // Ensure build directory exists
        mkdirSync(buildDir, { recursive: true });

        writeFileSync(outputPath, JSON.stringify(manifest, null, 2), "utf-8");
        console.log("✅ manifest.json generated in /build");
      },
    } as any,
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
    } as any,
  ],
}); 