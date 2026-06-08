import type { UserInfo } from './types';

export type SyncServerHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type SyncServerRoutePath = `/${string}`;

export type SyncServerPluginResponse = {
  status: number;
  headers?: Record<string, string | string[]>;
  body?: unknown;
};

export type SyncServerPluginResponseInit = {
  status?: number;
  headers?: Record<string, string | string[]>;
};

export type SyncServerPluginSecrets = {
  get: (key: string) => Promise<string | undefined>;
  save: (key: string, value: string) => Promise<void>;
};

type ExtractParamNames<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractParamNames<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

export type SyncServerRouteParams<Path extends string> = Record<
  ExtractParamNames<Path>,
  string
>;

export type SyncServerPluginRequest<
  Path extends SyncServerRoutePath = SyncServerRoutePath,
> = {
  method: SyncServerHttpMethod;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  body: unknown;
  params: SyncServerRouteParams<Path>;
  user?: UserInfo;
  pluginSlug?: string;
  fileId?: string;
  json: <Body = unknown>() => Promise<Body>;
  text: () => Promise<string>;
  secrets: SyncServerPluginSecrets;
};

export type SyncServerRouteHandler<
  Path extends SyncServerRoutePath = SyncServerRoutePath,
> = (
  request: SyncServerPluginRequest<Path>,
) => SyncServerPluginResponse | Promise<SyncServerPluginResponse>;

export type SyncServerRoute<
  Method extends SyncServerHttpMethod = SyncServerHttpMethod,
  Path extends SyncServerRoutePath = SyncServerRoutePath,
> = {
  method: Method;
  path: Path;
  handler: SyncServerRouteHandler<Path>;
};

export type SyncServerPlugin<
  Routes extends readonly SyncServerRoute[] = readonly SyncServerRoute[],
> = {
  routes: Routes;
};

export function route<
  const Method extends SyncServerHttpMethod,
  const Path extends SyncServerRoutePath,
>(
  method: Method,
  path: Path,
  handler: SyncServerRouteHandler<Path>,
): SyncServerRoute<Method, Path> {
  return { method, path, handler };
}

export function defineSyncServerPlugin<
  const Routes extends readonly SyncServerRoute[],
>({ routes }: { routes: Routes }): SyncServerPlugin<Routes> {
  const seenRoutes = new Set<string>();

  for (const pluginRoute of routes) {
    const routeKey = `${pluginRoute.method} ${pluginRoute.path}`;
    if (seenRoutes.has(routeKey)) {
      throw new Error(`Duplicate sync-server plugin route: ${routeKey}`);
    }
    seenRoutes.add(routeKey);
  }

  return { routes };
}

export function json(
  body: unknown,
  init: SyncServerPluginResponseInit = {},
): SyncServerPluginResponse {
  return {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
    body,
  };
}

export function text(
  body: string,
  init: SyncServerPluginResponseInit = {},
): SyncServerPluginResponse {
  return {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'text/plain',
      ...init.headers,
    },
    body,
  };
}

export function empty(
  init: SyncServerPluginResponseInit = {},
): SyncServerPluginResponse {
  return {
    status: init.status ?? 204,
    headers: init.headers,
  };
}
