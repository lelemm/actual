import * as asyncStorage from '#platform/server/asyncStorage';

import {
  checkSimpleFinSecret,
  getSimpleFinStatus,
  setSimpleFinSecret,
} from './simplefin-wasm';

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.mocked(asyncStorage.getItem).mockImplementation(async key =>
    values.get(key),
  );
  vi.mocked(asyncStorage.setItem).mockImplementation(async (key, value) => {
    values.set(key, String(value));
  });
  vi.mocked(asyncStorage.removeItem).mockImplementation(async key => {
    values.delete(key);
  });
});

it('persists SimpleFIN secrets locally', async () => {
  await setSimpleFinSecret('simplefin_token', 'setup-token');
  await expect(checkSimpleFinSecret('simplefin_token')).resolves.toEqual({
    data: true,
  });

  await setSimpleFinSecret('simplefin_token', null);
  await expect(checkSimpleFinSecret('simplefin_token')).resolves.toEqual({
    data: false,
  });
});

it('matches the server configured-token semantics', async () => {
  await expect(getSimpleFinStatus()).resolves.toEqual({ configured: false });

  values.set('simplefin_token', 'Forbidden: invalid claim');
  await expect(getSimpleFinStatus()).resolves.toEqual({ configured: false });

  values.set('simplefin_token', 'setup-token');
  await expect(getSimpleFinStatus()).resolves.toEqual({ configured: true });
});
