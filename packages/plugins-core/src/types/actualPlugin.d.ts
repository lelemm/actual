import { CSSProperties } from 'react';

export interface PageHookMap {
  settings?: {
    renderableHooks?: {
      beforeHeader?: () => JSX.Element;
      afterHeader?: (args: { title: string }) => JSX.Element;
      appendComponents?: () => JSX.Element;
    };
    eventHooks?: {
      onInit?: () => void;
    };
  };
  schedules?: {
    renderableHooks?: {
      beforePageHeader?: () => JSX.Element;
      afterPageHeader?: (args: { pageTitle: string }) => JSX.Element;
    };
    eventHooks?: {
      onFind?: (query: string) => any;
    };
  };
}

export type PluginHooks = {
  [Page in keyof PageHookMap]?: {
    renderableHooks?: {
      [Hook in keyof PageHookMap[Page]['renderableHooks']]?: PageHookMap[Page]['renderableHooks'][Hook] extends (
        args: infer A
      ) => JSX.Element
        ? (container: HTMLDivElement, args: A) => JSX.Element
        : (container: HTMLDivElement) => JSX.Element;
    };
    eventHooks?: {
      [Hook in keyof PageHookMap[Page]['eventHooks']]?: PageHookMap[Page]['eventHooks'][Hook] extends (
        args: infer A
      ) => any
        ? (args: A) => ReturnType<PageHookMap[Page]['eventHooks'][Hook]>
        : () => ReturnType<PageHookMap[Page]['eventHooks'][Hook]>;
    };
  };
};

export interface ActualPlugin {
  name: string;
  version: string;
  // availableThemes?: () => string[];
  // getThemeIcon?: (themeName: string, properties?: CSSProperties) => JSX.Element;
  // getThemeSchema?: (themeName: string) => ThemeDefinition;
  uninstall: (db: IDBDatabase) => void;
  hooks: PageHookMap; // ✅ Uses PageHookMap
}

export type ActualPluginInitialized = Omit<ActualPlugin, 'hooks'> & {
  initialized: true;
  hooks: PluginHooks;
};
