import { assertJsonSafe, SERVER_RPC_METHODS } from './rpc-methods';

describe('server RPC allowlist', () => {
  it('allows budget operations but excludes lifecycle and sync methods', () => {
    expect(SERVER_RPC_METHODS.has('getAccounts')).toBe(true);
    expect(SERVER_RPC_METHODS.has('runQuery')).toBe(true);
    expect(SERVER_RPC_METHODS.has('loadBudget')).toBe(false);
    expect(SERVER_RPC_METHODS.has('exportBudget')).toBe(false);
    expect(SERVER_RPC_METHODS.has('sync')).toBe(false);
    expect(SERVER_RPC_METHODS.has('runBankSync')).toBe(false);
    expect(SERVER_RPC_METHODS.has('batchBudgetUpdates')).toBe(false);
    expect(SERVER_RPC_METHODS.has('getServerVersion')).toBe(false);
  });

  it('rejects values that JSON cannot serialize', () => {
    expect(() => assertJsonSafe(1n)).toThrow();
  });
});
