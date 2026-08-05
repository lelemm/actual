# Rust Sync Server Migration Goal

## Goal

Replace the TypeScript/Node.js sync server with one behavior-compatible Rust
implementation used by standalone deployments, Electron, and Android.

The Android application must be self-contained and able to use bank sync
without a remote Actual server. The result must not create or retain a separate
Android bank-sync implementation.

Success means existing clients, databases, sync payloads, authentication flows,
and bank-provider integrations cannot distinguish the Rust server from the
current server, except for explicitly approved fixes.

## Non-Goals

- Redesigning HTTP APIs, error responses, storage layouts, or authentication.
- Creating an Android-only sync or bank-sync package.
- Treating any current sync-server route, provider, configuration option, or
  deployment mode as dead code and omitting it during the port.
- Refactoring into ideal or idiomatic Rust before compatibility is achieved.
- Changing the CRDT protocol or migration history.
- Keeping the TypeScript and Rust servers as permanent parallel products.
- Improving performance unless required to avoid a regression.

## Required Outputs

The same Rust core must build as:

- A standalone `actual-server` executable for normal hosting and Docker.
- A child executable for Electron.
- An Android native library loaded through a thin Capacitor/JNI adapter.

The standalone and Electron artifacts may wrap the core in HTTP. Capacitor may
call the same Rust handlers directly instead of starting a localhost server.
Only the transport adapter, lifecycle, secure-storage access, native networking,
and filesystem-path discovery may be platform-specific. Sync behavior,
secrets semantics, and bank-provider logic must remain shared.

The direct-call approach was validated by the SimpleFIN WASM trial documented
in [WASM_BANK_SYNC_TRIAL.md](./WASM_BANK_SYNC_TRIAL.md). It is a deployment
option for the shared Rust core, not a separate Android implementation and not
a reduction of the full server parity goal.

Start with one Rust crate unless a demonstrated dependency cycle requires a
split. During migration, Rust may live beside the TypeScript implementation in
this package. After cutover, remove the TypeScript server.

## Compatibility Invariants

- Preserve all HTTP methods, paths, status codes, headers, content types, and
  response bodies.
- Preserve all environment variable names and their effective defaults.
- Preserve SQLite schemas, migration order, and existing database readability.
- Preserve transaction boundaries and rollback behavior.
- Preserve file paths, file formats, and upload/download behavior.
- Preserve CRDT encodings, Merkle results, and encrypted binary payloads.
- Preserve Argon2 hashes and verification of legacy bcrypt hashes.
- Preserve OpenID and bank-provider redirect behavior.
- Preserve source-tree identity and dependency responsibility where Rust module
  naming permits it: a maintainer locating behavior from the TypeScript path
  should find the Rust equivalent at the corresponding path, with the same
  separation of routes, services, provider clients, normalizers, utilities,
  and tests. Do not consolidate unrelated files merely to make the Rust tree
  smaller.
- Do not add `todo!()`, placeholder handlers, silent defaults, skipped tests, or
  deleted tests to make the port pass.

## Migration Method

