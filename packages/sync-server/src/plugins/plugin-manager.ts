import { fork } from 'child_process';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import { randomUUID } from 'node:crypto';
import os from 'os';
import path from 'path';

import createDebug from 'debug';

import {
  assertDevPluginRegistrationAllowed,
  buildDevPluginUrl,
  normalizeDevPluginLocator,
  normalizeDevPluginPath,
} from './dev-plugin-locator.js';
import type { DevPluginLocatorInput } from './dev-plugin-locator.js';
import { getErrorMessage } from './plugin-errors.js';
import {
  bindPluginProcessEvents,
  handlePluginMessage,
  sendPluginRequest,
  stopPluginProcess,
  waitForPluginReady,
} from './plugin-ipc.js';
import type {
  JsonRecord,
  OnlinePlugin,
  PendingRequest,
  PluginResponse,
} from './plugin-ipc.js';
import {
  cleanupExtractedPlugin,
  extractZipPlugin as extractZipPluginArchive,
  findInstallablePlugins,
  getPluginSlugFromManifest,
  readPluginManifest,
  resolveSyncServerEntry,
} from './plugin-loader.js';
import type { PluginSourceCandidate } from './plugin-loader.js';
import {
  isSyncServerPlugin,
  toRuntimeManifest,
  validateManifest,
} from './plugin-manifest.js';
import type { Manifest, RuntimeManifest } from './plugin-manifest.js';
import { isPluginPathInsideDir, sanitizePluginSlug } from './plugin-paths.js';

type PluginSource = {
  slug: string;
  manifest: Manifest;
  path: string;
  zipPath?: string | null;
};

const debug = createDebug('actual:plugins');
const require = createRequire(import.meta.url);
const pluginRunnerPath = require.resolve('#plugin-runner');

export type PluginManager = ReturnType<typeof createPluginManager>;

