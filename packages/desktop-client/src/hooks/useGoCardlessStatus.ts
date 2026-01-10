import { useBankSyncStatus } from './useBankSyncStatus';

export function useGoCardlessStatus() {
  const { configured, isLoading } = useBankSyncStatus('gocardless-bank-sync');

  return {
    configuredGoCardless: configured,
    isLoading,
  };
}
