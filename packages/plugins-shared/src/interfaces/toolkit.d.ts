import { ComponentProps, ReactNode } from 'react';

export type ActualPluginToolkitCommonComponents = {
  Modal: (props: ActualPluginModalProps) => JSX.Element;
};

export type ActualPluginToolkitFunctions = {
  pushModal: (modalName: string) => void;
};

export type ActualPluginToolkit = {
  commonComponents: ActualPluginToolkitCommonComponents;
  functions: ActualPluginToolkitFunctions;
};
