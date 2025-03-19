import React, {
    useRef,
    useEffect,
    type CSSProperties,
    useLayoutEffect,
  } from 'react';
import { ActualPluginInitalized } from '../../../../plugins-core/src/types/actualPlugin';
import { useActualPlugins } from '../../plugin/ActualPluginsProvider';
import { View } from '@actual-app/components/view';
  
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
            const renderFn = plugin.renderComponent[componentName];

            if (componentArgs !== null) {
              (renderFn as (container: HTMLDivElement, arg: any) => JSX.Element)(
                pluginRef,
                componentArgs
              );
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
  
  export default RenderPluginsComponent;
  