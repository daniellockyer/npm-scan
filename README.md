# npm-check

Monitors newly published npm package versions via the npm registry changes feed and flags publishes that **introduce** a `postinstall` script.

## Run

Requires Node.js 18+.

```bash
npm run start
```

## Deploy (GitHub Actions → Hetzner via SSH + PM2)

This repo includes a workflow at `.github/workflows/deploy.yml` that deploys on pushes to `main` (and supports manual runs).

On the server you must have:

- Node.js + npm
- `pm2` installed globally (`npm i -g pm2`)
- a writable deploy directory (matches `HETZNER_DEPLOY_PATH`)

## Configuration

- `NPM_REPLICATE_DB_URL`: defaults to `https://replicate.npmjs.com/` (used to discover the current `update_seq` so the monitor starts “from now”).
- `NPM_CHANGES_URL`: defaults to `https://replicate.npmjs.com/_changes`.
- `NPM_REGISTRY_URL`: defaults to `https://registry.npmjs.org/` (used to fetch packuments to inspect `scripts.postinstall`).
- `CHANGES_LIMIT`: defaults to `200` (max changes per poll request).
- `POLL_MS`: defaults to `1500` (sleep when there are no new changes).
- `MAX_CONCURRENCY`: defaults to `10` (concurrent packument fetches).