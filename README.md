# NCrawl

Authorized web-application mapping and visual documentation. This repository
currently contains **NCrawl Browser**, the local Chromium runtime that NCrawl
uses to open, inspect and capture the applications you are allowed to inspect.

| Package | What it is |
|---|---|
| `packages/browser` | NCrawl Browser: Playwright/Chromium session runtime + CLI |
| `packages/mock-erp` | Local mock ERP (login, nested sidebar, 24 routes) used by tests |
| `packages/test-apps/react-spa` | React 19 + React Router SPA test app (18 routes, localStorage login) |
| `packages/test-apps/next-app` | Next.js 16 App Router test app (18 routes, cookie login, streaming) |

Design and decisions: [`docs/architecture.md`](docs/architecture.md),
[`docs/api.md`](docs/api.md),
[`docs/integration.md`](docs/integration.md) (dashboard, FastAPI, agents/MCP, extension; contracts in [`docs/contracts/`](docs/contracts/)),
[`docs/adr/0001-browser-runtime.md`](docs/adr/0001-browser-runtime.md),
[research](docs/research/open-source-evaluation.md),
[licenses](docs/research/license-compatibility.md),
[limitations](docs/limitations.md), [testing & reliability results](docs/testing.md).

## Requirements
- Node.js 24.11+ (runs the TypeScript sources directly; no build step)
- Linux, macOS or Windows with a desktop for headed mode (tested on Linux)

## Setup
```bash
npm install
npm run browsers:install     # downloads Playwright's pinned Chromium (~170 MB, one time)
cp .env.example .env         # optional; defaults work without it
```

## Use
Settings come from `NCRAWL_*` environment variables. To use the `.env` file, add
`--env-file=../../.env` after `node` in the commands below (built into Node).

```bash
cd packages/browser

# Create a project profile and log in yourself in a visible window.
# NCrawl never reads what you type; the login lives only in the project's Chromium profile.
node src/cli.ts profile create acme-erp --name "Acme ERP"
node src/cli.ts login acme-erp https://erp.example.com/
# ...log in, then close the window.

# Check that the saved login works (prints status, final URL, title as JSON).
node src/cli.ts check acme-erp https://erp.example.com/dashboard --headless

# Inspect one page: saves screenshot + observation JSON (DOM, accessibility tree,
# interactive elements, navigation links, network metadata) under NCRAWL_DATA_DIR/captures/.
node src/cli.ts inspect acme-erp https://erp.example.com/dashboard --full-page

node src/cli.ts profile list
node src/cli.ts profile delete acme-erp

# Local HTTP API + minimal control UI (prints a link with the access token).
node src/cli.ts serve
```

The API reference — operations, error codes, pause/resume/stop — is in
[`docs/api.md`](docs/api.md).

Try it against the mock ERP (credentials `demo` / `demo`):
```bash
npm run start -w @ncrawl/mock-erp           # http://127.0.0.1:4600
node packages/browser/src/cli.ts login demo http://127.0.0.1:4600/app
```

## Integration
- Typed client for the dashboard: `@ncrawl/browser/client`
- Sync payloads + mapping for the FastAPI backend: `@ncrawl/browser/contracts`
- AI agents (Hermes, Claude, …): MCP adapter `node packages/browser/src/mcp/server.ts`
- Regenerate published contracts after API changes: `npm run contracts`

## Test
```bash
npm run typecheck
npm test                                     # builds the test apps, then 85 unit + integration tests (~4 min)
NCRAWL_TEST_HEADED=1 npm test                # also runs the visible-window test
```

## Safety boundaries
The API listens on loopback only and requires a bearer token, a matching Host
header and an allow-listed Origin for browser callers. Every session has
pause/resume/stop and there is a global stop. NCrawl Browser opens only `http(s)` URLs, can be restricted to exact origins per
session, never exports or logs cookies/tokens/passwords (URLs and logs are
redacted), and contains no stealth, fingerprint-spoofing, proxy-rotation or
CAPTCHA-bypass code. Only use it on applications you own or are authorized to inspect.
