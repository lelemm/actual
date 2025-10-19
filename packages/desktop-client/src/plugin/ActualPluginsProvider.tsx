import React, {
  createContext,
  useContext,
  type ReactNode,
  useCallback,
  useRef,
  useState,
  useEffect,
  useMemo,
  type MutableRefObject,
} from 'react';

import { type CategoryViews } from '@actual-app/shared-types';
import { createInstance } from '@module-federation/enhanced/runtime';
import {
  type ActualPluginEntry,
  type ActualPluginInitialized,
  type PayeeEntity,
  type CategoryEntity,
  type CategoryGroupEntity,
  type AccountEntity,
} from 'plugins-core/index';
import {
  type ThemeColorTypes,
  type ContextEvent,
  type SlotLocations,
} from 'plugins-core/types/actualPlugin';

import { type ActualPluginStored } from 'loot-core/types/models/actual-plugin-stored';

import {
  loadPlugins,
  loadPluginsScript,
  type PluginRouteFn,
  type PluginModalModel,
  type PluginSlotRegistrationFn,
} from './core/pluginLoader';
import { getAllPlugins } from './core/pluginStore';

import { useGlobalPref } from '@desktop-client/hooks/useGlobalPref';
import { useNavigate } from '@desktop-client/hooks/useNavigate';
import { useDispatch, useSelector } from '@desktop-client/redux';
import { store } from '@desktop-client/redux/store';

// Move stable refs to module scope to prevent recreation
const modalMap = new Map<string, PluginModalModel>();
let mfInstance: ReturnType<typeof createInstance> | null = null;

export type PluginDashboardWidget = {
  pluginId: string;
  widgetType: string;
  displayName: string;
  renderWidget: (container: HTMLDivElement) => void | (() => void);
  defaultWidth?: number;
  defaultHeight?: number;
  minWidth?: number;
  minHeight?: number;
};

export type ActualPluginsContextType = {
  plugins: ActualPluginInitialized[];
  pluginStore: ActualPluginStored[];
  refreshPluginStore: (
    devUrl?: string,
    forceInitialize?: boolean,
  ) => Promise<void>;
  modalMap: MutableRefObject<Map<string, PluginModalModel>>;
  pluginsRoutes: Map<string, PluginRouteFn>;
  slotItems: Record<SlotLocations, Map<string, PluginSlotRegistrationFn>>;
  pluginRegisteredWidgets: Map<string, PluginDashboardWidget>;
  // Theme management
  themes: Map<
    string,
    {
      id: string;
      displayName: string;
      colorOverrides: ThemeColorTypes;
      baseTheme?: 'light' | 'dark' | 'midnight';
      description?: string;
      pluginName: string;
    }
  >;
  registerTheme: (
    pluginName: string,
    themeId: string,
    displayName: string,
    colorOverrides: ThemeColorTypes,
    options?: {
      baseTheme?: 'light' | 'dark' | 'midnight';
      description?: string;
    },
  ) => void;
  getThemes: () => Array<{ value: string; label: string }>;
  getThemeColors: (
    themeId: string,
    baseColors: Record<string, string>,
  ) => Record<string, string>;
};

// Create default context value with sensible defaults
const defaultContextValue: ActualPluginsContextType = {
  plugins: [],
  pluginStore: [],
  refreshPluginStore: () => Promise.resolve(),
  modalMap: { current: new Map() },
  pluginsRoutes: new Map(),
  slotItems: {
    'main-menu': new Map(),
    'more-menu': new Map(),
    'before-accounts': new Map(),
    'after-accounts': new Map(),
    topbar: new Map(),
  },
  pluginRegisteredWidgets: new Map(),
  themes: new Map(),
  registerTheme: () => {},
  getThemes: () => [],
  getThemeColors: (_themeId: string, baseColors: Record<string, string>) =>
    baseColors,
};

// Create the context with meaningful defaults
const ActualPluginsContext =
  createContext<ActualPluginsContextType>(defaultContextValue);

// Export the context for direct usage when needed
export { ActualPluginsContext };

