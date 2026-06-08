import { Component, useCallback, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Trans } from 'react-i18next';

import type { BasicModalProps } from '@actual-app/plugins-core/types/modalProps';

import { Modal } from '#components/common/Modal';
import { useFeatureFlag } from '#hooks/useFeatureFlag';

type PluginModalProps = {
  parameter: (container: HTMLDivElement) => void | (() => void);
  modalProps?: BasicModalProps;
};

export function PluginModal({ parameter, modalProps }: PluginModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pluginsEnabled = useFeatureFlag('plugins');
  const [pluginError, setPluginError] = useState<unknown>(null);

  const onPluginError = useCallback((error: unknown) => {
    setPluginError(error);
  }, []);

  useEffect(() => {
    if (!pluginsEnabled || !containerRef.current) {
      return;
    }

    try {
      return parameter(containerRef.current);
    } catch (error) {
      console.error('[plugins] Plugin mount failed', { error });
      onPluginError(error);
    }
  }, [onPluginError, parameter, pluginsEnabled]);

  return (
    <Modal
      name="plugin-modal"
      isLoading={modalProps?.isLoading}
      noAnimation={modalProps?.noAnimation}
      style={modalProps?.style}
      onClose={modalProps?.onClose}
      containerProps={modalProps?.containerProps}
    >
      {modalProps?.renderContent?.()}
      {pluginsEnabled && (
        <PluginErrorBoundary onError={onPluginError}>
          {pluginError ? null : <div ref={containerRef} />}
        </PluginErrorBoundary>
      )}
    </Modal>
  );
}

type PluginErrorBoundaryProps = {
  children: ReactNode;
  onError: (error: unknown) => void;
};

type PluginErrorBoundaryState = {
  error: unknown;
  hasError: boolean;
};

class PluginErrorBoundary extends Component<
  PluginErrorBoundaryProps,
  PluginErrorBoundaryState
> {
  state: PluginErrorBoundaryState = { error: null, hasError: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, hasError: true };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    console.error('[plugins] Plugin render failed', {
      error,
      componentStack: errorInfo.componentStack,
    });
    this.props.onError(error);
  }

  render() {
    if (this.state.hasError) {
      return <PluginErrorNotice error={this.state.error} />;
    }

    return this.props.children;
  }
}

function PluginErrorNotice({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    <div
      role="alert"
      style={{
        border: '1px solid #d97c7c',
        borderRadius: 4,
        color: '#8a1f1f',
        margin: 12,
        padding: 12,
      }}
    >
      <div style={{ fontWeight: 600 }}>
        <Trans>Plugin failed to render</Trans>
      </div>
      <pre style={{ fontSize: 12, margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>
        {message}
      </pre>
    </div>
  );
}
