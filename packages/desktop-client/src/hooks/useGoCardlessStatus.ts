import { useEffect, useState } from 'react';

import { send } from 'loot-core/platform/client/fetch';

import { useMetadataPref } from './useMetadataPref';
import { useSyncServerStatus } from './useSyncServerStatus';

export function useGoCardlessStatus() {
  const [configuredGoCardless, setConfiguredGoCardless] = useState<
    boolean | null
  >(null);
  const [budgetSpecific, setBudgetSpecific] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [cloudFileId] = useMetadataPref('cloudFileId');
  const status = useSyncServerStatus();

  useEffect(() => {
    async function fetch() {
      setIsLoading(true);

      const response = await send('gocardless-status', cloudFileId as string);

      if (response.error) {
        setConfiguredGoCardless(false);
        setBudgetSpecific(false);
      } else {
        setConfiguredGoCardless(response.data?.configured || false);
        setBudgetSpecific(response.data?.budgetSpecific || false);
      }

      setIsLoading(false);
    }

    if (status === 'online') {
      fetch();
    }
  }, [status, cloudFileId]);

  return {
    configuredGoCardless,
    budgetSpecific,
    isLoading,
  };
}
