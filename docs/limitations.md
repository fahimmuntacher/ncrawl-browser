# Known Limitations (as of Phase 1)

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
  content has finished loading. Render-stability waiting is Phase 2 work.

## Testing scope
- Tested: static server pages, a framework-free SPA with `pushState` routing,
  3-level collapsible menus, 21 SPA + 3 static routes, manual-login persistence,
  profile isolation, renderer crash, browser-process kill, timeouts, retries,
  headed launch on Linux/Wayland.
- **Not yet tested:** real React and Next.js applications (planned for Phase 5),
  Windows and macOS hosts, Docker.

## Not implemented yet (by phase)
- Phase 2: DOM/accessibility snapshots, interactive elements, screenshots,
  navigation history log, network metadata.
- Phase 3: local HTTP API, pause/resume/stop controls.
- Phase 4: FastAPI/dashboard/agent integration contracts.
