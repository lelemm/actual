import { chmod, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { rebuild } from '@electron/rebuild';
import copyFiles from 'copyfiles';
import { Arch } from 'electron-builder';
import type { AfterPackContext } from 'electron-builder';

/* The beforePackHook runs before packing the Electron app for an architecture
We hook in here to build anything architecture dependent - such as beter-sqlite3
To build, we call @electron/rebuild on the better-sqlite3 module */
const beforePackHook = async (context: AfterPackContext) => {
  const arch: string = Arch[context.arch];
  const buildPath = context.packager.projectDir;
  const projectRootPath = buildPath + '/../../';
  const electronVersion = context.packager.config.electronVersion;

  if (!electronVersion) {
    console.error('beforePackHook: Unable to find electron version.');
    process.exit(); // End the process - electron version is required
  }

  try {
    const rustBinary = process.env.ACTUAL_RUST_SERVER_BINARY;
    if (rustBinary) {
      const binaryName =
        context.packager.platform.name === 'windows'
          ? 'actual-server.exe'
          : 'actual-server';
      const stagingDirectory = path.join(buildPath, 'build', 'rust-server');
      const stagedBinary = path.join(stagingDirectory, binaryName);
      await mkdir(stagingDirectory, { recursive: true });
      await copyFile(path.resolve(rustBinary), stagedBinary);
      if (context.packager.platform.name !== 'windows') {
        await chmod(stagedBinary, 0o755);
      }
      const extraResources = context.packager.config.extraResources;
      context.packager.config.extraResources = [
        ...(Array.isArray(extraResources)
          ? extraResources
          : extraResources
            ? [extraResources]
            : []),
        { from: stagedBinary, to: `actual-server/${binaryName}` },
      ];
      console.info(`Bundled Rust sync server from ${rustBinary}`);
    }

    await rebuild({
      arch,
      buildPath,
      electronVersion,
      force: true,
      projectRootPath,
      onlyModules: ['better-sqlite3', 'bcrypt', 'argon2'],
    });

    console.info(`Rebuilt better-sqlite3, bcrypt, and argon2 with ${arch}!`);

    if (context.packager.platform.name === 'windows') {
      console.info(`Windows build - copying appx files...`);

      await new Promise(resolve =>
        copyFiles(['./appx/**/*', './build'], { error: true }, resolve),
      );

      console.info(`Copied appx files!`);
    }
  } catch (err) {
    console.error('beforePackHook:', err);
    process.exit(); // End the process - unsuccessful build
  }
};

// oxlint-disable-next-line import/no-default-export
export default beforePackHook;
