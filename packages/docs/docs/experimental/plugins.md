# Bank Sync Plugins

:::warning
This is an experimental feature. Back up your data before enabling plugins, and only install plugins from sources you trust.
:::

Actual currently supports installable plugins for bank sync providers. This first version is intentionally narrow: a plugin can provide sync-server routes for provider status, account discovery, transaction fetching, and secret storage. A plugin can also provide frontend setup or link screens for the bank sync flow.

Other plugin ideas, such as general CRUD access, query APIs, spreadsheet APIs, slots, themes, migrations, and dashboard widgets, are not part of this MVP.

## Enable Plugins

Plugins have two switches:

- The Actual client experimental feature flag controls whether the Plugins page and plugin frontend code load.
- The sync-server preference controls whether sync-server plugin processes load.

For frontend plugin code, enable the client feature flag:

1. In Actual, go to `Settings -> Show advanced settings -> Experimental features`.
2. Click `I understand the risks, show experimental features`.
3. Enable `Plugins`.

For sync-server plugins, enable plugins on the sync server and restart it:

```bash
yarn workspace @actual-app/sync-server enable-plugins
```

To disable sync-server plugins:

```bash
yarn workspace @actual-app/sync-server disable-plugins
```

Restart the sync server after either command. The sync server only loads plugins on startup.

## Install Plugins

After enabling the `Plugins` experimental feature, open `More -> Plugins`.

Use `Upload plugin manually` to choose a plugin `.zip` file. Actual reads `manifest.json` from the zip, validates it, and installs it according to its type:

- Frontend-only files are stored in the browser plugin store.
- Sync-server and mixed plugins are uploaded to the configured sync server through `/plugins-api/install`.

Sync-server and mixed plugins require a configured sync server. The install endpoint requires admin access.

The zip must contain `manifest.json`. Frontend files must be under `frontend/`, and sync-server files must be under `syncserver/`.

Sync-server plugins can also be installed by placing a plugin directory or zip file in:

```text
<ACTUAL_SERVER_FILES>/plugins
```

If `ACTUAL_SERVER_FILES` is not set, it defaults to:

```text
<ACTUAL_DATA_DIR>/server-files/plugins
```

Restart the sync server after adding or removing files in this folder.

## Bank Sync Routes

Bank sync plugins declare their sync-server routes in `manifest.json`. The host maps those routes to Actual's bank sync flow.

The supported bank sync endpoints are:

```text
GET  /plugins-api/bank-sync/list
GET  /plugins-api/bank-sync/:providerSlug/status
POST /plugins-api/bank-sync/:providerSlug/status
POST /plugins-api/bank-sync/:providerSlug/accounts
POST /plugins-api/bank-sync/:providerSlug/transactions
POST /plugins-api/bank-sync/:providerSlug/secret
```

Provider-specific routes can also be called through:

```text
/plugins-api/bank-sync/:providerSlug/<route>
```

Plugin routes can require `anonymous`, `authenticated`, or `admin` access. If a route omits `auth`, it defaults to authenticated access.

The plugin server entry must export a named `plugin` value. Routes are defined with the Actual-owned sync-server plugin contract, not with Express:

```ts
import {
  defineSyncServerPlugin,
  json,
  route,
} from '@actual-app/plugins-core-sync-server/plugin';

export const plugin = defineSyncServerPlugin({
  routes: [
    route('GET', '/status', async request => {
      return json({
        configured: (await request.secrets.get('token')) != null,
      });
    }),

    route('POST', '/configure', async request => {
      const body = await request.json<{ token: string }>();
      await request.secrets.save('token', body.token);
      return json({ configured: true });
    }),
  ],
});
```

The manifest remains the permission allowlist. If a route is not declared in the manifest, the host rejects it before calling the plugin.

## Manifest

Every plugin must include `manifest.json`.

```json
{
  "name": "example-bank-sync",
  "version": "0.0.1",
  "description": "Example bank sync plugin",
  "author": "Example Author",
  "type": "mixed",
  "frontend": {
    "entry": "frontend/mf-manifest.json"
  },
  "syncserver": {
    "entry": "syncserver/index.js",
    "routes": [
      {
        "path": "/status",
        "methods": ["GET", "POST"],
        "auth": "authenticated"
      }
    ],
    "bankSync": {
      "enabled": true,
      "displayName": "Example Bank",
      "description": "Link accounts with Example Bank.",
      "requiresAuth": true,
      "setup": {
        "type": "plugin"
      },
      "endpoints": {
        "status": "/status",
        "accounts": "/accounts",
        "transactions": "/transactions"
      }
    }
  }
}
```

The `type` field can be `frontend`, `syncserver`, or `mixed`.

## Provider Responses

Status endpoints return whether the provider is configured:

```json
{
  "status": "ok",
  "data": {
    "configured": true
  }
}
```

Account endpoints return external accounts that can be linked:

```json
{
  "status": "ok",
  "data": {
    "accounts": [
      {
        "account_id": "external-account-1",
        "name": "Checking",
        "institution": "Example Bank",
        "balance": 1000
      }
    ]
  }
}
```

Transaction endpoints return provider transactions for a linked account:

```json
{
  "status": "ok",
  "data": {
    "transactions": {
      "booked": [],
      "pending": []
    }
  }
}
```

## Secrets

Bank sync provider credentials should be stored through the route request `secrets` helper.

Secrets are scoped by plugin and budget file. The host passes the budget file id to plugin requests and applies that scope when `request.secrets.get` or `request.secrets.save` is called.

```ts
route('POST', '/configure', async request => {
  const body = await request.json<{ token: string }>();
  await request.secrets.save('token', body.token);
  return json({ configured: true });
});
```

## Frontend Setup

A mixed bank sync plugin can register frontend setup or link screens. The host loads the plugin frontend entry through Module Federation and renders those screens from the bank sync flow.

The frontend contract is currently limited to bank sync setup and link registration. General UI extension points are future work.

## Build A Plugin

The repository includes small provider plugin packages that show the supported MVP shape:

- `packages/sync-server-plugin-example`
- `packages/bank-sync-plugin-gocardless`
- `packages/bank-sync-plugin-simplefin`
- `packages/bank-sync-plugin-pluggy.ai`
- `packages/bank-sync-plugin-enablebanking`

Each provider package builds a zip containing `manifest.json`, frontend assets when present, and sync-server code.
