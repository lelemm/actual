import path from 'path';

import { normalizeDevPluginLocator } from './dev-plugin-locator.js';
import { validateManifest } from './plugin-manifest.js';
import { resolvePluginPath, sanitizePluginSlug } from './plugin-paths.js';

describe('plugin manifest validation', () => {
  describe('validateManifest', () => {
    it('accepts a sync-server manifest with runtime entry metadata', () => {
      const manifest = validateManifest({
        name: 'test-plugin',
        version: '1.0.0',
        type: 'syncserver',
        syncserver: { entry: 'syncserver/index.js' },
      });

      expect(manifest.name).toBe('test-plugin');
      expect(manifest.type).toBe('syncserver');
      expect(manifest).toMatchObject({
        syncserver: { entry: 'syncserver/index.js' },
      });
    });

    it('rejects invalid manifest identity fields', () => {
      expect(() =>
        validateManifest({
          name: '',
          version: '1.0.0',
        }),
      ).toThrow(/specify a name/);

      expect(() =>
        validateManifest({
          name: 'test-plugin',
          version: 1,
        }),
      ).toThrow(/specify a version/);
    });

    it('rejects invalid optional loading fields', () => {
      expect(() =>
        validateManifest({
          name: 'test-plugin',
          version: '1.0.0',
          type: false,
        }),
      ).toThrow(/type must be 'syncserver'/);
    });
  });
});

describe('plugin paths', () => {
  describe('sanitizePluginSlug', () => {
    it('maps special path slugs to a safe fallback', () => {
      expect(sanitizePluginSlug('')).toBe('plugin');
      expect(sanitizePluginSlug('.')).toBe('plugin');
      expect(sanitizePluginSlug('..')).toBe('plugin');
      expect(sanitizePluginSlug('../plugin')).toBe('..-plugin');
    });
  });

  describe('resolvePluginPath', () => {
    const pluginPath = path.join(path.sep, 'tmp', 'actual-plugin');

    it('resolves relative paths inside the plugin directory', () => {
      expect(resolvePluginPath(pluginPath, 'nested/index.js')).toBe(
        path.join(pluginPath, 'nested', 'index.js'),
      );
    });

    it('rejects absolute and parent-relative entries', () => {
      expect(() => resolvePluginPath(pluginPath, '/etc/passwd')).toThrow(
        /relative path/,
      );
      expect(() => resolvePluginPath(pluginPath, '../outside.js')).toThrow(
        /inside the plugin directory/,
      );
    });
  });
});

describe('dev plugin locator', () => {
  describe('normalizeDevPluginLocator', () => {
    it('normalizes supported local dev plugin locator forms', () => {
      expect(normalizeDevPluginLocator(3000)).toEqual({
        port: '3000',
        path: '/manifest.json',
      });
      expect(
        normalizeDevPluginLocator({
          port: '3001',
          path: '/plugins/demo/manifest.json',
        }),
      ).toEqual({
        port: '3001',
        path: '/plugins/demo/manifest.json',
      });
    });

    it('rejects invalid ports and paths that leave the origin', () => {
      expect(() => normalizeDevPluginLocator(0)).toThrow(/valid TCP port/);
      expect(() =>
        normalizeDevPluginLocator({ port: 3000, path: '/../secret' }),
      ).toThrow(/stay inside the origin/);
      expect(() =>
        normalizeDevPluginLocator({
          port: 3000,
          path: '/plugins/%2e%2e/secret',
        }),
      ).toThrow(/stay inside the origin/);
      expect(() =>
        normalizeDevPluginLocator({
          port: 3000,
          path: '/plugins/%252e%252e/secret',
        }),
      ).toThrow(/stay inside the origin/);
      expect(() =>
        normalizeDevPluginLocator({
          port: 3000,
          path: '/plugins/%5c..%5csecret',
        }),
      ).toThrow(/stay inside the origin/);
    });
  });
});
