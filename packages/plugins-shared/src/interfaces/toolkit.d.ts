import { ActualPluginModalProps } from '../components/props/ModalProps';
import { ReactNode } from 'react';

export type ActualPluginToolkitCommonComponents = {
  Modal: ({
    children,
    props,
  }: {
    children: ReactNode;
    props: ActualPluginModalProps;
  }) => JSX.Element;
  Button: (content: JSX.Element, props: any) => JSX.Element;
};

export type ActualPluginToolkitFunctions = {
  pushModal: (modalName: `plugin-${string}`) => void;
};

export type ActualPluginToolkit = {
  commonComponents: ActualPluginToolkitCommonComponents;
  functions: ActualPluginToolkitFunctions;
};
