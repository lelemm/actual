# Repository notes

## Cursor Cloud specific instructions

- Actual is a Yarn 4/Node monorepo. Standard commands are defined in `package.json`; browser E2E details live in `packages/desktop-client/README.md`.
- The browser development stack is the primary Cloud path: run `yarn start` from the repo root to start the loot-core browser worker and Vite web app on port 3001. The sync server is a separate service and is not required for local/no-server budget flows.
- In this Cloud image, `/exec-daemon` can appear before nvm on `PATH`. If `node --version` does not match `.nvmrc` after `nvm use`, prepend the nvm Node bin before running Yarn, for example `export PATH="$HOME/.nvm/versions/node/v18.16.0/bin:$PATH"`.
- If Chrome shows a blank `localhost:3001` page with `ERR_INSUFFICIENT_RESOURCES` for bundles, open a fresh browser origin at `http://127.0.0.1:3001/`; the Vite server can still be healthy.
