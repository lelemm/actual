import { useEffect, useState } from 'react';

import { send } from 'loot-core/platform/client/fetch';

import { useMetadataPref } from './useMetadataPref';
import { useSyncServerStatus } from './useSyncServerStatus';

export function useGoCardlessStatus() {
  const [configuredGoCardless, setConfiguredGoCardless] = useState<
    boolean | null
  >(null);
  const [isLoading, setIsLoading] = useState(false);
  const status = useSyncServerStatus();
  const [fileId] = useMetadataPref('cloudFileId');

  useEffect(() => {
    async function fetch() {
      setIsLoading(true);

      const results = await send('gocardless-status', { fileId: fileId ?? '' });

      setConfiguredGoCardless(results.configured || false);
      setIsLoading(false);
    }

    if (status === 'online') {
      fetch();
    }
  }, [status, fileId]);

  return {
    configuredGoCardless,
    isLoading,
  };
}
