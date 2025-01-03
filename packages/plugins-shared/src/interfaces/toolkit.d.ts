import { ActualPluginButtonProps } from '../components/props/ButtonProps';
import { ActualPluginModalProps } from '../components/props/ModalProps';
import { ReactNode } from 'react';

export type ActualPluginToolkitCommonComponents = {
  Modal: (props: ActualPluginModalProps) => JSX.Element;
  Button: (props: ActualPluginButtonProps) => JSX.Element;
};

export type ActualPluginToolkitFunctions = {
  pushModal: (modalName: string) => void;
};

export type ActualPluginToolkit = {
  commonComponents: ActualPluginToolkitCommonComponents;
  functions: ActualPluginToolkitFunctions;
};
