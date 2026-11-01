   # ADR 0001 — Browser runtime: custom Playwright controller, primary crawl path

- Status: Accepted (2026-11-01, confirmed by project owner)
- Supersedes: PRD "Important architectural decision" (extension does the crawling)

## Context

The NCrawl PRD (Implementation Roadmap PDF) made a Manifest V3 Chrome extension
the crawler, because it runs inside the user's already-authenticated browser.
The NCrawl Browser brief asks for a controlled Chromium runtime via Playwright
with headed operation, persistent per-project profiles, manual login, DOM/a11y
inspection, network metadata and a stable API that AI agents can call.

An extension cannot provide full-page screenshots reliably, CDP-level DOM and
accessibility snapshots, crash recovery, or an agent-facing API without a
companion process; a Playwright runtime can.

Candidates were evaluated in `docs/research/open-source-evaluation.md`.

## Decision

1. Build **NCrawl Browser** as a TypeScript/Node.js service on **Playwright +
   Chromium** (strategy C, custom controller). No fork.
2. The Playwright runtime is the **primary crawl path**. The extension becomes
   optional and later; it must use the same data contracts if built.
3. Authentication is manual: the user logs in inside a **headed** window backed
   by a per-project persistent profile (`launchPersistentContext`). NCrawl never
   reads, exports, or logs cookies, tokens or passwords.
4. The service runs on the user's machine and binds to **127.0.0.1** only. The
   FastAPI backend never drives a browser and never receives cookies — the PRD's
   security intent is preserved; only the process doing the crawl moves.
5. No stealth, fingerprint spoofing, proxy rotation or CAPTCHA handling. These
   features are excluded by design, not just disabled.
6. Node 24 runs `.ts` sources directly (type stripping); `tsc --noEmit` checks
   types. Tests use the built-in `node:test` runner. This avoids a build step and
   extra test frameworks.

## Consequences

- One process to manage: Chromium profiles live under `NCRAWL_DATA_DIR`.
- A profile can be open by only one Chromium at a time; the service enforces it.
- Session persistence depends on what the target site stores. Session-only
  cookies (no `Expires`/`Max-Age`) do not survive a browser restart; users may
  need to log in again.
- Headed mode needs a display. Docker/headless use is for CI and explicit
  headless runs, not for manual login.
- Revisit if the product requires crawling inside the user's everyday Chrome
  profile (extension path) rather than a dedicated NCrawl profile.
