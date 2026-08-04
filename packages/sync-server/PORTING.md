# Sync Server Rust Port Map

This is the implementation map for [RUST_PORT_GOAL.md](RUST_PORT_GOAL.md). The
port preserves behavior first; cleanup and redesign wait until after the Rust
server is the only implementation.

The scope is the complete current sync-server. No route, provider, deployment
mode, configuration option, or internal behavior is dropped as allegedly dead
code during the port. Only after full parity and cutover may the Android host
isolate the subset of lifecycle/configuration surface it calls, or choose to
start the full server through a different adapter.

The Rust source tree preserves file and dependency identity wherever Rust's
module naming permits it. For example, `src/app.ts` maps to `rust/app.rs`,
`src/load-config.js` maps to `rust/load_config.rs`, `src/app-sync.ts` maps to
`rust/app_sync.rs`, and `src/app-simplefin/` maps to `rust/app_simplefin/`.
Files are not consolidated merely because they could be: maintainers should be
able to localize a behavior using the same route/module knowledge in either
language. External crates likewise keep the responsibility of the dependency
they replace (HTTP server, SQLite, protobuf, password hashing, HTTP/TLS) instead
of hiding multiple concerns behind a new framework layer.

| Current dependency role            | Rust dependency role                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| Express and middleware routing     | Axum routers, extractors, and narrowly scoped Tower middleware                  |
| `better-sqlite3`                   | `rusqlite` using the system/platform SQLite library                             |
| `argon2` and `bcrypt`              | Rust `argon2` and `bcrypt` crates with the existing hash formats and parameters |
| Buf protobuf runtime               | generated Rust protobuf types using the same schemas                            |
| Node `fetch` and provider SDK HTTP | one Rust HTTP client with Rust-native TLS                                       |
| Node filesystem/path APIs          | Rust standard-library filesystem and path APIs                                  |

## Runtime Boundary

One Rust core owns HTTP routing, authentication, persistence, synchronization,
bank-provider clients, configuration, and migrations. It produces:

- a standalone executable;
- a library entry point used by Electron;
- Android native libraries loaded by a thin JNI lifecycle adapter.

Every host supplies the same values: hostname, port, data directory, server
files directory, user files directory, web root, and environment configuration.
The core returns a handle that can report readiness and stop the listener.

Electron currently implements this boundary in
`packages/desktop-electron/index.ts:startSyncServer`: it binds to `127.0.0.1`,
uses port 5007 by default, passes the five `ACTUAL_*` path/listener variables,
waits for `server-started`, and kills the child on stop. The Rust adapter must
preserve those UI-visible lifecycle semantics without preserving Node's utility
process mechanism.

Capacitor currently has no server lifecycle integration:
`packages/mobile-client/android/app/src/main/java/org/actualbudget/MainActivity.java`
only extends `BridgeActivity`. Its adapter will load the Rust `cdylib`, start the
same core on loopback with app-private directories, wait for readiness before
configuring the web client, and stop it with the Android activity/application
lifecycle. No Android-specific route or provider implementation is allowed.

## Persistent Data

The formats are compatibility boundaries, not implementation details.

| Store            | Current location                     | Required Rust behavior                                                  |
| ---------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| Migration state  | `<dataDir>/.migrate`                 | Recognize and preserve the existing migration history                   |
| Account database | `<serverFiles>/account.sqlite`       | Open existing SQLite files and preserve tables, values, and constraints |
| Budget blobs     | `<userFiles>/file-<fileId>.blob`     | Preserve names and bytes exactly                                        |
| Sync databases   | `<userFiles>/group-<groupId>.sqlite` | Preserve `messages_binary` and `messages_merkles` behavior              |

The account schema is the ordered result of the eight files in `migrations/`:

- `auth(method, display_name, extra_data, active)`;
- `sessions(token, expires_at, user_id, auth_method)`;
- `files(id, group_id, sync_version, encrypt_meta, encrypt_keyid,
encrypt_salt, encrypt_test, deleted, name, owner)`;
- `secrets(name, value)`;
- `pending_openid_requests(state, code_verifier, return_url, expiry_time)`;
- `users(id, user_name, display_name, role, enabled, owner)`;
- `user_access(user_id, file_id)` with its composite primary key;
- `server_prefs(key, value)`.

