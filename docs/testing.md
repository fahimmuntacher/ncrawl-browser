# Testing and Reliability (Phase 5)

`npm test` builds the two framework test apps, then runs 85 tests (unit +
integration, real headless Chromium). About 4 minutes on the development
machine. `NCRAWL_TEST_HEADED=1 npm test` adds a visible-window test.

## Test applications

| App | Stack | Routes | What it exercises |
|---|---|---|---|
| Mock ERP (`packages/mock-erp`) | Plain JS, `node:http` | 21 SPA + 3 server-rendered | `pushState` routing, 3-level menus, cookie login, 401/403/404/500, slow & flaky endpoints, popups, bearer header, token in query string |
| Acme CRM (`packages/test-apps/react-spa`) | React 19.3, React Router 8.4, Vite 8 | 15 menu + 3 dynamic (`/crm/deals/:id`) | Client-only rendering, **token in localStorage**, React-state menus (children not in the DOM until opened), `React.lazy` + `Suspense`, data-loading spinners, destructive buttons |
| Northwind ERP (`packages/test-apps/next-app`) | Next.js 16.4 App Router, React 19.3 | 15 menu + 3 dynamic (`/inventory/items/[sku]`) | `proxy.ts` auth redirect, **HttpOnly cookie** set by a server action, per-request server components, **streaming** `loading.jsx`, `next/link` client navigation, server-action forms |

All use the credentials `demo` / `demo` and count logins and mutations so tests
can prove nothing was submitted.

## Coverage of the brief's Phase 5 list

| Requirement | Where | Result |
|---|---|---|
| Static pages | session, inspection | ✅ |
| React applications | real-apps (Acme CRM) | ✅ 18/18 routes captured complete & stable |
| Next.js applications | real-apps (Northwind ERP) | ✅ 18/18 routes captured complete & stable |
| Client-side navigation | inspection, real-apps | ✅ recorded as `same-document`, initiator `page`; back/forward work |
| Nested navigation menus | inspection, real-apps | ✅ 3 levels; menu paths match each app's own tree |
| Authenticated pages via manual sessions | session, real-apps | ✅ cookie and localStorage logins survive browser restarts; other profiles stay logged out |
| Browser crashes | session, reliability | ✅ renderer crash (idle and mid-inspection), browser kill (idle and mid-navigation) |
| Network failures | session, reliability | ✅ refused/reset connections retried; full outage → retryable error → recovery on the same tab |
| Timeout recovery | session | ✅ timeout reported, page usable afterwards |
| Profile isolation | session, real-apps | ✅ |
| Local app with 15–20 routes | all three apps | ✅ 24 / 18 / 18 |

## Measured results (development machine, headless)

| Metric | Mock ERP | React SPA | Next.js | PRD target |
|---|---|---|---|---|
| Menu routes visible before expanding menus | 4 of 21 | 2 of 15 | 2 of 15 | — |
| Discovery coverage after safe expansion | 100 % | 100 % (15/15) | 100 % (15/15) | ≥ 90 % |
| Routes captured complete & stable | 24/24 | 18/18 | 18/18 | ≥ 95 % |
| Mean time per full page inspection | ~0.66 s | ~0.96 s | ~1.45 s | — |
| Mutations during crawls | 0 | 0 | 0 | 0 |

Soak: 3 passes × 24 routes = 72 full observations, 0 failures, identical pass
times (15.9 s each), ~31 MB heap growth, no leaked tabs.

Discovery here means: open every collapsed sidebar group by clicking only
controls the inspector rated `safe`, then read navigation links. This is what a
future crawler's "safe menu expansion" will do; it is tested, not yet automated.

## Bugs found by Phase 5 (all fixed, all with regression tests)

1. **Renderer crash during an inspection hung forever.** A pending
   `page.evaluate()` on a crashed renderer never settles in Playwright, so the
   call never returned and the page stayed locked (`PAGE_BUSY`) indefinitely.
   Every page-scoped operation now races the page's `crash`/`close` events and
   fails fast with `PAGE_CRASHED` (≈1.4 s instead of never).
2. **No recovery after a server outage.** After an outage Chromium shows its
   internal error page and the next navigation fails with "interrupted by
   another navigation to chrome-error://…" — no `net::ERR_*` code, so it was
   classified as non-retryable. It is now retryable.
3. **Locator hints failed on server-rendered React.** Chromium's accessible name
   ("▸Inventory") and Playwright's ("▸ Inventory") differ in whitespace when
   React streams text split by comment nodes. Hints now include
   `namePattern` (whitespace-insensitive) + `patternNth`; verified on all three apps.
4. (Phase 4) **Abandoned requests blocked stability forever** — found by the
   first multi-page crawl; fixed by marking them `cancelled`.

## Not covered
- Windows and macOS hosts; Docker.
- Real third-party applications (only purpose-built test apps).
- Single sign-on (OAuth/SAML redirects across origins) and MFA flows.
- Virtualised lists, infinite scroll, canvas UIs, iframes with app content,
  shadow-DOM-heavy design systems.
- Sustained runs longer than a few minutes; many concurrent sessions.
