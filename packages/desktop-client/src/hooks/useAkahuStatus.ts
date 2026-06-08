import { useEffect, useState } from 'react';

import { send } from '@actual-app/core/platform/client/connection';

import { useSyncServerStatus } from './useSyncServerStatus';

type AkahuStatusResponse = {
  configured?: boolean;
};

export function useAkahuStatus(fileId: string, enabled = true) {
  const [configuredAkahu, setConfiguredAkahu] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const status = useSyncServerStatus();

  useEffect(() => {
    if (!enabled || !fileId) return;

    async function fetch() {
      setIsLoading(true);

      const results = (await send('akahu-status', {
        fileId,
      })) as AkahuStatusResponse;

      setConfiguredAkahu(results.configured || false);
      setIsLoading(false);
    }

    if (status === 'online') {
      void fetch();
    }
  }, [status, fileId, enabled]);

  return {
    configuredAkahu,
    isLoading,
  };
}
