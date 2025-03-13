import { useCallback, useEffect } from 'react';

import { type ActualPlugin } from '../../../plugins-shared/src';
import { useActualPlugins } from '../components/ActualPluginsProvider';

type PluginHookRunner = {
  methodName: string;
  method: (args: unknown) => any;
  params?: unknown;
};

export function usePluginHooks(
  plugins: ActualPlugin[],
  methodName: string,
  method: (args: unknown) => any,
  params?: unknown,
) {
  useEffect(() => {
    const results: Map<ActualPlugin, unknown> = new Map();

    plugins.forEach(plugin => {
      results.set(plugin, plugin.hooks?.beforeMethod?.[methodName]?.(params));
    });

    const retFromMain = method(results);

    plugins.forEach(plugin => {
      plugin.hooks?.afterMethod?.[methodName]?.(
        params,
        retFromMain,
        results.get(plugin),
      );
    });
  }, [plugins, methodName, method]);
}

export function usePluginOnMethodHooks({
  methodName,
  method,
  params,
}: PluginHookRunner) {
  const { plugins } = useActualPlugins();

  useEffect(() => {
    const results: Map<ActualPlugin, unknown> = new Map();

    plugins.forEach(plugin => {
      results.set(plugin, plugin.hooks?.onMethod?.[methodName]?.(params));
    });

    method(results);
  }, [plugins, methodName, method]);
}

type PluginRunnerOptions = {
  methodName: string;
  mainMethod: () => any;
  params: unknown;
};

export function useRunOnMethodPluginHooks() {
  const { plugins } = useActualPlugins();

  const runHooks = useCallback(
    ({ methodName, mainMethod, params }: PluginRunnerOptions) => {
      plugins.forEach(plugin => {
        plugin.hooks?.beforeMethod?.[methodName]?.(params);
      });

      const result = mainMethod();

      plugins.forEach(plugin => {
        plugin.hooks?.onMethod?.[methodName]?.(result);
      });

      return result;
    },
    [plugins],
  );

  return runHooks;
}

export function useRunPluginHooks() {
  const { plugins } = useActualPlugins();

  const runHooks = useCallback(
    ({ methodName, mainMethod, params }: PluginRunnerOptions) => {
      plugins.forEach(plugin => {
        plugin.hooks?.beforeMethod?.[methodName]?.(params);
      });

      const result = mainMethod();

      plugins.forEach(plugin => {
        plugin.hooks?.afterMethod?.[methodName]?.(params, result);
      });

      return result;
    },
    [plugins],
  );

  return runHooks;
}

type AsyncPluginRunnerOptions = {
  methodName: string;
  mainMethod: () => Promise<any>;
  params: unknown;
};

export function useRunPluginHooksAsync() {
  const { plugins } = useActualPlugins();

  const runHooks = useCallback(
    async ({
      methodName,
      mainMethod,
      params,
    }: AsyncPluginRunnerOptions): Promise<any> => {
      for (const plugin of plugins) {
        const beforeMethod = plugin.hooks?.beforeMethod?.[methodName];
        if (beforeMethod) {
          await beforeMethod(params);
        }
      }

      const result = await mainMethod();

      for (const plugin of plugins) {
        const afterMethod = plugin.hooks?.afterMethod?.[methodName];
        if (afterMethod) {
          await afterMethod(result, params);
        }
      }

      return result;
    },
    [plugins],
  );

  return runHooks;
}
