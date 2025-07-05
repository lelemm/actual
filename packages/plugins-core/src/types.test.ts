import { describe, it, expect } from 'vitest';
import type {
  ActualPlugin,
  ActualPluginInitialized,
  HostContext,
  PluginDatabase,
  PluginSpreadsheet,
  ThemeColorOverrides,
  SidebarLocations,
  PluginMigration,
} from './types/actualPlugin';
import type { ActualPluginManifest } from './types/actualPluginManifest';
import type { PluginQuery, PluginQueryState } from './types/query';

describe('Type Definitions', () => {
  it('should have correct ActualPlugin interface', () => {
    const plugin: ActualPlugin = {
      name: 'Test Plugin',
      version: '1.0.0',
      activate: () => {},
      uninstall: () => {},
    };

    expect(plugin.name).toBe('Test Plugin');
    expect(plugin.version).toBe('1.0.0');
    expect(typeof plugin.activate).toBe('function');
    expect(typeof plugin.uninstall).toBe('function');
  });

  it('should have correct ActualPluginManifest interface', () => {
    const manifest: ActualPluginManifest = {
      url: 'https://github.com/user/plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      pluginType: 'client',
      minimumActualVersion: '24.1.0',
      author: 'Test Author',
    };

    expect(manifest.pluginType).toBe('client');
    expect(manifest.author).toBe('Test Author');
  });

  it('should have correct SidebarLocations type', () => {
    const locations: SidebarLocations[] = [
      'main-menu',
      'more-menu', 
      'before-accounts',
      'after-accounts',
      'topbar'
    ];

    expect(locations).toHaveLength(5);
  });

  it('should have correct PluginMigration type', () => {
    const migration: PluginMigration = [
      1640000000000,
      'initial_setup',
      'CREATE TABLE test (id INTEGER)',
      'DROP TABLE test'
    ];

    expect(migration).toHaveLength(4);
    expect(typeof migration[0]).toBe('number');
    expect(typeof migration[1]).toBe('string');
  });

  it('should have correct ThemeColorOverrides type', () => {
    const theme: ThemeColorOverrides = {
      pageBackground: '#ffffff',
      cardBackground: '#f5f5f5',
      buttonPrimaryBackground: '#007acc',
      'custom-myColor': '#ff0000',
    };

    expect(theme.pageBackground).toBe('#ffffff');
    expect(theme['custom-myColor']).toBe('#ff0000');
  });

  it('should support ActualPluginInitialized extension', () => {
    const initializedPlugin: ActualPluginInitialized = {
      name: 'Test Plugin',
      version: '1.0.0',
      initialized: true,
      activate: () => {},
      uninstall: () => {},
    };

    expect(initializedPlugin.initialized).toBe(true);
  });
}); 