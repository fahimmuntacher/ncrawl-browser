# NCrawl Browser — Architecture

```mermaid
flowchart LR
  subgraph Clients
    DASH[Next.js dashboard]
    API[FastAPI backend]
    AGENT[AI agents: Hermes / Claude / ...]
    CLI[ncrawl-browser CLI]
  end

  subgraph NB["NCrawl Browser service (Node.js, 127.0.0.1 only)"]
    HTTP[Local HTTP API<br/>typed schemas · Phase 3]
    SM[Session manager<br/>lifecycle · crash detection · restart]
    PS[Profile store<br/>per-project userDataDir · lock]
    PR[Page registry]
    NAV[Navigation<br/>URL policy · timeouts · bounded retries]
    INS[Inspection engine · Phase 2<br/>DOM · a11y · elements · screenshots<br/>history · network metadata]
    RED[Redaction]
    LOG[Structured JSON logs]
  end

  CHR[(Chromium via Playwright)]
  FS[(NCRAWL_DATA_DIR<br/>profiles/ · captures/)]

  DASH --> HTTP
  API --> HTTP
  AGENT --> HTTP
  CLI --> SM
  HTTP --> SM
  SM --> PS
  SM --> PR
  PR --> NAV
  PR --> INS
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
| `cli.ts` | Manual login and quick checks |