// The Provider
export function ActualPluginsProvider({ children }: { children: ReactNode }) {
  const [pluginsEnabled] = useGlobalPref('plugins');

  const [plugins, setPlugins] = useState<ActualPluginInitialized[]>([]);
  const [pluginStore, setPluginStore] = useState<ActualPluginStored[]>([]);
  const [events, setEvents] = useState<{
    [K in keyof ContextEvent]?: Array<(data: ContextEvent[K]) => void>;
  }>({});

  // Global preference for storing plugin theme metadata
  const [savedPluginThemes, setSavedPluginThemes] = useGlobalPref('themes');

  // Runtime theme management state
  const [runtimeThemes, setRuntimeThemes] = useState<
    Map<
      string,
      {
        id: string;
        displayName: string;
        colorOverrides: ThemeColorTypes;
        baseTheme?: 'light' | 'dark' | 'midnight';
        description?: string;
        pluginName: string;
      }
    >
  >(new Map());

  // Create memoized selectors that return stable references
  const payeesSelector = useMemo(() => {
    let lastPayees: PayeeEntity[] | null = null;
    let lastResult: { payees: PayeeEntity[] } | null = null;

    return (state: ReturnType<typeof store.getState>) => {
      if (state.payees.payees !== lastPayees) {
        lastPayees = state.payees.payees;
        lastResult = {
          payees: Array.isArray(state.payees.payees)
            ? (state.payees.payees as PayeeEntity[])
            : [],
        };
      }
      return lastResult!;
    };
  }, []);

  const categoriesSelector = useMemo(() => {
    let lastCategories: CategoryViews | null = null;
    let lastResult: {
      categories: CategoryEntity[];
      groups: CategoryGroupEntity[];
    } | null = null;

    return (state: ReturnType<typeof store.getState>) => {
      if (state.budget.categories !== lastCategories) {
        lastCategories = state.budget.categories;
        lastResult = {
          categories: state.budget.categories?.list || [],
          groups: state.budget.categories?.grouped || [],
        };
      }
      return lastResult!;
    };
  }, []);

  const accountsSelector = useMemo(() => {
    let lastAccounts: AccountEntity[] | null = null;
    let lastResult: { accounts: AccountEntity[] } | null = null;

    return (state: ReturnType<typeof store.getState>) => {
      if (state.account.accounts !== lastAccounts) {
        lastAccounts = state.account.accounts;
        lastResult = {
          accounts: Array.isArray(state.account.accounts)
            ? (state.account.accounts as AccountEntity[])
            : [],
        };
      }
      return lastResult!;
    };
  }, []);

  useEventDispatcher('payees', payeesSelector, events);
  useEventDispatcher('categories', categoriesSelector, events);
  useEventDispatcher('accounts', accountsSelector, events);

  // We store modules in memory if needed (original code had it, but not used outside loadPlugins)
  // If you want to keep that, do so:
  // const [pluginsModules, setPluginsModules] = useState<Map<string, ActualPluginEntry>>(new Map());

  const [initialized, setinitialized] = useState(false);

  // Reset initialization state on unhandled runtime errors in development
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      const handleRuntimeError = (event: PromiseRejectionEvent) => {
        if (event.reason?.message?.includes('Federation Runtime')) {
          console.warn(
            'Module federation runtime error detected, resetting initialization state',
          );
          setinitialized(false);
          // Prevent the error from propagating further
          event.preventDefault();
        }
      };

      window.addEventListener('unhandledrejection', handleRuntimeError);

      return () => {
        window.removeEventListener('unhandledrejection', handleRuntimeError);
      };
    }
  }, []);

  // Initialize MF instance early to ensure it's always available
  useEffect(() => {
    // Only initialize if we don't have one
    if (!mfInstance) {
      try {
        const newInstance = createInstance({
          name: '@actual/host-app',
          remotes: [],
          shared: {
            'react-i18next': {
              shareConfig: {
                singleton: true,
                requiredVersion: '^15.5.3',
              },
            },
            i18next: {
              shareConfig: {
                singleton: true,
                requiredVersion: '^25.2.1',
              },
            },
          },
        });

        mfInstance = newInstance;
      } catch (error) {
        console.warn(
          'Failed to initialize Module Federation instance early:',
          error,
        );
      }
    }
  }, []);
  const [pluginsRoutes, setPluginsRoutes] = useState<
    Map<string, PluginRouteFn>
  >(new Map());
  const [slotItems, setSlotItems] = useState<
    Record<SlotLocations, Map<string, PluginSlotRegistrationFn>>
  >({
    'main-menu': new Map(),
    'more-menu': new Map(),
    'before-accounts': new Map(),
    'after-accounts': new Map(),
    topbar: new Map(),
  });
  const [pluginRegisteredWidgets, setPluginRegisteredWidgets] = useState<
    Map<string, PluginDashboardWidget>
  >(new Map());

  const dispatch = useDispatch();
  const navigateBase = useNavigate();

  const themeStateRef = useRef({
    savedThemes: savedPluginThemes,
    setSavedThemes: setSavedPluginThemes,
  });
  themeStateRef.current = {
    savedThemes: savedPluginThemes,
    setSavedThemes: setSavedPluginThemes,
  };

  const removePluginThemes = useCallback((pluginName: string) => {
    const themesToRemove: string[] = [];

    setRuntimeThemes(prev => {
      const newMap = new Map(prev);
      for (const [themeId, theme] of newMap) {
        if (theme.pluginName === pluginName) {
          themesToRemove.push(themeId);
          newMap.delete(themeId);
        }
      }
      return newMap;
    });

    if (themesToRemove.length > 0) {
      const { savedThemes, setSavedThemes } = themeStateRef.current;
      const updatedSavedThemes = { ...savedThemes };
      for (const themeId of themesToRemove) {
        delete updatedSavedThemes[themeId];
      }
      setSavedThemes(updatedSavedThemes);
    }
  }, []);

  const registerTheme = useCallback(
    (
      pluginName: string,
      themeId: string,
      displayName: string,
      colorOverrides: ThemeColorTypes,
      options?: {
        baseTheme?: 'light' | 'dark' | 'midnight';
        description?: string;
      },
    ) => {
      setRuntimeThemes(prev => {
        const newMap = new Map(prev);
        newMap.set(themeId, {
          id: themeId,
          displayName,
          colorOverrides,
          baseTheme: options?.baseTheme || 'light',
          description: options?.description,
          pluginName,
        });
        return newMap;
      });

      const { savedThemes, setSavedThemes } = themeStateRef.current;
      setSavedThemes({
        ...savedThemes,
        [themeId]: {
          id: themeId,
          displayName,
          description: options?.description,
          baseTheme: options?.baseTheme || 'light',
          colors: colorOverrides,
        },
      });
      return () => {
        removePluginThemes(pluginName);
      };
    },
    [removePluginThemes],
  );

  const getThemes = useCallback((): Array<{
    value: string;
    label: string;
  }> => {
    // Get themes from runtime (loaded plugins)
    const runtimeThemesList = Array.from(runtimeThemes.values()).map(theme => ({
      value: theme.id,
      label: theme.displayName,
    }));

    // Get themes from saved preferences (may not be loaded yet)
    const savedThemes = savedPluginThemes
      ? Object.values(savedPluginThemes)
          .filter(theme => !runtimeThemesList.some(rt => rt.value === theme.id))
          .map(theme => ({
            value: theme.id,
            label: theme.displayName,
          }))
      : [];

    return [...runtimeThemesList, ...savedThemes];
  }, [runtimeThemes, savedPluginThemes]);

  const themeDataRef = useRef({ runtimeThemes });
  themeDataRef.current = { runtimeThemes };

  const getThemeColors = useCallback(
    (
      themeId: string,
      baseColors: Record<string, string>,
    ): Record<string, string> => {
      let colors = { ...baseColors };

      const { runtimeThemes } = themeDataRef.current;

      // If it's a plugin theme, start with base theme and apply overrides
      const runtimePluginTheme = runtimeThemes.get(themeId);
      if (runtimePluginTheme) {
        colors = {
          ...colors,
          ...runtimePluginTheme.colorOverrides,
        };
      } else {
        // Check saved themes as fallback
        const savedTheme = savedPluginThemes?.[themeId];
        if (savedTheme) {
          colors = {
            ...colors,
            ...savedTheme.colors,
          };
        }
      }

      return colors;
    },
    [savedPluginThemes],
  );

  // The function that actually registers and activates plugin code
  const handleLoadPlugins = useCallback(
    async (pluginsEntries: Map<string, ActualPluginEntry>) => {
      // We pass these references so plugin activation can call them.
      await loadPlugins({
        pluginsEntries,
        dispatch,
        setPlugins,
        modalMap: { current: modalMap },
        setPluginsRoutes,
        setSlotItems,
        setPluginRegisteredWidgets,
        navigateBase,
        setEvents,
        registerTheme,
        removePluginThemes,
      });

      const state = store.getState();
      dispatchEvent('payees', events, {
        payees: Array.isArray(state.payees.payees) ? state.payees.payees : [],
      });
      dispatchEvent('categories', events, {
        categories: Array.isArray(state.budget.categories)
          ? state.budget.categories
          : [],
        groups: [],
      });
      dispatchEvent('accounts', events, {
        accounts: Array.isArray(state.account.accounts)
          ? state.account.accounts
          : [],
      });
    },
    [dispatch, navigateBase, events, removePluginThemes, registerTheme],
  );

  const isLoadingRef = useRef(false);

  const handleLoadPluginsScript = useCallback(
    async (pluginsData: ActualPluginStored[], devUrl?: string) => {
      if (initialized && !devUrl) return;

      if (isLoadingRef.current) return;

      isLoadingRef.current = true;

      try {
        setinitialized(
          await loadPluginsScript({
            pluginsData,
            handleLoadPlugins,
            devUrl,
            mfInstance,
          }),
        );
      } finally {
        isLoadingRef.current = false;
      }
    },
    [handleLoadPlugins, initialized],
  );

  const refreshPluginStore = useCallback(
    async (devUrl?: string, forceInitialize?: boolean) => {
      if (!pluginsEnabled && !forceInitialize) return;

      const pluginsFromDB = (await getAllPlugins()) as ActualPluginStored[];

      if (
        pluginsFromDB.length !== pluginStore.length ||
        (devUrl && devUrl !== '') ||
        forceInitialize
      ) {
        await handleLoadPluginsScript(pluginsFromDB, devUrl);
      }
      setPluginStore(pluginsFromDB);
    },
    [pluginStore.length, handleLoadPluginsScript, pluginsEnabled],
  );

  // Provide everything
  const contextValue: ActualPluginsContextType = {
    plugins,
    pluginStore,
    refreshPluginStore,
    modalMap: { current: modalMap },
    pluginsRoutes,
    slotItems,
    pluginRegisteredWidgets,
    themes: runtimeThemes,
    registerTheme,
    getThemes,
    getThemeColors,
  };

  return (
    <ActualPluginsContext.Provider value={contextValue}>
      {children}
    </ActualPluginsContext.Provider>
  );
}

// Hook for accessing plugins context - works with or without provider
export function useActualPlugins() {
  return useContext(ActualPluginsContext);
}

function dispatchEvent<K extends keyof ContextEvent>(
  key: K,
  events: {
    [K in keyof ContextEvent]?: Array<(data: ContextEvent[K]) => void>;
  },
  data: ContextEvent[K],
) {
  const listeners = events[key];
  if (listeners && listeners.length > 0) {
    listeners.forEach(cb => cb(data));
  }
}

function useEventDispatcher<K extends keyof ContextEvent>(
  key: K,
  selector: (state: ReturnType<typeof store.getState>) => ContextEvent[K],
  events: {
    [K in keyof ContextEvent]?: Array<(data: ContextEvent[K]) => void>;
  },
) {
  const value = useSelector(selector);
  const eventHandlers = events[key];

  useEffect(() => {
    dispatchEvent(key, events, value);
  }, [events, key, value, eventHandlers]);
}
