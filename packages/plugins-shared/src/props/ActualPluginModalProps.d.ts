import { Modal as ReactAriaModal } from 'react-aria-components';
import { ComponentPropsWithRef, CSSProperties } from 'react';

export type ModalProps = ComponentPropsWithRef<typeof ReactAriaModal> & {
  name: string;
  isLoading?: boolean;
  noAnimation?: boolean;
  style?: CSSProperties;
  onClose?: () => void;
  containerProps?: {
    style?: CSSProperties;
  };
};
