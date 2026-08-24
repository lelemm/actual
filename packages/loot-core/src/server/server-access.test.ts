export {};

const { mockedFetch, mockedGetItem, mockedGetPrefs } = vi.hoisted(() => ({
  mockedFetch: vi.fn(),
  mockedGetItem: vi.fn(),
  mockedGetPrefs: vi.fn(),
}));

vi.unmock('#server/post');
vi.unmock('./post');

vi.mock('#platform/server/fetch', () => ({
  fetch: mockedFetch,
}));

vi.mock('#platform/server/asyncStorage', () => ({
  getItem: mockedGetItem,
}));

vi.mock('./prefs', () => ({
  getPrefs: mockedGetPrefs,
}));

describe('server access', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockedFetch.mockReset();
    mockedGetItem.mockReset().mockResolvedValue('session-token');
    mockedGetPrefs.mockReset().mockReturnValue({
      cloudFileId: 'budget-file-id',
      encryptKeyId: null,
    });

    const { setServer } = await import('./server-config');
    setServer('https://test.env');
  });

  it('authenticates the enable request with the current session', async () => {
    mockedFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'ok',
            data: {
              available: true,
              protocolVersion: 1,
              publicKey: 'unused-for-unencrypted-budget',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'ok',
            data: { requiresUpload: false },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const { enableServerAccess } = await import('./server-access');
    await enableServerAccess({ timeZone: 'UTC' });

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(mockedFetch.mock.calls[1][0]).toBe(
      'https://test.env/sync/enable-server-access',
    );
    expect(mockedFetch.mock.calls[1][1]?.headers).toMatchObject({
      'X-ACTUAL-TOKEN': 'session-token',
    });
  });
});
