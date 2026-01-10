import { useBankSyncStatus } from './useBankSyncStatus';

export function usePluggyAiStatus() {
  const { configured, isLoading } = useBankSyncStatus('pluggy-bank-sync');

  return {
    configuredPluggyAi: configured,
    isLoading,
  };
}