Desktop Rust uses the system SQLite library. Android links the platform SQLite
library through the same Rust database layer; it does not ship
`better-sqlite3` or an Android-only database implementation.

## Protocol and HTTP Surfaces

`@actual-app/crdt` protobuf schemas define `/sync/sync`. Rust-generated types
must consume and produce the same binary fields, including unknown/default
protobuf behavior. The response content type remains
`application/actual-sync`, `X-ACTUAL-SYNC-METHOD` remains `simple`, the Merkle
JSON is byte-compatible, and message ordering remains timestamp order.

Route ownership maps mechanically as follows:

| TypeScript source                                           | Mounted routes                                                                                                                     | Rust module                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `src/app.ts`                                                | `/mode`, `/info`, `/health`, `/metrics`, static web and security headers                                                           | `rust/app.rs`                                                  |
| `src/app-account.js`, `src/accounts/*`, `src/account-db.js` | `/account/*`                                                                                                                       | `rust/app_account.rs`, `rust/accounts/*`, `rust/account_db.rs` |
| `src/app-admin.js`, `src/services/user-service.ts`          | `/admin/*`                                                                                                                         | `rust/app_admin.rs`, `rust/services/user_service.rs`           |
| `src/app-sync.ts`, `src/app-sync/*`, `src/sync-simple.js`   | `/sync/*`                                                                                                                          | `rust/app_sync.rs`, `rust/app_sync/*`, `rust/sync_simple.rs`   |
| `src/app-secrets.js`, `src/services/secrets-service.js`     | `/secret/*`                                                                                                                        | `rust/app_secrets.rs`, `rust/services/secrets_service.rs`      |
| `src/app-openid.ts`, `src/accounts/openid.ts`               | `/openid/*` and OpenID login                                                                                                       | `rust/app_openid.rs`, `rust/accounts/openid.rs`                |
| `src/app-simplefin/*`                                       | `/simplefin/status`, `/accounts`, `/transactions`                                                                                  | `rust/app_simplefin/*`                                         |
| `src/app-gocardless/*`                                      | `/gocardless/link`, `/status`, `/create-web-token`, `/get-accounts`, `/get-banks`, `/remove-account`, `/transactions`              | `rust/app_gocardless/*`                                        |
| `src/app-pluggyai/*`                                        | `/pluggyai/status`, `/accounts`, `/transactions`                                                                                   | `rust/app_pluggyai/*`                                          |
| `src/app-akahu/*`                                           | `/akahu/status`, `/accounts`, `/transactions`                                                                                      | `rust/app_akahu/*`                                             |
| `src/app-enablebanking/*`                                   | `/enablebanking/auth_callback`, `/status`, `/configure`, `/aspsps`, `/start-auth`, `/complete-auth`, `/poll-auth`, `/transactions` | `rust/app_enablebanking/*`                                     |
| `src/app-cors-proxy.js`, `src/util/ssrf.ts`                 | optional `/cors-proxy`                                                                                                             | `rust/app_cors_proxy.rs`, `rust/util/ssrf.rs`                  |

Status codes, JSON shapes, plain-text errors, headers, limits, rate limits,
redirects, and authorization checks are contract behavior. The Rust port does
not normalize inconsistencies such as existing `400` responses that might more
naturally be `404`.

## Authentication and Security

The compatibility boundary includes:

- Argon2id password hashes with the current parameters and verification of
  legacy bcrypt hashes;
- existing session tokens, expiration semantics, and password-session reuse;
- password, trusted-header, and OpenID login selection;
- `ADMIN` and `BASIC` permissions, ownership, and per-file access;
- global and per-budget secret authorization;
- trusted proxy and trusted auth-proxy CIDR behavior;
- SSRF address classification, DNS resolution, redirect revalidation, and
  cross-origin credential stripping;
- authentication and OpenID rate limits;
- CORS, COOP, COEP, and CSP response behavior.

