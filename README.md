# NCrawl

Authorized web-application mapping and visual documentation. This repository
currently contains **NCrawl Browser**, the local Chromium runtime that NCrawl
uses to open, inspect and capture the applications you are allowed to inspect.

| Package | What it is |
|---|---|
| `packages/browser` | NCrawl Browser: Playwright/Chromium session runtime + CLI |
| `packages/mock-erp` | Local mock ERP (login, nested sidebar, 24 routes) used by tests |

Design and decisions: [`docs/architecture.md`](docs/architecture.md),
[`docs/adr/0001-browser-runtime.md`](docs/adr/0001-browser-runtime.md),
[research](docs/research/open-source-evaluation.md),
[licenses](docs/research/license-compatibility.md),
[limitations](docs/limitations.md).

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

node src/cli.ts profile list
node src/cli.ts profile delete acme-erp
```

Try it against the mock ERP (credentials `demo` / `demo`):
```bash
npm run start -w @ncrawl/mock-erp           # http://127.0.0.1:4600
node packages/browser/src/cli.ts login demo http://127.0.0.1:4600/app
```

## Test
```bash
npm run typecheck
npm test                                     # unit + integration (headless Chromium)
NCRAWL_TEST_HEADED=1 npm test                # also runs the visible-window test
```

## Safety boundaries
NCrawl Browser opens only `http(s)` URLs, can be restricted to exact origins per
session, never exports or logs cookies/tokens/passwords (URLs and logs are
redacted), and contains no stealth, fingerprint-spoofing, proxy-rotation or
CAPTCHA-bypass code. Only use it on applications you own or are authorized to inspect.
