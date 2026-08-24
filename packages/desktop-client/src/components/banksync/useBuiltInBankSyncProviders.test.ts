import {
  getPermissionWarning,
  normalizePluggyAiBalance,
} from './useBuiltInBankSyncProviders';

test.each([
  [
    {
      type: 'BANK',
      balance: 27903.6,
      bankData: {
        automaticallyInvestedBalance: 55807.2,
        closingBalance: 27903.6,
      },
    },
    8371080,
  ],
  [
    {
      type: 'CREDIT',
      balance: 1234,
      bankData: { automaticallyInvestedBalance: 0, closingBalance: 0 },
    },
    123400,
  ],
  [
    {
      type: 'BANK',
      balance: 83710.79999999999,
      bankData: {
        automaticallyInvestedBalance: 0,
        closingBalance: 83710.79999999999,
      },
    },
    8371080,
  ],
] as const)(
  'normalizes a Pluggy.ai balance to integer cents',
  (account, expected) => {
    expect(normalizePluggyAiBalance(account)).toBe(expected);
  },
);

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
