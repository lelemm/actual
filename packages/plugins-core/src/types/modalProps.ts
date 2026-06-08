import type { CSSProperties, ReactNode } from 'react';

export type BasicModalProps = {
  isLoading?: boolean;
  noAnimation?: boolean;
  style?: CSSProperties;
  onClose?: () => void;
  title?: string;
  containerProps?: {
    style?: CSSProperties;
  };
  renderContent?: () => ReactNode;
};
