import { useEffect, useState } from 'react';

import { send } from '@actual-app/core/platform/client/connection';

import { useSyncServerStatus } from './useSyncServerStatus';

export function useAkahuStatus(enabled = true) {
  const [configuredAkahu, setConfiguredAkahu] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const status = useSyncServerStatus();
  const isBankSyncWasm = import.meta.env.REACT_APP_BANK_SYNC_RUNTIME === 'wasm';

  useEffect(() => {
    if (!enabled) return;

    async function fetch() {
      setIsLoading(true);

      const results = await send('akahu-status');

      setConfiguredAkahu(results.configured || false);
      setIsLoading(false);
    }

    if (status === 'online' || isBankSyncWasm) {
      void fetch();
    }
  }, [status, enabled, isBankSyncWasm]);

  return {
    configuredAkahu,
    isLoading,
  };
}
