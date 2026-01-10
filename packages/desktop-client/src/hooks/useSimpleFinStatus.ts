import { useBankSyncStatus } from './useBankSyncStatus';

export function useSimpleFinStatus() {
  const { configured, isLoading } = useBankSyncStatus('simplefin-bank-sync');

  return {
    configuredSimpleFin: configured,
    isLoading,
  };
}
