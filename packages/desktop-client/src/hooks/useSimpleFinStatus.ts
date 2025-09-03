import { useEffect, useState } from 'react';

import { send } from 'loot-core/platform/client/fetch';

import { useMetadataPref } from './useMetadataPref';
import { useSyncServerStatus } from './useSyncServerStatus';

export function useSimpleFinStatus() {
  const [configuredSimpleFin, setConfiguredSimpleFin] = useState<
    boolean | null
  >(null);
  const [budgetSpecific, setBudgetSpecific] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [cloudFileId] = useMetadataPref('cloudFileId');
  const status = useSyncServerStatus();

  useEffect(() => {
    async function fetch() {
      setIsLoading(true);

      const response = await send('simplefin-status', cloudFileId as string);

      if (response.error) {
        setConfiguredSimpleFin(false);
        setBudgetSpecific(false);
      } else {
        setConfiguredSimpleFin(response.data?.configured || false);
        setBudgetSpecific(response.data?.budgetSpecific || false);
      }

      setIsLoading(false);
    }

    if (status === 'online') {
      fetch();
    }
  }, [status, cloudFileId]);

  return {
    configuredSimpleFin,
    budgetSpecific,
    isLoading,
  };
}
