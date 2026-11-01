# Open-Source Research Report — NCrawl Browser runtime

Date: 2026-11-01. All repository facts below were read from the GitHub API, the
projects' published `package.json`/`pyproject.toml`, or (for Steel) a shallow
clone of the default branch on that date. Star counts and dates drift; re-check
before relying on them.

## Candidates

| | Playwright | Steel Browser | Stagehand | Browser Use | Puppeteer | Playwright MCP |
|---|---|---|---|---|---|---|
| Repo | microsoft/playwright | steel-dev/steel-browser | browserbase/stagehand | browser-use/browser-use | puppeteer/puppeteer | microsoft/playwright-mcp |
| License (SPDX) | Apache-2.0 | Apache-2.0 | MIT | MIT | Apache-2.0 | Apache-2.0 |
| Last push | 2026-10-31 | 2026-10-31 | 2026-10-30 | 2026-10-31 | 2026-11-01 | 2026-10-31 |
| Latest release | v1.64.1 (2026-10-14) | v0.5.5-beta (2026-10-31) | server v3.7.7 / sdk 4.3.0 | 0.13.14 (2026-10-26) | — | 0.0.84 |
| Language | TypeScript | TypeScript | TypeScript | Python | TypeScript | TypeScript |
| What it is | Browser automation library (Chromium/Firefox/WebKit) | Self-hostable browser-session API server (Fastify + puppeteer-core) | LLM-driven automation SDK (`act`/`extract`/`observe`) | LLM agent that drives a browser over CDP | Chromium/Firefox automation library | MCP server exposing Playwright to AI agents |
| Engine control | Own protocol layer over CDP | puppeteer-core 23.6.0 + raw CDP | Own CDP layer (v3+) | `cdp-use` (raw CDP) | CDP / WebDriver BiDi | Playwright |
| Needs an LLM | No | No | Yes for its core primitives | Yes (core purpose) | No | No (an agent is the client) |
| Self-hosting | Library, fully local | Docker / Node server | Local browser possible; Browserbase SDK is a hard dep | Local, plus cloud SDK dep | Library, fully local | Local process |
| Persistent sessions | `launchPersistentContext(userDataDir)` | Session API; exports/imports state | `localBrowser.launch({userDataDir})` | Profile dirs | `userDataDir` | Persistent profile flag |
| Screenshots | Viewport, full-page, element | Yes (API) | Via underlying page | Yes | Viewport, full-page | Yes |
| DOM / a11y inspection | `ariaSnapshot`, locators, CDP session (`DOMSnapshot`, `Accessibility`) | Scrape/`defuddle`/cheerio | a11y-tree based `observe` (LLM) | DOM + a11y serialization for the LLM | CDP, `accessibility.snapshot` | a11y snapshots for agents |
| Extensions | Chromium, persistent context only | Yes | Inherits | Yes | Yes | Inherits |

## Findings that decide the fit

**Steel Browser** — verified in source (`api/package.json`, `api/src`):
- Direct dependencies include `fingerprint-generator`, `fingerprint-injector`,
  `proxy-chain`, `http-proxy`, `socks-proxy-agent`. The README lists
  "Anti-Detection: stealth plugins and fingerprint management" and "proxy chain
  management for IP rotation".
- Fingerprint injection is **on by default**; the session schema exposes an
  opt-out flag `skipFingerprintInjection`.
- `GET /sessions/:sessionId/context` returns browser state including cookies
  read with CDP `Storage.getCookies` (`cdp.service.ts` `getCookies`).
- Both directly contradict NCrawl requirements (no stealth/fingerprint spoofing,
  no proxy rotation, never expose cookies through an API). Forking would mean
  removing a core part of the product and then owning a large Fastify server
  (~37 runtime deps incl. DuckDB, LevelDB, mupdf, jsdom) we don't otherwise need.
- It controls Chrome with Puppeteer; NCrawl's stack decision is Playwright.

**Stagehand** — its value (`act`, `extract`, `observe`) is LLM-driven. The TS SDK
hard-depends on `@browserbasehq/sdk` (cloud) and OpenTelemetry. NCrawl's core
must be deterministic and work with AI disabled, so Stagehand adds dependency
weight without serving the core. Its idea of exposing accessibility-tree
observations instead of brittle selectors is worth borrowing as a design idea
(no code copied).

**Browser Use** — a Python LLM agent. Runtime dependencies pin `openai`,
`anthropic`, `google-genai`, `groq`, `ollama`, `posthog` (product analytics),
Google API clients and a cloud SDK. Wrong language for the browser service, makes
LLM SDKs mandatory, and ships an analytics client. Not suitable as the runtime;
it could later be a *client* of NCrawl Browser's API like any other agent.

**Puppeteer** — technically capable, but Playwright gives the same Chromium
control plus `launchPersistentContext`, auto-waiting locators, `ariaSnapshot`,
and first-class test tooling; the NCrawl stack already names Playwright.

**Playwright MCP** — not a runtime for NCrawl, but relevant to Phase 4: it shows
how agents (Claude, Hermes) consume a11y snapshots over MCP. NCrawl Browser can
later expose its own typed API through an MCP adapter without depending on it.

## Strategy comparison

| Strategy | Reuse | Fit with requirements | Ongoing cost | Verdict |
|---|---|---|---|---|
| A. Use existing project as-is (Steel) | Highest | Fails: stealth on by default, cookie-export API, proxy rotation | Low code, high policy risk | Rejected |
| B. Fork and extend (Steel) | High | Requires removing stealth/proxy/cookie features and rebasing on every upstream release; Puppeteer not Playwright | High: maintaining a fork of a fast-moving server | Rejected |
| B'. Build on Stagehand / Browser Use | Medium | LLM-first; mandatory cloud/LLM SDKs | Medium | Rejected for runtime |
| **C. Custom Playwright controller** | Playwright does the engine work | Full control over safety, redaction, schemas | Small, focused codebase | **Recommended** |

## What is reused vs. built

Reused (as a pinned dependency, unmodified): **Playwright 1.64.1** and the
Chromium build it downloads — launch, persistent contexts, navigation, waits,
screenshots, `ariaSnapshot`, CDP sessions, network events.

Built for NCrawl: lifecycle/session manager, project profile store with locking,
URL policy, navigation wrapper with bounded retries, inspection collectors,
redaction, typed API schemas, local HTTP API, mock ERP test app.

No code is copied from any candidate.
