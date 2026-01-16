# npm-check

Monitors newly published npm package versions via the npm registry changes feed and flags publishes that **introduce** a `postinstall` script.

## Run

Requires Node.js 18+.

```bash
npm run start
```

## Configuration

- `NPM_CHANGES_URL`: override the default changes feed URL (defaults to `https://replicate.npmjs.com/_changes?feed=continuous&include_docs=true&since=now&heartbeat=60000`).