import type {
  ActualPlugin,
  ActualPluginInitialized,
  HostContext,
  PluginContext,
} from './types/actualPlugin';

export function initializePlugin(
  plugin: ActualPlugin,
): ActualPluginInitialized {
  const activate = plugin.activate;

  return {
    ...plugin,
    initialized: true,
    activate(context: HostContext) {
      activate(context as unknown as PluginContext);
    },
  };
}