function createPluginManager(pluginsDir: string) {
  const onlinePlugins = new Map<string, OnlinePlugin>();
  const extractedPlugins = new Map<string, string>();
  const pluginSources = new Map<string, PluginSource>();
  let operationQueue: Promise<unknown> = Promise.resolve();

  /**
   * Extract a zip file to a temporary directory
   */
  function extractZipPlugin(zipPath: string, pluginSlug: string): string {
    return extractZipPluginArchive(zipPath, pluginSlug, extractedPlugins);
  }

  /**
   * Get plugin slug from manifest
   */
  function getPluginSlugFromPluginManifest(pluginPath: string): string | null {
    return getPluginSlugFromManifest(pluginPath);
  }

  /**
   * Load all plugins from the plugins directory
   * Supports both subdirectories and .zip files
   * On slug clash, loads the first plugin and warns about duplicates
   */
  async function loadPlugins(): Promise<void> {
    return enqueue(async () => {
      await shutdownNow();
      await loadPluginsNow();
    });
  }

  async function loadPluginsNow(): Promise<void> {
    if (!fs.existsSync(pluginsDir)) {
      console.log('Plugins directory does not exist:', pluginsDir);
      return;
    }

    const loadedSlugs = new Set<string>();
    const pluginsToLoad = findInstallablePlugins(pluginsDir, extractedPlugins);

    for (const plugin of pluginsToLoad) {
      try {
        if (skipDuplicatePlugin(plugin, loadedSlugs)) {
          continue;
        }

        await loadPluginNow(plugin.slug, plugin.path, plugin.zipPath);
        loadedSlugs.add(plugin.slug);
        console.log(`✅ Loaded plugin: ${plugin.slug} (from ${plugin.name})`);

        debugPluginMetadata(plugin.slug);
      } catch (error) {
        console.error(
          `Failed to load plugin ${plugin.name}:`,
          getErrorMessage(error),
        );

        cleanupExtractedPlugin(plugin, extractedPlugins);
      }
    }
  }

  /**
   * Load a single plugin by slug
   * @param {string} pluginSlug - The plugin identifier
   * @param {string} pluginPath - Path to the plugin directory
   * @param {boolean} _isExtracted - Whether this plugin was extracted from a zip
   */
  async function loadPlugin(
    pluginSlug: string,
    pluginPath: string,
    _isExtracted = false,
    zipPath: string | null | undefined = null,
  ): Promise<void> {
    return enqueue(() => loadPluginNow(pluginSlug, pluginPath, zipPath));
  }

  async function loadPluginNow(
    pluginSlug: string,
    pluginPath: string,
    zipPath: string | null | undefined = null,
  ): Promise<void> {
    const manifest = readPluginManifest(pluginSlug, pluginPath);

    if (isSyncServerPlugin(manifest)) {
      const runtimeManifest = toRuntimeManifest(manifest);
      const entryPath = resolveSyncServerEntry(
        pluginSlug,
        pluginPath,
        manifest,
      );
      const childProcess = startPluginRunner(pluginPath, entryPath);

      rememberPluginSource(pluginSlug, manifest, pluginPath, zipPath);
      trackOnlinePlugin(pluginSlug, manifest, runtimeManifest, childProcess);
      bindPluginProcessEvents(pluginSlug, childProcess, onlinePlugins);

      await waitForPluginReady(pluginSlug, childProcess, onlinePlugins);
      return;
    }

    rememberPluginSource(pluginSlug, manifest, pluginPath, zipPath);
  }

  /**
   * Handle messages from plugin processes.
   */
  function handlePluginProcessMessage(
    pluginSlug: string,
    message: unknown,
  ): void {
    handlePluginMessage(pluginSlug, message, onlinePlugins);
  }

  /**
   * Forward one HTTP-shaped request to a ready plugin process.
   */
  async function sendRequest(
    pluginSlug: string,
    requestData: JsonRecord,
  ): Promise<PluginResponse> {
    return sendPluginRequest(pluginSlug, requestData, onlinePlugins);
  }

  /**
   * Check whether a plugin runner has loaded and signaled readiness.
   */
  function isPluginOnline(pluginSlug: string): boolean {
    const plugin = onlinePlugins.get(pluginSlug);
    return Boolean(plugin?.ready);
  }

  /**
   * Get runtime information for a loaded sync-server plugin.
   */
  function getPlugin(pluginSlug: string): OnlinePlugin | undefined {
    return onlinePlugins.get(pluginSlug);
  }

  /**
   * Get all loaded sync-server plugin slugs.
   */
  function getOnlinePlugins(): string[] {
    return Array.from(onlinePlugins.keys());
  }

  function getInstalledPluginManifests(): Array<Manifest & { source: string }> {
    return Array.from(pluginSources.values()).map(source => ({
      ...source.manifest,
      source: 'sync-server',
    }));
  }

  async function installPluginZip(zipBuffer: Buffer): Promise<Manifest> {
    return enqueue(() => installPluginZipNow(zipBuffer));
  }

  async function installPluginZipNow(zipBuffer: Buffer): Promise<Manifest> {
    fs.mkdirSync(pluginsDir, { recursive: true });

    const tempSlug = `upload-${randomUUID()}`;
    const tempZipPath = path.join(os.tmpdir(), `${tempSlug}.zip`);
    fs.writeFileSync(tempZipPath, zipBuffer);

    let extractedPath: string | null = null;
    try {
      extractedPath = extractZipPlugin(tempZipPath, tempSlug);
      const manifest = validateManifest(
        JSON.parse(
          fs.readFileSync(path.join(extractedPath, 'manifest.json'), 'utf8'),
        ),
      );
      const pluginSlug = sanitizePluginSlug(manifest.name);

      if (pluginSources.has(pluginSlug)) {
        throw new Error(`Plugin ${pluginSlug} is already installed`);
      }

      const zipPath = getPluginZipPath(pluginSlug, manifest.version);
      fs.writeFileSync(zipPath, zipBuffer);

      await loadPluginNow(pluginSlug, extractedPath, zipPath);
      extractedPlugins.delete(tempSlug);
      extractedPlugins.set(`${pluginSlug}-${manifest.version}`, extractedPath);
      extractedPath = null;

      return manifest;
    } finally {
      if (extractedPath) {
        fs.rmSync(extractedPath, { recursive: true, force: true });
      }
      fs.rmSync(tempZipPath, { force: true });
      extractedPlugins.delete(tempSlug);
    }
  }

  async function registerDevPlugin(
    devPluginLocator: DevPluginLocatorInput,
  ): Promise<Manifest> {
    return enqueue(() => registerDevPluginNow(devPluginLocator));
  }

  async function registerDevPluginNow(
    devPluginLocator: DevPluginLocatorInput,
  ): Promise<Manifest> {
    assertDevPluginRegistrationAllowed();
    const manifestLocator = normalizeDevPluginLocator(devPluginLocator);
    const manifestUrlForFetch = buildDevPluginUrl(manifestLocator);
    const manifestResponse = await fetch(manifestUrlForFetch);
    if (!manifestResponse.ok) {
      throw new Error(
        `Failed to fetch dev plugin manifest: ${manifestUrlForFetch}`,
      );
    }

    const manifest = validateManifest(await manifestResponse.json());

    if (!isSyncServerPlugin(manifest)) {
      return manifest;
    }

    const pluginSlug = sanitizePluginSlug(manifest.name);
    const devPath = path.join(os.tmpdir(), 'actual-dev-plugins', pluginSlug);
    if (
      !isPluginPathInsideDir(devPath, 'syncserver', manifest.syncserver.entry)
    ) {
      throw new Error(
        `Plugin ${manifest.name} sync-server files must live under syncserver/`,
      );
    }
    fs.rmSync(devPath, { recursive: true, force: true });
    fs.mkdirSync(path.join(devPath, 'syncserver'), { recursive: true });
    fs.writeFileSync(
      path.join(devPath, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    const parsedEntryUrl = new URL(
      manifest.syncserver.entry,
      manifestUrlForFetch,
    );
    const entryLocator = {
      ...manifestLocator,
      path: normalizeDevPluginPath(parsedEntryUrl.pathname),
    };
    const entryUrlForFetch = buildDevPluginUrl(entryLocator);
    const entryResponse = await fetch(entryUrlForFetch);
    if (!entryResponse.ok) {
      throw new Error(`Failed to fetch dev plugin entry: ${entryUrlForFetch}`);
    }

    const devEntryPath = path.join(devPath, manifest.syncserver.entry);
    fs.mkdirSync(path.dirname(devEntryPath), { recursive: true });
    fs.writeFileSync(devEntryPath, await entryResponse.text(), 'utf8');

    if (onlinePlugins.has(pluginSlug)) {
      const plugin = onlinePlugins.get(pluginSlug);
      plugin?.process.kill();
      onlinePlugins.delete(pluginSlug);
    }

    await loadPluginNow(pluginSlug, devPath);
    return manifest;
  }

  async function reloadPlugins(): Promise<void> {
    return enqueue(() => reloadPluginsNow());
  }

  async function reloadPluginsNow(): Promise<void> {
    await shutdownNow();
    await loadPluginsNow();
  }

  /**
   * Debug plugin routes and their authentication requirements.
   * Only outputs when DEBUG=actual:plugins is set.
   */
  function debugPluginMetadata(pluginSlug: string): void {
    const plugin = onlinePlugins.get(pluginSlug);
    if (!plugin || !plugin.manifest) {
      return;
    }

    const manifest = plugin.manifest;

    debug(`Plugin: ${pluginSlug}`);
    debug(`  Version: ${manifest.version}`);
    debug(`  Description: ${manifest.description || 'N/A'}`);
    debug(`  Entry: ${manifest.entry}`);

    if (manifest.routes && manifest.routes.length > 0) {
      debug(`  Routes (${manifest.routes.length}):`);

      for (const route of manifest.routes) {
        const methods = route.methods.join(', ');
        const auth = route.auth || 'authenticated'; // Default to authenticated
        const authLabel =
          auth === 'anonymous'
            ? 'anonymous'
            : auth === 'admin'
              ? 'admin'
              : 'authenticated';

        debug(
          `    ${authLabel} | ${methods.padEnd(15)} | /plugins-api/${pluginSlug}${route.path}`,
        );

        if (route.description) {
          debug(`      - ${route.description}`);
        }
      }
    } else {
      debug(`  Routes: none defined`);
    }

    debug(''); // Empty line for readability
  }

  /**
   * Shutdown all plugins
   */
  async function shutdown(): Promise<void> {
    return enqueue(() => shutdownNow());
  }

  async function shutdownNow(): Promise<void> {
    await Promise.all(
      Array.from(onlinePlugins.values(), plugin => stopPluginProcess(plugin)),
    );
    onlinePlugins.clear();
    pluginSources.clear();

    for (const [pluginSlug, extractPath] of extractedPlugins) {
      try {
        if (fs.existsSync(extractPath)) {
          fs.rmSync(extractPath, { recursive: true, force: true });
          console.log(`Cleaned up extracted plugin: ${pluginSlug}`);
        }
      } catch (error) {
        console.error(
          `Failed to clean up plugin ${pluginSlug}:`,
          getErrorMessage(error),
        );
      }
    }
    extractedPlugins.clear();
  }

  function skipDuplicatePlugin(
    plugin: PluginSourceCandidate,
    loadedSlugs: Set<string>,
  ): boolean {
    if (!loadedSlugs.has(plugin.slug)) {
      return false;
    }

    console.warn(
      `⚠️  Plugin slug clash detected: "${plugin.slug}" from "${plugin.name}" ` +
        `is already loaded. Skipping this plugin.`,
    );
    cleanupExtractedPlugin(plugin, extractedPlugins);
    return true;
  }

  function rememberPluginSource(
    pluginSlug: string,
    manifest: Manifest,
    pluginPath: string,
    zipPath: string | null | undefined,
  ): void {
    pluginSources.set(pluginSlug, {
      slug: pluginSlug,
      manifest,
      path: pluginPath,
      zipPath,
    });
  }

  function getPluginZipPath(pluginSlug: string, pluginVersion: string): string {
    if (!isPluginArchiveSegment(pluginVersion)) {
      throw new Error('Plugin version cannot contain path separators');
    }

    const zipPath = path.join(pluginsDir, `${pluginSlug}-${pluginVersion}.zip`);
    if (fs.existsSync(zipPath)) {
      throw new Error(
        `Plugin ${pluginSlug}@${pluginVersion} is already installed`,
      );
    }

    return zipPath;
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(task, task);
    operationQueue = result.catch(() => undefined);
    return result;
  }

  function startPluginRunner(
    pluginPath: string,
    entryPath: string,
  ): ChildProcess {
    return fork(pluginRunnerPath, [entryPath], {
      cwd: pluginPath,
      silent: false,
    });
  }

  function trackOnlinePlugin(
    pluginSlug: string,
    manifest: Manifest,
    runtimeManifest: RuntimeManifest,
    childProcess: ChildProcess,
  ): void {
    onlinePlugins.set(pluginSlug, {
      slug: pluginSlug,
      manifest: runtimeManifest,
      originalManifest: manifest,
      process: childProcess,
      ready: false,
      pendingRequests: new Map<string, PendingRequest>(),
    });
  }

  return {
    extractZipPlugin,
    getPluginSlugFromManifest: getPluginSlugFromPluginManifest,
    loadPlugins,
    loadPlugin,
    handlePluginMessage: handlePluginProcessMessage,
    sendRequest,
    isPluginOnline,
    getPlugin,
    getOnlinePlugins,
    getInstalledPluginManifests,
    installPluginZip,
    registerDevPlugin,
    reloadPlugins,
    debugPluginMetadata,
    shutdown,
  };
}

function isPluginArchiveSegment(value: string): boolean {
  return value !== '' && Array.from(value).every(isPluginArchiveCharacter);
}

function isPluginArchiveCharacter(character: string): boolean {
  return (
    (character >= 'a' && character <= 'z') ||
    (character >= 'A' && character <= 'Z') ||
    (character >= '0' && character <= '9') ||
    character === '.' ||
    character === '_' ||
    character === '-' ||
    character === '+'
  );
}

export { createPluginManager };