Security checks remain in shared middleware/service functions so standalone,
Electron, and Android cannot diverge.

## Configuration

`src/load-config.js` is the source of truth during the port. Each key keeps its
current default, environment variable, accepted values, coercion, and validation.
The initial Rust configuration loader must accept the existing environment
variables; native hosts construct the same configuration directly and do not
invent a second set of settings.

TLS-capable HTTP clients use a Rust-native TLS stack so Android does not depend
on a separately packaged OpenSSL. Bank OAuth callbacks continue to use the
same external-browser URLs and server routes; Android lifecycle/deep-link work
is an adapter concern, not a provider fork.

## Contract Oracle

`contract/` is implementation-independent: tests communicate only through an
HTTP base URL and real upstream mock servers. It currently locks down:

- health, mode, build identity, process metrics shape, production static fallback,
  frontend security headers, and global CORS behavior;
- global 500/minute request limiting with trusted-proxy client selection and
  independent JSON, CRDT, and encrypted-file body limits;
- password bootstrap, validation, login methods, login, and server preferences;
- trusted-header login with direct-peer CIDR validation, plus authentication
  attempt rate-limit counts, rollback, headers, and rejection behavior;
- authentication failures;
- budget upload media-type behavior, metadata, listing, and byte-identical download;
- valid, missing-field, malformed, and non-empty CRDT protobuf exchanges,
  including byte persistence, timestamp ordering, duplicate suppression, and
  exact Merkle output;
- SimpleFIN token storage, claim exchange, credential forwarding, accounts, and
  transaction conversion;
- GoCardless unauthenticated callback page and authenticated credential status;
- Pluggy global credential status, SDK-equivalent authentication and token
  reuse, accounts, cursor pagination, transaction normalization, and exact
  fake-upstream request sequence;
- Akahu credential status, accounts, cursor pagination, pending/booked
  transactions, Auckland date conversion, balances, and SDK request headers;
- Enable Banking credential validation and persistence, RS256 application JWT,
  ASPSP lookup, authorization start/complete/callback/poll handoff, account
  balances, transaction pagination, normalization, and invalid-record filtering;
- CORS proxy enablement, preflight, session validation, repository allowlisting,
  private-address blocking, request-header filtering, JSON/text/binary responses,
  method rejection, and rate-limit headers;
- administrator user creation/update and budget access/ownership changes;
- OpenID discovery, PKCE authorization setup, signed OIDC token validation,
  userinfo exchange, redirect, and resulting session validation.

Run the current TypeScript oracle from the repository root:

```sh
yarn workspace @actual-app/sync-server test:contract:oracle
```

Run the same suite against an isolated Rust listener:

```sh
ACTUAL_CONTRACT_SERVER_URL=http://127.0.0.1:5006 \
  yarn workspace @actual-app/sync-server test:contract
```

The external target is deliberately restricted to loopback because the suite
bootstraps and mutates it.

## Mechanical Port Ledger

Each source moves as a reviewable unit. A row is complete only when it compiles,
its existing unit behavior is represented in Rust tests where useful, and its
observable behavior passes the shared contract suite.

