import { useCallback, useEffect, useMemo, useState } from 'react';

import { send } from 'loot-core/platform/client/fetch';

import { useSyncServerStatus } from '@desktop-client/hooks/useSyncServerStatus';
import { type BankSyncProvider } from '@desktop-client/hooks/useBankSyncProviders';

type ScopeStatus = {
  configured: boolean;
  error?: string;
};

export type ProviderStatusMap = Record<
  string,
  {
    global: ScopeStatus;
    file: ScopeStatus;
  }
>;

export function useProviderStatusMap({
  providers,
  fileId,
}: {
  providers: BankSyncProvider[];
  fileId?: string;
}) {
  const syncServerStatus = useSyncServerStatus();

  const providerSlugsKey = useMemo(
    () => providers.map(p => p.slug).sort().join('|'),
    [providers],
  );

  const [statusMap, setStatusMap] = useState<ProviderStatusMap>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refetchToken, setRefetchToken] = useState(0);

  const refetch = useCallback(() => {
    setRefetchToken(x => x + 1);
  }, []);

  useEffect(() => {
    if (syncServerStatus !== 'online') {
      return;
    }

    let didCancel = false;

    async function load() {
      setIsLoading(true);
      setError(null);

      try {
        const entries = await Promise.all(
          providers.map(async provider => {
            const [globalResult, fileResult] = await Promise.all([
              send('bank-sync-status', { providerSlug: provider.slug }).catch(
                err => ({
                  configured: false,
                  error: err instanceof Error ? err.message : String(err),
                }),
              ),
              fileId
                ? send('bank-sync-status', {
                    providerSlug: provider.slug,
                    fileId,
                  }).catch(err => ({
                    configured: false,
                    error: err instanceof Error ? err.message : String(err),
                  }))
                : Promise.resolve({ configured: false }),
            ]);

            return [
              provider.slug,
              {
                global: {
                  configured: Boolean((globalResult as any)?.configured),
                  error: (globalResult as any)?.error,
                },
                file: {
                  configured: Boolean((fileResult as any)?.configured),
                  error: (fileResult as any)?.error,
                },
              },
            ] as const;
          }),
        );

        if (!didCancel) {
          setStatusMap(Object.fromEntries(entries));
        }
      } catch (err) {
        if (!didCancel) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!didCancel) {
          setIsLoading(false);
        }
      }
    }

    load();

    return () => {
      didCancel = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerSlugsKey, fileId, syncServerStatus, refetchToken]);

  return { statusMap, isLoading, error, refetch };
}

