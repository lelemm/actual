import React, { useRef, useEffect, type CSSProperties } from 'react';

import { View } from '@actual-app/components/view';

import { type ActualPluginInitalized } from '../../../../plugins-core/src/types/actualPlugin';
import { useActualPlugins } from '../../plugin/ActualPluginsProvider';

type RenderPluginsComponentProps = {
  componentName: keyof ActualPluginInitalized['renderComponent'];
  componentArgs?: unknown;
  style?: CSSProperties;
};

export function RenderPluginsComponent({
  componentName,
  componentArgs = null,
  style = null,
}: RenderPluginsComponentProps) {
  const { plugins } = useActualPlugins();
  const pluginRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    plugins.forEach((plugin, index) => {
      const pluginRef = pluginRefs.current[index];
      if (pluginRef && plugin.renderComponent?.[componentName]) {
        const renderFn = plugin.renderComponent[componentName];

        if (componentArgs !== null) {
          (
            renderFn as (container: HTMLDivElement, arg: unknown) => JSX.Element
          )(pluginRef, componentArgs);
        } else {
          (renderFn as (container: HTMLDivElement) => JSX.Element)(pluginRef);
        }
      }
    });
  }, [plugins, pluginRefs, componentName, componentArgs]);

  return (
    <View style={{ flexGrow: 1, ...style }}>
      {plugins.map((_, index) => (
        <div key={index} ref={el => (pluginRefs.current[index] = el)} />
      ))}
    </View>
  );
}