| Source group                       | Rust destination                                                                                                                  | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| startup, configuration, HTTP shell | `app`, `load_config`, binary/library entry points                                                                                 | complete current configuration schema and environment mapping, health/mode/info/metrics shape, production static fallback and security headers, global CORS, trusted-proxy-aware 500/minute limiter, and content-type-specific body limits ported; shared shell/limit contracts passing; TLS, development proxy/websocket, allocator-specific metric values, and config-file differential coverage pending                                                                                                                           |
| database wrapper and migrations    | `db`, `migrations/*`                                                                                                              | eight timestamp-matched migration files implemented; Rust-to-TypeScript and TypeScript-to-Rust session, metadata, and byte-identical blob checks passing                                                                                                                                                                                                                                                                                                                                                                             |
| account, password, sessions        | `account_db`, `accounts::password`, `app_account`, `util::validate_user`                                                          | password and trusted-header bootstrap/login/validation/preferences contracts passing; five-attempt auth limiter contract passing; trusted forwarded-address behavior and initial OpenID bootstrap pending                                                                                                                                                                                                                                                                                                                            |
| sync files and CRDT                | `app_sync`, `app_sync/*`, `sync_simple`, generated CRDT types                                                                     | upload/list/info/download plus empty, malformed, missing-field, and non-empty protobuf contracts passing; byte persistence, timestamp ordering, duplicate suppression, content-type limits, and exact Merkle output covered; broader multi-client conflict and legacy database fixtures pending                                                                                                                                                                                                                                      |
| users, permissions, secrets        | `app_admin`, `services::user_service`, `app_secrets`, `services::secrets_service`                                                 | complete current admin/user/access route set ported; primary admin ownership and secrets contracts passing; complete authorization/error matrix pending                                                                                                                                                                                                                                                                                                                                                                              |
| OpenID                             | `app_openid`, `accounts::openid`                                                                                                  | enable/config/disable and authorization-code flow ported; signed OIDC discovery/PKCE/token/userinfo contract passing; initial OpenID bootstrap, direct-issuer, and rate-limit differential coverage pending                                                                                                                                                                                                                                                                                                                          |
| SimpleFIN                          | `app_simplefin/*`                                                                                                                 | status, token claim, accounts, and transactions ported; shared oracle contract passing; remaining error/redirect cases need differential coverage                                                                                                                                                                                                                                                                                                                                                                                    |
| GoCardless                         | `app_gocardless/*`                                                                                                                | all current routes and institution-specific bank normalizer files mechanically ported; callback/status/input-validation plus token, institution, requisition, account, balance, transaction, IBAN-hash, and deletion upstream differential contracts passing; production API client, token lifecycle, generic normalization, error mapping, and mirrored title/payee helper responsibilities ported; complete existing bank fixture coverage, failure/rate/fallback matrices, and legacy Unicode title-boundary verification pending |
| Pluggy.ai                          | `app_pluggyai/app_pluggyai`, `app_pluggyai/pluggyai_service`                                                                      | current status/accounts/transactions routes and SDK-equivalent auth, cached JWT, 429 retry, cursor pagination, account/transaction normalization, global/per-budget credential selection, and file authorization ported; shared fake-upstream oracle passing; remaining error, credit-account, sandbox, per-budget, and retry fixtures pending                                                                                                                                                                                       |
| Akahu                              | `app_akahu`                                                                                                                       | current status/accounts/transactions routes, global credentials, SDK-equivalent request/response envelope, refresh mutex/polling, cursor pagination, booked/pending normalization, JavaScript rounding, and IANA Auckland date conversion ported; shared fake-upstream oracle passing; refresh polling, failure, missing-account/balance, and malformed-date matrices pending                                                                                                                                                        |
| Enable Banking                     | `app_enablebanking/app_enablebanking`, `app_enablebanking/services/enablebanking_service`, `app_enablebanking/utils/{errors,jwt}` | current status/configure/ASPSP/auth callback/start/complete/poll/transactions routes, native RS256 application JWT, credential validation-before-persist, process-local auth handoff, PSU header filtering, balance/account/transaction normalization, pagination guard, and error mapping ported; shared fake-upstream oracle passing; timeout, API failure, public/trusted-proxy PSU, poll timeout/supersession/disconnect, and complete error matrices pending                                                                    |
| CORS proxy and SSRF                | `app_cors_proxy`, `util::ssrf`                                                                                                    | optional route, allowlist cache/matching, session validation, request filtering, response conversion, private-literal rejection, and per-peer limiter ported; shared fake-upstream oracle passing; rate-limit saturation, GitHub authorization, DNS, redirect, and failure matrices pending                                                                                                                                                                                                                                          |
| Electron adapter                   | desktop lifecycle integration                                                                                                     | not started                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Android adapter                    | JNI lifecycle integration                                                                                                         | not started                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

The trial order is HTTP shell, account bootstrap/login, one empty CRDT sync, and
SimpleFIN. These are architecture probes, not a reduced product scope. If any
trial cannot exactly satisfy the shared contract, dependency or architecture
choices are corrected before every remaining source group is mechanically
ported.
