import { ComponentPropsWithoutRef, ForwardRefExoticComponent, ReactNode, RefAttributes } from 'react';
import { ActualPluginPermissions } from '../../contants/AuthPermissions';
import { Button as ReactAriaButton } from 'react-aria-components';

export type ActualPluginButtonProps = ComponentPropsWithoutRef<
  typeof ReactAriaButton
> & {
  variant?: ActualPluginButtonVariant;
  bounce?: boolean;
  children?: ReactNode;
  permission?: ActualPluginPermissions;
};

export type ActualPluginButtonVariant =
  | 'normal'
  | 'primary'
  | 'bare'
  | 'menu'
  | 'menuSelected';

export type ActualPluginButtonType = ForwardRefExoticComponent<
  ActualPluginButtonProps & RefAttributes<HTMLButtonElement>
>;
