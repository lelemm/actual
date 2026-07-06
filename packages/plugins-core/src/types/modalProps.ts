import type { CSSProperties, ReactNode } from 'react';

export type BasicModalProps = {
  title?: string;
  containerProps?: {
    style?: CSSProperties;
  };
  renderContent?: () => ReactNode;
};
