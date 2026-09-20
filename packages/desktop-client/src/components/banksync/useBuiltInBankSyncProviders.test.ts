import { send } from '@actual-app/core/platform/client/connection';
import { renderHook, waitFor } from '@testing-library/react';

import { useFeatureFlag } from '#hooks/useFeatureFlag';
import { useSyncServerStatus } from '#hooks/useSyncServerStatus';

import {
  getPermissionWarning,
  useBuiltInBankSyncProviders,
} from './useBuiltInBankSyncProviders';

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: vi.fn(async () => ({ configured: true, source: 'global' })),
}));
vi.mock('#redux', () => ({ useDispatch: () => vi.fn() }));
vi.mock('#hooks/useCurrentAccess', () => ({
  useCurrentAccess: () => ({ isAdmin: false, isFileOwner: false }),
}));
vi.mock('#hooks/useFeatureFlag', () => ({ useFeatureFlag: vi.fn() }));
vi.mock('#hooks/useSyncServerStatus', () => ({
  useSyncServerStatus: vi.fn(() => 'no-server'),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test.each([false, true])(
  'offers local WASM providers with Akahu flag %s',
  async akahuEnabled => {
    vi.stubEnv('REACT_APP_BANK_SYNC_RUNTIME', 'wasm');
    vi.mocked(useSyncServerStatus).mockReturnValue('no-server');
    vi.mocked(useFeatureFlag).mockImplementation(flag =>
      flag === 'akahuBankSync' ? akahuEnabled : true,
    );

    const { result } = renderHook(() => useBuiltInBankSyncProviders());
    expect(result.current.providers.map(provider => provider.id)).toEqual(
      akahuEnabled
        ? ['simpleFin', 'pluggyai', 'akahu']
        : ['simpleFin', 'pluggyai'],
    );
    expect(result.current.syncServerStatus).toBe('online');
    expect(result.current.permissionWarning).toBeNull();
    for (const provider of result.current.providers) {
      expect(provider.canConfigure).toBe(true);
      expect(provider.supportsPerBudgetFile).toBe(false);
    }
    await waitFor(() => {
      expect(
        result.current.providers.every(provider => provider.isConfigured),
      ).toBe(true);
    });
    expect(send).toHaveBeenCalledWith('pluggyai-status');
    if (akahuEnabled) {
      expect(send).toHaveBeenCalledWith('akahu-status');
    } else {
      expect(send).not.toHaveBeenCalledWith('akahu-status');
    }
  },
);

test('keeps server permissions and providers in the normal runtime', async () => {
  vi.stubEnv('REACT_APP_BANK_SYNC_RUNTIME', '');
  vi.mocked(useSyncServerStatus).mockReturnValue('online');
  vi.mocked(useFeatureFlag).mockReturnValue(true);
  const { result } = renderHook(() => useBuiltInBankSyncProviders());
  expect(result.current.providers.map(provider => provider.id)).toEqual([
    'goCardless',
    'simpleFin',
    'pluggyai',
    'akahu',
    'enableBanking',
  ]);
  expect(
    result.current.providers.every(provider => !provider.canConfigure),
  ).toBe(true);
  expect(result.current.permissionWarning).toBe('general');
  await waitFor(() =>
    expect(result.current.providers[0].isConfigured).toBe(true),
  );
});

test.each([
  ['offline', true, true, null],
  ['no-server', false, false, null],
  ['online', true, false, null],
  ['online', false, false, 'general'],
  ['online', false, true, 'file-owner'],
] as const)(
  'returns the expected warning for %s connectivity, admin %s, owner %s',
  (status, isAdmin, isFileOwner, expected) => {
    expect(getPermissionWarning(status, isAdmin, isFileOwner)).toBe(expected);
  },
);
