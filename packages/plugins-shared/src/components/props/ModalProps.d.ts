import { type Modal as ReactAriaModal } from 'react-aria-components';
import {
    type ComponentPropsWithRef,
    type CSSProperties,
} from 'react';

export type ActualPluginModalProps = ComponentPropsWithRef<typeof ReactAriaModal> & {
    name: string;
    isLoading?: boolean;
    noAnimation?: boolean;
    style?: CSSProperties;
    onClose?: () => void;
    containerProps?: {
        style?: CSSProperties;
    };
};

