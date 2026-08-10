import { useEffect, useState } from 'react';

import { send } from '@actual-app/core/platform/client/connection';

import { useSyncServerStatus } from './useSyncServerStatus';

export function useSimpleFinStatus() {
  const isSimpleFinWasm =
    import.meta.env.REACT_APP_BANK_SYNC_RUNTIME === 'wasm';
  const [configuredSimpleFin, setConfiguredSimpleFin] = useState<
    boolean | null
  >(null);
  const [isLoading, setIsLoading] = useState(false);
  const status = useSyncServerStatus();

  useEffect(() => {
    async function fetch() {
      setIsLoading(true);

      const results = await send('simplefin-status');

      setConfiguredSimpleFin(results.configured || false);
      setIsLoading(false);
    }

    if (status === 'online' || isSimpleFinWasm) {
      void fetch();
    }
  }, [isSimpleFinWasm, status]);

  return {
    configuredSimpleFin,
    isLoading,
  };
}
