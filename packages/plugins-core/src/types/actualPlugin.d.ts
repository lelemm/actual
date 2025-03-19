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

export interface ComponentArgumentMap {
  ComponentTest: undefined;
  ComponentTest2: {
    helloworld: string;
  };
}

export type MethodArguments<K extends keyof MethodArgumentMap> =
  MethodArgumentMap[K];
export type MethodReturn<K extends keyof MethodReturnMap> =
  K extends keyof MethodReturnMap ? MethodReturnMap[K] : void;

export type OnMethodArguments<K extends keyof OnMethodArgumentMap> =
  OnMethodArgumentMap[K];
export type OnMethodReturn<K extends keyof OnMethodReturnMap> =
  K extends keyof OnMethodReturnMap ? OnMethodReturnMap[K] : void;

export interface ActualPlugin {
  name: string;
  version: string;
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
      [T in keyof ComponentArgumentMap]?: (
        arg: ComponentArgumentMap[T] extends undefined
          ? never
          : ComponentArgumentMap[T],
      ) => JSX.Element;
    };
  };
}

export type ActualPluginInitalized = {
  initalized: true;
  renderComponent?: {
    [T in keyof ComponentArgumentMap]?: (
      container: HTMLDivElement,
      arg: ComponentArgumentMap[T] extends undefined
        ? never
        : ComponentArgumentMap[T],
    ) => JSX.Element;
  };
} & ActualPlugin;

export type MethodArgumentMap = Record<string, any>;
export type MethodReturnMap = Record<string, any>;
