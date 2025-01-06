import { CSSProperties } from 'react';

import { ThemeDefinition } from './themeDefinition';

export interface MethodArgumentMap {}

export interface MethodReturnMap {}

export type MethodArguments<K extends keyof MethodArgumentMap> =
  MethodArgumentMap[K];
export type MethodReturn<K extends keyof MethodReturnMap> =
  K extends keyof MethodReturnMap ? MethodReturnMap[K] : void;

export interface OnMethodArgumentMap {
  ConnectorsNames: undefined;
  ConnectorOnSetup: { connectorName: string };
  ModalList: undefined;
}

export interface OnMethodReturnMap {
  ConnectorsNames: string[];
  ConnectorOnSetup: void;
  ModalList: Map<string, JSX.Element>;
}

export type OnMethodArguments<K extends keyof OnMethodArgumentMap> =
  OnMethodArgumentMap[K];
export type OnMethodReturn<K extends keyof OnMethodReturnMap> =
  K extends keyof OnMethodReturnMap ? OnMethodReturnMap[K] : void;

export interface ComponentArgumentMap {
  ComponentTest: undefined;
  ComponentTest2: undefined;
}

export interface ActualPlugin {
  name: string;
  version: string;
  availableThemes?: () => string[];
  getThemeIcon?: (themeName: string, properties?: CSSProperties) => JSX.Element;
  getThemeSchema?: (themeName: string) => ThemeDefinition;
  uninstall: (db: IDBDatabase) => void;
  hooks: {
    beforeMethod?: {
      [K in keyof MethodArgumentMap]?: MethodArgumentMap[K] extends undefined
        ? () => MethodReturn<K>
        : (arg: MethodArguments<K>) => MethodReturn<K>;
    };
    afterMethod?: {
      [K in keyof MethodArgumentMap]?: MethodArgumentMap[K] extends undefined
        ? () => MethodReturn<K>
        : (arg: MethodArguments<K>) => MethodReturn<K>;
    };
    onMethod?: {
      [T in keyof OnMethodArgumentMap]?: OnMethodArgumentMap[T] extends undefined
        ? () => OnMethodReturn<T>
        : (arg: OnMethodArguments<T>) => OnMethodReturn<T>;
    };
    components?: {
      [T in keyof ComponentArgumentMap]?: ComponentArgumentMap[T] extends undefined
        ? () => JSX.Element
        : (
            arg: ComponentArgumentMap<T>,
          ) => JSX.Element;
    };
  };
}

export type ActualPluginInitalized = {
  initalized: true;
  renderComponent?: {
    [T in keyof ComponentArgumentMap]?: ComponentArgumentMap[T] extends undefined
      ? (container: HTMLDivElement) => JSX.Element
      : (container: HTMLDivElement, arg: ComponentArgumentMap<T>) => JSX.Element;
  };
} & ActualPlugin;
