# Known Limitations (as of Phase 5)

Each item is either verified by a test or stated as untested.

## Sessions and profiles
- **Session-only cookies are lost on restart.** Chromium persists cookies with
  `Expires`/`Max-Age`; cookies without them end with the browser process. Sites
  that use them need a fresh manual login per browser launch. (Persistence
  verified with the mock ERP's `Max-Age` cookie.)
- **Profile lock across processes is Linux/macOS only.** It reads Chromium's
  `SingletonLock` symlink. On Windows only the in-process lock applies; two
  NCrawl processes could try to open the same profile (Chromium will then fail
  to launch the second one). Untested on Windows/macOS.
- A profile is tied to the Chromium build that last used it. Switching
  `NCRAWL_BROWSER_CHANNEL` to an older Chrome may refuse or reset the profile.
- **Closing the window vs. a crash are indistinguishable.** Both put the session
  in `disconnected`; `restartSession` relaunches with the same profile, but open
  tabs are not restored.

## Navigation
- Only `http:`/`https:` URLs can be opened. Redirects to other origins (SSO) are
  allowed and reported as `leftAllowedOrigins: true`, not blocked, so manual
  login through an identity provider works.
- Retries apply only to transient network errors (connection reset/refused,
  empty response, timeouts). HTTP 4xx/5xx are returned as results, never retried.
- `httpStatus` is `null` for same-document (SPA `pushState`) navigations.
- `waitUntil: 'load'` is the default; it does not guarantee that client-rendered
  content has finished loading. `inspectPage` waits for DOM and network quiet
  first; the single-part getters do not — call `waitForStable` before them.

## Inspection (Phase 2)
- **Interactive elements come from Chromium's accessibility tree.** Clickable
  `<div>`s with no role, no tabindex and only a JS click handler are not detected.
- **Risk labels are heuristics** (role, form membership, label keywords such as
  "delete", "save", "log out"). Unknown buttons are `unknown-action`, never `safe`.
  Non-English labels are only classified by structure (form submit, inputs, links).
- **Menu paths** use `aria-controls` when present; otherwise the control directly
  before the submenu. Menus built from unrelated `<div>`s may get an empty path.
- **Element IDs** stay stable while role, label, landmark, menu path and URL path
  stay the same; renaming a label or moving it to another menu changes the ID.
- **Stability wait** ends after 10 s by default. Pages with constant DOM changes
  (clocks, tickers) or polling requests are captured with `stable: false`.
- **Full-page screenshots** expand the document, not inner scroll containers.
  Apps with a fixed-height shell and a scrolling `<main>` get a viewport-sized
  image; `metadata.innerScrollContainers > 0` flags this. Documents taller than
  30 000 px fall back to a viewport capture (`status: fallback`).
- Sticky headers appear once (at the top) in full-page captures; lazy-loaded
  content below the fold may be missing because NCrawl does not scroll the app.
- Cross-origin iframes are listed by URL only; their content is not inspected.
- Network timing is wall-clock from request start to finish as seen by
  Playwright, not a DNS/TLS/TTFB breakdown. Records are kept in memory
  (5 000 per session) and are lost when the service exits.
- Chromium reports going **back** to a `pushState` entry as `navigationType:
  "fragment"`; use the history entry's `initiator` to know what caused it.

## Local API and UI (Phase 3)
- **Single user, single process.** One token grants full control; there are no
  roles. Anyone who can read `<dataDir>/api-token` (same OS user) can drive the
  logged-in browser. Sessions live in memory and end when the service exits.
- **Stopped/closed sessions disappear** from `GET /sessions`; their captures stay
  on disk and remain readable via `/captures`.
- **Pause does not freeze the page.** It refuses new automated operations; the
  site's own scripts keep running and the person can keep using the window.
- **Stop releases callers at once, but closing Chromium can take up to 15 s**
  if the browser is wedged.
- The control UI is a functional tool, not a product UI: no pagination, plain
  JSON output, polling refresh every 5 s (paused while you type).
- No HTTPS: the API is loopback-only plain HTTP by design.

## Integration contracts (Phase 4)
- **The OpenAPI document was not checked with an external validator** in this
  environment; structure is tested (every route once, unique operationIds, all
  `$ref`s resolve, auth flags). Run `npx @redocly/cli lint docs/contracts/openapi.json`
  to validate it independently.
- **Not exercised against real consumers yet**: no FastAPI app, Pydantic
  generation, Next.js build (`transpilePackages`) or Hermes configuration has
  been run. The TypeScript client and MCP adapter are tested against the live API.
- **MCP adapter** implements the stdio transport and `initialize`, `ping`,
  `tools/list`, `tools/call` only (no resources, prompts, cancellation or
  progress). Agents get no way to click, type or expand menus, so they can only
  reach pages through URLs and visible links.
- **Edges come from links present on observed pages.** A menu item revealed only
  after expanding a group yields an edge only if the group was expanded when the
  source page was observed (discovery/crawl orchestration is future work).
- `toPageNode` sets `status` to `captured` for partial observations; the first
  error is recorded in `error_code`/`error_message`.
- **Locator hints**: prefer `namePattern` + `patternNth`. `name` + `exact` + `nth`
  can miss on server-rendered React, where Chromium and Playwright compute
  accessible names with different whitespace.

## Reliability (Phase 5)
- A crashed renderer fails page operations with `PAGE_CRASHED` immediately;
  partial results of an interrupted inspection are not returned (call
  `recoverPage`, then inspect again).
- Performance was measured on one Linux machine, headless: ~0.7–1.5 s per full
  page inspection, dominated by the stability wait (500 ms DOM + network quiet).

## Testing scope
- Tested: static server pages, a framework-free SPA with `pushState` routing,
  3-level collapsible menus, 21 SPA + 3 static routes, manual-login persistence,
  profile isolation, renderer crash, browser-process kill, timeouts, retries,
  headed launch on Linux/Wayland; secret non-leakage (typed values, passwords,
  bearer header, query tokens) across observations and logs; locator hints
  resolving to the reported element; ID stability across reloads; API token,
  Host/Origin checks, CORS, body limits, path traversal on capture files,
  pause/resume, PAGE_BUSY, stop during a slow navigation, stop-all, and the UI
  driving a session end to end; contract drift (files, compile-time types,
  runtime response validation), typed client, sync mapping from real
  observations, MCP adapter as a subprocess; abandoned-request and long-poll
  stability regressions.
- React 19 SPA and Next.js 16 App Router apps are tested (see testing.md).
- **Not yet tested:** Windows and macOS hosts, Docker, real third-party apps,
  SSO/MFA login flows, virtualised lists/infinite scroll, canvas UIs, app content
  inside iframes, long multi-hour runs, many concurrent sessions.
- **No Docker image.** Manual login needs a visible browser on the user's
  desktop, so the supported setup is local. A headless CI image is possible but
  has not been built or tested.

## Not implemented yet (by phase)
- Not yet built: crawl orchestration (route discovery → user review → sequential
  crawl with safe menu expansion), the dashboard, the FastAPI backend, exports
  (PDF/PNG/ZIP). These are outside the brief's five phases.
