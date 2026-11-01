# NCrawl Browser — Architecture

```mermaid
flowchart LR
  subgraph Clients
    DASH[Next.js dashboard]
    API[FastAPI backend]
    AGENT[AI agents: Hermes / Claude / ...]
    CLI[ncrawl-browser CLI]
    MCPA[MCP adapter<br/>for agents]
  end

  subgraph NB["NCrawl Browser service (Node.js, 127.0.0.1 only)"]
    HTTP[Local HTTP API + control UI<br/>token · host/origin checks · typed schemas]
    GATE[Operation gate<br/>pause · resume · stop · one op per page]
    SM[Session manager<br/>lifecycle · crash detection · restart]
    PS[Profile store<br/>per-project userDataDir · lock]
    PR[Page registry]
    NAV[Navigation<br/>URL policy · timeouts · bounded retries]
    INS[Inspection engine<br/>DOM · a11y · elements · screenshots]
    OBS[Observers<br/>history · network metadata]
    RED[Redaction]
    LOG[Structured JSON logs]
  end

  CHR[(Chromium via Playwright)]
  FS[(NCRAWL_DATA_DIR<br/>profiles/ · captures/)]

  DASH --> HTTP
  API --> HTTP
  AGENT --> MCPA
  MCPA --> HTTP
  CLI --> SM
  HTTP --> SM
  SM --> GATE
  GATE --> PR
  SM --> PS
  SM --> PR
  PR --> NAV
  PR --> INS
  PR --> OBS
  OBS --> CHR
  INS --> OBS
  INS --> RED
  NAV --> CHR
  INS --> CHR
  SM --> CHR
  PS --> FS
  INS --> FS
  SM -.-> LOG
```

Boundaries:
- Only the browser service talks to Chromium. Backend/dashboard/agents use the
  API and receive structured, redacted data — never cookies or tokens.
- Profiles are per project (`profiles/<projectId>/user-data`). Ephemeral
  sessions use a fresh, non-persistent context.
- The service binds to loopback only; there is no remote crawling.

Module layout (`packages/browser/src`):

| Module | Responsibility |
|---|---|
| `config.ts` | Read and validate environment variables |
| `errors.ts` | `NcrawlError` with stable error codes |
| `logger.ts` | JSON logger with key/value redaction |
| `ids.ts` | ID generation and project-ID validation |
| `profiles/profile-store.ts` | Create/list/delete project profiles; single-owner lock |
| `runtime/url-policy.ts` | Allowed schemes and origins |
| `runtime/session-manager.ts` | Launch/close/restart sessions; status; crash detection |
| `runtime/page-registry.ts` | Page IDs ↔ Playwright pages within a session |
| `runtime/navigation.ts` | navigate/back/forward/reload with timeouts and retries |
| `observers/history-recorder.ts` | Main-frame navigations per page from CDP events (document + SPA), with initiator |
| `observers/network-observer.ts` | Per-session request metadata (no headers/bodies), in-flight tracking |
| `inspection/stability.ts` | Wait for load + DOM quiet + network quiet (bounded) |
| `inspection/page-metadata.ts` | URL, title, viewport/document size, headings, word count |
| `inspection/dom-snapshot.ts` | Bounded DOM tree with attribute allow-list; never form values |
| `inspection/accessibility.ts` | Chromium AX tree, pruned; text outline; no input values |
| `inspection/interactive.ts` | Interactive elements, stable IDs, locator hints, risk; navigation links; expandable groups |
| `inspection/screenshot.ts` | Viewport / full-page / custom-viewport captures tied to a history position |
| `inspection/inspector.ts` | One `PageObservation` combining all parts; partial results on part failure |
| `storage/capture-store.ts` | `captures/<project>/<session>/NNNN_<slug>.{png,screenshot.json,observation.json}` |
| `runtime/operation-gate.ts` | Pause/resume/stop state, per-page busy lock, immediate release on stop |
| `api/security.ts` | Token file, Host/Origin checks, constant-time token compare |
| `api/http.ts` | Response envelope, error → HTTP status, JSON body reader, router |
| `api/schemas.ts` | Strict request schemas for HTTP bodies and query strings |
| `api/routes.ts` | Route table; each route names its API operation |
| `api/server.ts` | `node:http` server, CORS for allow-listed origins, UI assets |
| `api/ui/*` | Minimal control UI (vanilla JS, strict CSP) |
| `contracts/responses.ts` | Strict response schemas (the API contract) |
| `contracts/type-checks.ts` | Compile-time proof that schemas equal the code's types |
| `contracts/openapi.ts` | OpenAPI 3.1 built from the route table |
| `contracts/sync.ts` | PRD sync payloads (snake_case), UUIDv5 IDs, `toPageNode`, `deriveEdges` |
| `contracts/generate.ts` | Writes/checks `docs/contracts/*` |
| `client/index.ts` | Runtime-neutral typed HTTP client (dashboard, extension) |
| `mcp/server.ts` | MCP stdio adapter for AI agents (no click/type tools) |
| `cli.ts` | Manual login, checks, one-shot inspection, `serve` |