Follow a compatibility-first mechanical port, based on the approach described
in [Rewriting Bun in Rust](https://bun.com/blog/bun-in-rust):

1. Treat the current TypeScript server as the behavioral oracle.
2. Build a language-independent black-box contract suite before the full port.
3. Write a short `PORTING.md` mapping current TypeScript patterns to Rust.
4. Prove three representative vertical slices.
5. Port the remaining modules mechanically on a migration branch.
6. Use independent adversarial review to compare Rust with TypeScript.
7. Drive compilation, contract tests, and platform CI to green.
8. Ship a canary before making Rust the default.
9. Delete the TypeScript implementation after a successful cutover.
10. Only then refactor the Rust implementation.

## Phase 1: Behavioral Oracle

Create a black-box TypeScript contract runner that accepts a server base URL and
can run unchanged against either implementation.

Cover:

- Every HTTP route, including malformed and unauthorized requests.
- Authentication, permissions, sessions, and password changes.
- Binary sync, encrypted sync, file upload, and file download.
- Migrations from every historical schema represented in the repository.
- OpenID configuration and callbacks.
- Secret creation, lookup, reset, and per-file scoping.
- Every bank provider using deterministic local upstream fakes.
- Restart and persistence behavior.

Create golden fixtures for:

- CRDT message encoding and Merkle trees.
- Encrypted and unencrypted sync payloads.
- Argon2 and legacy bcrypt password verification.
- Account and message databases at relevant migration states.
- Migration state files and stored server files.

Provider tests must never depend on live bank services. They must assert the
outgoing method, URL, headers, body, pagination, timeout, and error mapping sent
to a local fake upstream.

## Phase 2: Porting Guide

Document the exact mapping used by the mechanical port, including:

| TypeScript/Node                     | Rust                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| Express routing                     | Axum routing                                             |
| Express middleware and `res.locals` | Axum layers and request extensions                       |
| `better-sqlite3`                    | `rusqlite`                                               |
| `Buffer`                            | `bytes::Bytes` or `Vec<u8>`                              |
| `fetch` and provider SDK traffic    | `reqwest`                                                |
| Convict configuration               | Typed configuration with identical environment variables |
| Argon2 and bcrypt addons            | Rust password-hash implementations                       |
| Winston logging                     | `tracing`                                                |
| Parent-process startup message      | Explicit startup callback/channel                        |

The guide must call out JavaScript/Rust semantic differences involving null and
missing values, number conversion, object ordering, time, error propagation,
transaction cleanup, and release-only behavior.

## Phase 3: Trial Slices

Port and prove these slices before committing to the full translation:

1. `/health` and `/info` for startup, configuration, and HTTP serving.
2. Account bootstrap/login for SQLite, migrations, Argon2, and sessions.
3. `/sync` for raw bodies, CRDT data, Merkle logic, transactions, and files.

Also port one provider against its fake upstream to validate the provider test
strategy. SimpleFIN is the default choice unless repository evidence supports a
better representative.

Stop and reassess if these slices cannot achieve exact contract compatibility.

## Phase 4: Mechanical Port

Keep Rust modules recognizable to maintainers familiar with the current server.
Use one-to-one source files by default and preserve imports as responsibility
relationships: shared TypeScript utilities become shared Rust utilities, while
route-specific logic stays in its route/provider subtree. A Rust-only split or
merge requires a concrete language constraint and an entry in the port ledger.
Maintain a ledger containing:

```text
source file | Rust file | compiles | unit parity | contract parity | reviewed
```

For each batch:

1. An implementer performs a mechanical port.
2. At least two independent reviewers compare it against the TypeScript source
   and assume the port is incorrect.
3. A fixer applies the review findings.
4. The affected contract group and compiler checks run again.

Fix the generation or review process when a repeated defect pattern appears;
do not repeatedly hand-patch the same class of generated mistake.

## Phase 5: Differential Verification

For each contract fixture, start TypeScript and Rust servers with isolated
temporary directories, send equivalent requests, and compare:

- HTTP responses.
- Logical SQLite schema and contents.
- Filesystem changes.
- Requests made to fake provider upstreams.
- Behavior after process restart.

Normalize only genuinely nondeterministic tokens, UUIDs, and timestamps. Do not
normalize ordering, missing fields, error classifications, or other observable
behavior.

Never run both implementations against the same writable data directory.

## Phase 6: Platform Verification

Before deleting TypeScript, verify supported desktop/server targets and:

- Android ARM64 on an emulator or device.
- Android x86-64 on an emulator.
- Startup and shutdown through JNI.
- Persistent data under the Android application data directory.
- A complete bank authorization flow, including leaving and returning to the
  application.
- A complete bank transaction synchronization.

If Android runs the HTTP wrapper, its adapter should expose only lifecycle
operations equivalent to:

```rust
pub fn start(config: ServerConfig) -> Result<ServerHandle>;
pub fn stop(handle: ServerHandle);
pub fn status(handle: &ServerHandle) -> ServerStatus;
```

If Android uses direct calls, expose only the bank-sync and secrets operations
needed by loot-core through a thin Capacitor/JNI bridge. Those operations must
delegate to the same Rust core used by the HTTP handlers.

## Cutover Criteria

- The complete black-box suite passes against both implementations.
- No compatibility test is skipped or deleted.
- Existing TypeScript tests remain green until cutover.
- Historical database fixtures upgrade successfully and retain their data.
- CRDT and encrypted payload golden vectors match exactly.
- All fake provider contracts pass.
- Standalone, Electron, and Android artifacts build in CI.
- Android completes bank authorization and transaction synchronization.
- Upgrade and rollback have been tested using copies of real data.
- Security review finds no unresolved high-severity issue.

Merging the port is not the production release. Publish canary artifacts first,
then make Rust the default, then remove the TypeScript implementation promptly
so fixes do not need to be maintained twice.

## Pre-Mortem

Assume the migration failed after six months: the Rust server worked for new
Android installations but rejected some existing databases, bank providers
behaved differently, and both implementations required ongoing maintenance.

The highest risks and required controls are:

| Risk                                         | Required control                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Existing tests are tied to Express internals | Build black-box contracts before porting                                                           |
| Provider SDK semantics are missed            | Assert exact traffic against fake upstreams                                                        |
| SQLite or CRDT compatibility diverges        | Historical fixtures, golden vectors, and differential state comparison                             |
| Android kills OAuth callbacks                | Test the full external-browser/app lifecycle and use an appropriate temporary service or deep link |
| Authentication is weakened for localhost     | Keep shared authentication behavior and conduct security review                                    |
| Generated code contains plausible stubs      | Reject placeholders and require adversarial source comparison                                      |
| The rewrite becomes a redesign               | Enforce the compatibility invariants and defer refactoring                                         |
| Both implementations remain indefinitely     | Define and enforce cutover and deletion criteria                                                   |
| Rust knowledge becomes a bottleneck          | Require maintainers to review representative modules before cutover                                |

## Completion Definition

This goal is complete only when Rust is the single maintained sync-server
implementation, standalone/Electron/Android artifacts use it, compatibility and
platform checks pass, and the TypeScript server implementation has been removed.
