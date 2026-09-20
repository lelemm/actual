import type { BankSyncProviders } from '@actual-app/core/types/models';

export function isWasmBankSyncProvider(
  provider: BankSyncProviders | null | undefined,
) {
  return (
    provider === 'simpleFin' || provider === 'pluggyai' || provider === 'akahu'
  );
}
