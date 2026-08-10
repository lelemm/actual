# SimpleFIN WASM Trial Notes

## Outcome

On 2026-08-05, the SimpleFIN WASM path completed a real bank sync without an
Actual sync server. This validates direct calls from loot-core to shared Rust
bank-sync logic as an alternative to running a local HTTP server.

The trial remains in the repository and runs with:

```sh
yarn start:wasm
```

`yarn build:wasm` produces the corresponding production UI build.

## Implemented Boundary

- Rust owns SimpleFIN token claiming, account retrieval, transaction retrieval,
  response normalization, and provider error mapping.
- The WASM exports delegate to the same `rust/app_simplefin/core.rs`
  implementation.
- loot-core loads the generated WASM module directly from `/bank-sync-wasm`.
- SimpleFIN setup token and access key use loot-core async storage in WASM mode.
- No fake HTTP server, synthetic HTTPS endpoint, or service worker transport is
  involved.
- Normal builds retain the existing HTTP path and all non-SimpleFIN providers.
- WASM mode exposes only SimpleFIN in the no-server UI and filters sync requests
  so other providers cannot be invoked accidentally.

Generated WASM assets are intentionally ignored. The build script compiles and
stages them into `packages/desktop-client/generated/bank-sync-wasm`.

## Verification

- A real SimpleFIN bank sync succeeded through the WASM path.
- `yarn build:wasm` completed successfully.
- The development server returned the UI, loot-core worker, JavaScript loader,
  and WASM binary successfully; the binary used `application/wasm`.
- Native and WASM Rust checks passed.
- Focused Rust, loot-core, and desktop-client tests passed.
- Normal native/HTTP behavior remains the default build configuration.

## Capacitor Direction

Capacitor does not need to start the full Axum server merely to use bank sync.
The Android artifact can expose the same Rust core through a thin Capacitor/JNI
bridge and let loot-core select a direct-call platform implementation.

The likely Android boundary is:

- native Rust networking for provider requests;
- encrypted app storage for bank credentials, protected by a non-exportable key
  backed by Android Keystore and exposed through the Capacitor bridge;
- direct bank-sync calls returning the same logical data as the HTTP handlers;
- no listening socket and no localhost authentication layer.

The Rust core should receive a credential only for the duration of the direct
call. It should not own a second Android credential database or persist the
plaintext value itself.

This preserves one implementation of SimpleFIN behavior. The HTTP adapter for
standalone/Electron, the WASM adapter for this trial, and the future Android
adapter are transports around the same Rust core.

## Known Limits

- Browser WASM networking is subject to provider CORS and browser-managed
  redirect behavior. Capacitor should use native networking instead.
- Browser async storage is appropriate for this trial, but Android credentials
  should use encrypted storage backed by Android Keystore.
- WASM cannot perform the native server's DNS-level SSRF checks. The Capacitor
  native adapter can retain native URL and network validation.
- Only SimpleFIN and its secrets are included in this direct-call trial. Full
  Rust sync-server parity remains the migration goal before TypeScript removal.
