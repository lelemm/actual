import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('isolates local assets and app navigation without intercepting bank requests', async () => {
  let onFetch:
    | ((event: Pick<FetchEvent, 'request' | 'respondWith'>) => void)
    | undefined;
  vi.stubGlobal('self', {
    location: { origin: 'https://example.test' },
    registration: { scope: 'https://example.test/actual/' },
    addEventListener(name: string, listener: typeof onFetch) {
      if (name === 'fetch') onFetch = listener;
    },
  });
  const fetch = vi.fn(async () => new Response('asset', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await import('./pages-service-worker');
  if (!onFetch) throw new Error('Fetch listener was not registered');

  const respondWith = vi.fn();
  const request = new Request('https://example.test/actual/worker.js');
  onFetch({ request, respondWith });
  const response: Response = await respondWith.mock.calls[0][0];
  expect(fetch).toHaveBeenLastCalledWith(request);
  expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe(
    'same-origin',
  );
  expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe(
    'require-corp',
  );
  expect(await response.text()).toBe('asset');

  const navigation = new Request('https://example.test/actual/budget');
  Object.defineProperty(navigation, 'mode', { value: 'navigate' });
  onFetch({ request: navigation, respondWith });
  await respondWith.mock.calls[1][0];
  expect(fetch).toHaveBeenLastCalledWith(
    new URL('https://example.test/actual/index.html'),
  );

  onFetch({
    request: new Request('https://api.akahu.io/v1/accounts'),
    respondWith,
  });
  expect(respondWith).toHaveBeenCalledTimes(2);
});
