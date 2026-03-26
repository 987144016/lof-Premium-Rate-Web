# Cloudflare Independent Server Mode

This mode makes Cloudflare runtime updates independent from GitHub Actions and from any local always-on script.

## What Runs Where

- Server:
  - runs `npm run cloudflare:server`
  - executes `scripts/sync-funds.mjs` and `scripts/sync-premium-compare.mjs`
  - keeps using the same repo code and the same local cache layout
  - exposes generated JSON at `/generated/*.json`
- Cloudflare Worker:
  - uses cron to pull `funds-runtime.json` from the server into D1
  - proxies `premium-compare.json` from the same server
- GitHub mode:
  - stays available and keeps its own workflows
  - no longer deploys or refreshes Cloudflare automatically

## Server Start

```bash
npm ci
npm run cloudflare:server
```

Default endpoints exposed by the server process:

- `http://127.0.0.1:8788/health`
- `http://127.0.0.1:8788/generated/funds-runtime.json`
- `http://127.0.0.1:8788/generated/premium-compare.json`

## Important Environment Variables

- `CLOUDFLARE_SERVER_HOST`
- `CLOUDFLARE_SERVER_PORT`
- `CLOUDFLARE_SERVER_SYNC_TOKEN`
- `SYNC_STARTUP_FULL_FIRST`
- `SYNC_BOOTSTRAP_BATCH_SIZE`
- `SYNC_BATCH_SIZE`
- `SYNC_SKIP_REALTIME_HOLDINGS`

## Worker Config

Set this in `cloudflare/worker/wrangler.toml` or via Wrangler secret/var management:

```toml
[vars]
GENERATED_SOURCE_BASE_URL = "https://your-server.example.com"
RUNTIME_SYNC_MIN_INTERVAL_MINUTES = "5"
```

If you need separate source addresses, you can also set:

- `RUNTIME_SYNC_SOURCE`
- `PREMIUM_COMPARE_SOURCE`

## Manual Server Sync

```bash
curl -X POST "https://your-server.example.com/internal/sync?mode=full" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

If `CLOUDFLARE_SERVER_SYNC_TOKEN` is empty, the server accepts manual sync requests without auth.

## Migration

The running code remains in this repository. To move to another server later:

1. Copy or clone the repo.
2. Restore `.cache/` if you want to keep warm data and manual local entries.
3. Start `npm run cloudflare:server` on the new machine.
4. Update `GENERATED_SOURCE_BASE_URL` in Worker config.
5. Redeploy the Worker once.
