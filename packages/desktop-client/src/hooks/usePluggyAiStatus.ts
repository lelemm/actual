import { useEffect, useState } from 'react';

import { send } from 'loot-core/platform/client/fetch';

import { useMetadataPref } from './useMetadataPref';
import { useSyncServerStatus } from './useSyncServerStatus';

export function usePluggyAiStatus() {
  const [configuredPluggyAi, setConfiguredPluggyAi] = useState<boolean | null>(
    null,
  );
  const [budgetSpecific, setBudgetSpecific] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [cloudFileId] = useMetadataPref('cloudFileId');
  const status = useSyncServerStatus();

  useEffect(() => {
    async function fetch() {
      setIsLoading(true);

      const response = await send('pluggyai-status', cloudFileId as string);

      console.log('response', response);
      if (response.error) {
        setConfiguredPluggyAi(false);
        setBudgetSpecific(false);
      } else {
        setConfiguredPluggyAi(response.configured || false);
        setBudgetSpecific(response.budgetSpecific || false);
      }

      setIsLoading(false);
    }

    if (status === 'online') {
      fetch();
    }
  }, [status, cloudFileId]);

  return {
    configuredPluggyAi,
    budgetSpecific,
    isLoading,
  };
}
