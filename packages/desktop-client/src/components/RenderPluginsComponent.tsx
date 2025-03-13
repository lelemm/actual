import React, {
  useRef,
  useEffect,
  type CSSProperties,
  useLayoutEffect,
} from 'react';

import { type ActualPluginInitalized } from '../../../plugins-shared/src/interfaces/actualPlugin';

import { useActualPlugins } from './ActualPluginsProvider';
import { View } from './common/View';

type RenderPluginsComponentProps = {
  componentName: keyof ActualPluginInitalized['renderComponent'];
  componentArgs?: unknown;
  style?: CSSProperties;
};

function RenderPluginsComponent({
  componentName,
  componentArgs = null,
  style = null,
}: RenderPluginsComponentProps) {
  const { plugins } = useActualPlugins();
  const pluginRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    plugins.forEach((plugin, index) => {
      debugger;
      const pluginRef = pluginRefs.current[index];
      if (pluginRef && plugin.renderComponent?.[componentName]) {
        plugin.renderComponent[componentName](
          pluginRefs.current[index],
          componentArgs,
        );
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

export default RenderPluginsComponent;
