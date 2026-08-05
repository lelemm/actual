import * as asyncStorage from '#platform/server/asyncStorage';
import { post } from '#server/post';

import { app } from './app';
import {
  checkSimpleFinSecret,
  getSimpleFinAccounts,
  getSimpleFinStatus,
  setSimpleFinSecret,
} from './simplefin-wasm';

vi.mock('#server/post', () => ({
  del: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('./simplefin-wasm', () => ({
  checkSimpleFinSecret: vi.fn(),
  getSimpleFinAccounts: vi.fn(),
  getSimpleFinStatus: vi.fn(),
  isSimpleFinSecret: vi.fn(name => name.startsWith('simplefin_')),
  isSimpleFinWasmEnabled: vi.fn(() => true),
  setSimpleFinSecret: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(asyncStorage.getItem).mockResolvedValue('user-token');
});

it('routes SimpleFIN status and accounts through WASM', async () => {
  vi.mocked(getSimpleFinStatus).mockResolvedValue({ configured: true });
  vi.mocked(getSimpleFinAccounts).mockResolvedValue({ accounts: [] });

  await expect(app.handlers['simplefin-status']()).resolves.toEqual({
    configured: true,
  });
  await expect(app.handlers['simplefin-accounts']()).resolves.toEqual({
    accounts: [],
  });
  expect(post).not.toHaveBeenCalled();
});

it('stores and checks SimpleFIN secrets without authentication or HTTP', async () => {
  vi.mocked(asyncStorage.getItem).mockResolvedValue(undefined);
  vi.mocked(setSimpleFinSecret).mockResolvedValue({});
  vi.mocked(checkSimpleFinSecret).mockResolvedValue({ data: true });

  await expect(
    app.handlers['secret-set']({
      name: 'simplefin_token',
      value: 'setup-token',
    }),
  ).resolves.toEqual({});
  await expect(
    app.handlers['secret-check']('simplefin_token'),
  ).resolves.toEqual({ data: true });

  expect(setSimpleFinSecret).toHaveBeenCalledWith(
    'simplefin_token',
    'setup-token',
  );
  expect(checkSimpleFinSecret).toHaveBeenCalledWith('simplefin_token');
  expect(post).not.toHaveBeenCalled();
});

it('leaves other provider handlers on the HTTP path', async () => {
  vi.mocked(post).mockResolvedValue({ configured: true });

  await app.handlers['gocardless-status']();
  await app.handlers['akahu-status']();

  expect(post).toHaveBeenNthCalledWith(
    1,
    'https://test.env/gocardless/status',
    {},
    { 'X-ACTUAL-TOKEN': 'user-token' },
  );
  expect(post).toHaveBeenNthCalledWith(
    2,
    'https://test.env/akahu/status',
    {},
    { 'X-ACTUAL-TOKEN': 'user-token' },
  );
  expect(getSimpleFinStatus).not.toHaveBeenCalled();
  expect(getSimpleFinAccounts).not.toHaveBeenCalled();
});
