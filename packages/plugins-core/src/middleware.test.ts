import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initializePlugin, convertPluginQueryToLootCore } from './middleware';
import { ActualPlugin } from './types/actualPlugin';

// Mock ReactDOM
vi.mock('react-dom/client', () => ({
  default: {
    createRoot: vi.fn(() => ({
      render: vi.fn(),
      unmount: vi.fn(),
    })),
  },
}));

describe('Plugin Middleware', () => {
  describe('initializePlugin', () => {
    it('should wrap a plugin with initialization logic', () => {
      const mockPlugin: ActualPlugin = {
        name: 'Test Plugin',
        version: '1.0.0',
        activate: vi.fn(),
        uninstall: vi.fn(),
      };

      const initializedPlugin = initializePlugin(mockPlugin);
      
      expect(initializedPlugin.name).toBe('Test Plugin');
      expect(initializedPlugin.version).toBe('1.0.0');
      expect(initializedPlugin.initialized).toBe(true);
      expect(typeof initializedPlugin.activate).toBe('function');
      expect(typeof initializedPlugin.uninstall).toBe('function');
    });

    it('should provide enhanced context with JSX element support', () => {
      const mockPlugin: ActualPlugin = {
        name: 'Test Plugin',
        version: '1.0.0',
        activate: vi.fn(),
        uninstall: vi.fn(),
      };

      const mockHostContext = {
        registerMenu: vi.fn(),
        pushModal: vi.fn(),
        registerRoute: vi.fn(),
        registerDashboardWidget: vi.fn(),
        addTheme: vi.fn(),
        overrideTheme: vi.fn(),
        q: vi.fn(),
        createSpreadsheet: vi.fn(),
        makeFilters: vi.fn(),
      };

      const initializedPlugin = initializePlugin(mockPlugin);
      
      // Test that activate function receives enhanced context
      initializedPlugin.activate(mockHostContext as any);
      
      expect(mockPlugin.activate).toHaveBeenCalledWith(
        expect.objectContaining({
          registerMenu: expect.any(Function),
          pushModal: expect.any(Function),
          registerRoute: expect.any(Function),
          registerDashboardWidget: expect.any(Function),
          addTheme: expect.any(Function),
          overrideTheme: expect.any(Function),
          q: expect.any(Function),
        })
      );
    });
  });

  describe('convertPluginQueryToLootCore', () => {
    it('should handle PluginQueryImpl instances', () => {
      const mockLootCoreQuery = {
        state: { table: 'transactions', filterExpressions: [] },
        filter: vi.fn(),
        select: vi.fn(),
        serialize: vi.fn(() => ({
          table: 'transactions',
          tableOptions: {},
          filterExpressions: [],
          selectExpressions: [],
          groupExpressions: [],
          orderExpressions: [],
          calculation: null,
          rawMode: false,
          withDead: false,
          validateRefs: true,
          limit: null,
          offset: null,
        })),
        serializeAsString: vi.fn(),
      };

      // Create a plugin query using the query builder function from initializePlugin
      const mockHostContext = {
        q: vi.fn(() => mockLootCoreQuery),
      };
      
      const mockPlugin = {
        name: 'Test Plugin',
        version: '1.0.0',
        activate: vi.fn((context) => {
          // Store the plugin query for testing
          (global as any).testPluginQuery = context.q('transactions');
        }),
        uninstall: vi.fn(),
      };

      const initializedPlugin = initializePlugin(mockPlugin);
      initializedPlugin.activate(mockHostContext as any);
      
      const pluginQuery = (global as any).testPluginQuery;
      const result = convertPluginQueryToLootCore(pluginQuery);
      expect(result).toBe(mockLootCoreQuery);
      
      // Clean up
      delete (global as any).testPluginQuery;
    });

    it('should reconstruct queries from serialized state', () => {
      const mockQuery = {
        state: {},
        options: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        groupBy: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        offset: vi.fn().mockReturnThis(),
        raw: vi.fn().mockReturnThis(),
        withDead: vi.fn().mockReturnThis(),
        withoutValidatedRefs: vi.fn().mockReturnThis(),
        calculate: vi.fn().mockReturnThis(),
        unfilter: vi.fn().mockReturnThis(),
        reset: vi.fn().mockReturnThis(),
        serialize: vi.fn(),
        serializeAsString: vi.fn(),
      };
      
      const mockLootCoreQ = vi.fn(() => mockQuery) as any;

      const pluginQuery = {
        serialize: () => ({
          table: 'transactions',
          tableOptions: {},
          filterExpressions: [{ amount: { $lt: 0 } }],
          selectExpressions: ['id', 'amount'],
          groupExpressions: [],
          orderExpressions: [],
          calculation: null,
          rawMode: false,
          withDead: false,
          validateRefs: true,
          limit: null,
          offset: null,
        }),
      } as any;

      const result = convertPluginQueryToLootCore(pluginQuery, mockLootCoreQ);
      
      expect(mockLootCoreQ).toHaveBeenCalledWith('transactions');
      expect(mockQuery.filter).toHaveBeenCalledWith({ amount: { $lt: 0 } });
      expect(mockQuery.select).toHaveBeenCalledWith(['id', 'amount']);
    });

    it('should throw error when lootCoreQ is missing for serialized queries', () => {
      const pluginQuery = {
        serialize: () => ({ table: 'transactions', filterExpressions: [] }),
      } as any;

      expect(() => convertPluginQueryToLootCore(pluginQuery)).toThrow(
        'lootCoreQ is required when converting serialized plugin queries'
      );
    });
  });
}); 