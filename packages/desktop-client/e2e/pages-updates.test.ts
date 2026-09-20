import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

import { expect, test } from '@playwright/test';

test('offers a Pages update and reloads only after accepting it', async ({
  page,
}) => {
  test.skip(process.env.E2E_WASM !== 'true', 'Requires the Pages WASM build');

  const root = path.resolve(__dirname, '../build');
  let revision = 1;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const file = path.resolve(
      root,
      url.pathname.replace(/^\/actual\//, '') || 'index.html',
    );
    if (!file.startsWith(`${root}${path.sep}`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const contents = await readFile(file);
      const types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.wasm': 'application/wasm',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
      };
      // Like GitHub Pages, this server supplies no isolation headers.
      response.setHeader(
        'Content-Type',
        types[path.extname(file)] ?? 'application/octet-stream',
      );
      response.setHeader('Cache-Control', 'no-cache');
      response.end(
        url.pathname.endsWith('/pages-sw.js')
          ? `${contents.toString()}\n// Deployment ${revision}\n`
          : contents,
      );
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing test server address');
  }

  try {
    await page.goto(`http://127.0.0.1:${address.port}/actual/`);
    await page.getByText('Try the demo', { exact: true }).click();
    await expect(page.getByTestId('budget-table')).toBeVisible();
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

    const originalLoad = await page.evaluate(() => performance.timeOrigin);
    revision = 2;
    // Returning to the tab should check for a deployment, without a reload.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(
      page.getByText('A new version of Actual is available!', { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(
      originalLoad,
    );
    expect(
      await page.evaluate(async () =>
        Boolean((await navigator.serviceWorker.ready).waiting),
      ),
    ).toBe(true);

    await Promise.all([
      page.waitForEvent('domcontentloaded'),
      page.getByRole('button', { name: 'Update now', exact: true }).click(),
    ]);
    await expect(page.getByTestId('budget-table')).toBeVisible();
    expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
      originalLoad,
    );
    await expect(
      page.getByRole('button', { name: 'Update now', exact: true }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(
      await page.evaluate(async () =>
        Boolean((await navigator.serviceWorker.ready).waiting),
      ),
    ).toBe(false);
  } finally {
    await page.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  }
});
