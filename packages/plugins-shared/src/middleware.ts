import ReactDOM from 'react-dom/client';
import { createPortal } from 'react-dom';
import {
  ActualPlugin,
  ActualPluginInitalized,
} from './interfaces/actualPlugin';

var root = null;
var containerToDraw = null;
export function initializePlugin(plugin: ActualPlugin): ActualPluginInitalized {
  const initializedPlugin: ActualPluginInitalized = {
    ...plugin,
    initalized: true,
    renderComponent: {},
  };

  Object.entries(plugin.hooks?.components || {}).forEach(([hookName]) => {
    const container = document.createElement('div');
    //const shadowRoot = container.attachShadow({ mode: 'open' });
    const shadowRoot = container;
    document.body.appendChild(container);
    initializedPlugin.renderComponent[hookName] = (divContainer, params) => {
      if (root === null || containerToDraw !== divContainer) {
        root = ReactDOM.createRoot(divContainer);
        containerToDraw = divContainer;
      }
      const componentToDraw = plugin.hooks.components[hookName]?.(params);
      //root.render(createPortal(componentToDraw, shadowRoot));
      root.render(componentToDraw);
      console.log(divContainer);
      return '';
    };
  });

  return initializedPlugin;
}
