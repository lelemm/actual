import { useEffect, useState } from 'react';

import { send } from 'loot-core/platform/client/fetch';

import { useMetadataPref } from './useMetadataPref';
import { useSyncServerStatus } from './useSyncServerStatus';

export function useSimpleFinStatus() {
  const [configuredSimpleFin, setConfiguredSimpleFin] = useState<
    boolean | null
  >(null);
  const [isLoading, setIsLoading] = useState(false);
  const status = useSyncServerStatus();
  const [fileId] = useMetadataPref('cloudFileId');

  useEffect(() => {
    async function fetch() {
      setIsLoading(true);

      const results = await send('simplefin-status', { fileId: fileId ?? '' });

      setConfiguredSimpleFin(results.configured || false);
      setIsLoading(false);
    }

    if (status === 'online') {
      fetch();
    }
  }, [status, fileId]);

  return {
    configuredSimpleFin,
    isLoading,
  };
}
