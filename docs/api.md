# NCrawl Browser — Local HTTP API (v1)

Start it with `node packages/browser/src/cli.ts serve`. It listens on
`http://127.0.0.1:4700` (`NCRAWL_API_PORT`) and prints a control-UI link.
The machine-readable contract is `GET /v1/openapi.json` (no token needed) and
[`contracts/openapi.json`](contracts/openapi.json); see also
[`integration.md`](integration.md).

## Access rules
| Rule | Detail |
|---|---|
| Loopback only | `NCRAWL_API_HOST` accepts only `127.0.0.1`, `::1`, `localhost`. |
| Token | Every `/v1/*` request except `/v1/health` needs `Authorization: Bearer <token>`. The token is generated once into `<NCRAWL_DATA_DIR>/api-token` (mode 0600), or set with `NCRAWL_API_TOKEN` (≥ 32 chars). |
| Host check | `Host` must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` (blocks DNS rebinding). |
| Origin check | If a request carries `Origin`, it must be the server itself or listed in `NCRAWL_API_ALLOWED_ORIGINS` (e.g. the dashboard). Those origins get CORS headers. |
| Bodies | `application/json` only, ≤ 64 KB. Unknown fields are rejected (`INVALID_INPUT`). |

## Envelope
```json
{ "ok": true,  "data": { ... } }
{ "ok": false, "error": { "code": "SESSION_PAUSED", "message": "...", "retryable": true, "details": {} } }
```

## Error codes
| HTTP | Codes |
|---|---|
| 400 | `INVALID_INPUT` (details.issues lists each field) |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` (host/origin), `URL_NOT_ALLOWED` (scheme or origin outside the session allow-list) |
| 404 | `NOT_FOUND`, `PROFILE_NOT_FOUND`, `SESSION_NOT_FOUND`, `PAGE_NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `PROFILE_IN_USE`, `SESSION_NOT_RUNNING`, `SESSION_PAUSED`, `SESSION_STOPPED`, `PAGE_BUSY`, `PAGE_CRASHED`, `BROWSER_CRASHED`, `HISTORY_UNAVAILABLE` |
| 413 / 415 | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` |
| 502 / 503 / 504 | `NAVIGATION_FAILED` / `BROWSER_LAUNCH_FAILED` / `NAVIGATION_TIMEOUT` |
| 500 | `CAPTURE_FAILED`, `INSPECTION_FAILED`, `INTERNAL` |

`retryable: true` means the same request can succeed later (after resume, after
the busy operation ends, after a restart, or on a transient network error).

## Endpoints
Path prefix `/v1`. `{s}` = session ID, `{p}` = page ID. "Gated" operations are
refused while the session is paused or stopping, and allow one at a time per page.

| Operation | Method & path | Body / query | Gated |
|---|---|---|---|
| health | `GET /health` (no token) | — | |
| get_openapi | `GET /openapi.json` (no token) | — | |
| get_status | `GET /status` | — | |
| stop_all | `POST /stop` | — | |
| list_profiles / create_profile | `GET` / `POST /profiles` | `{projectId, displayName?}` | |
| get_profile / delete_profile | `GET` / `DELETE /profiles/{projectId}` | — | |
| list_sessions | `GET /sessions` | — | |
| create_browser | `POST /sessions` | `{kind: persistent\|ephemeral, projectId?, headless?, viewport?, allowedOrigins?}` | |
| get_session / close_browser | `GET` / `DELETE /sessions/{s}` | — | |
| restart_browser | `POST /sessions/{s}/restart` | — (only when `disconnected`) | |
| pause / resume / stop | `POST /sessions/{s}/pause\|resume\|stop` | — | |
| get_network_metadata | `GET /sessions/{s}/network` | `?pageId&sinceSeq&failedOnly&resourceTypes&limit` | |
| list_pages / open_page | `GET` / `POST /sessions/{s}/pages` | `{url?, waitUntil?, timeoutMs?, retries?}` | open: yes |
| close_page | `DELETE /sessions/{s}/pages/{p}` | — | |
| navigate | `POST …/pages/{p}/navigate` | `{url, waitUntil?, timeoutMs?, retries?}` | yes |
| go_back / go_forward / reload / recover_page | `POST …/pages/{p}/back\|forward\|reload\|recover` | `{waitUntil?, timeoutMs?}` | yes |
| get_navigation_history | `GET …/pages/{p}/history` | `?sinceSeq` | |
| get_page_metadata | `GET …/pages/{p}/metadata` | — | yes |
| get_dom_snapshot | `GET …/pages/{p}/dom` | `?maxNodes&maxTextLength` | yes |
| get_accessibility_snapshot | `GET …/pages/{p}/accessibility` | `?maxNodes` | yes |
| get_interactive_elements | `GET …/pages/{p}/interactive-elements` | `?maxElements` | yes |
| wait_for_stable | `POST …/pages/{p}/wait-for-stable` | `{timeoutMs?, quietMs?, longRequestMs?}` | yes |
| capture_screenshot | `POST …/pages/{p}/screenshot` | `{mode?: viewport\|full_page, viewport?, maxFullPageHeight?}` | yes |
| inspect_page | `POST …/pages/{p}/inspect` | `{settle?, screenshot?, screenshotViewport?, include?, dom?, maxAccessibilityNodes?, maxInteractiveElements?}` | yes |
| list_captures | `GET /captures/{projectId\|_ephemeral}/{s}` | — | |
| get_capture | `GET /captures/{scope}/{s}/{file}` | file from `screenshot.file` / `observation.file` | |

## Pause, resume, stop
- **pause**: new automated operations get `409 SESSION_PAUSED` (retryable). An
  operation already running finishes. The browser window stays open and usable
  by the person. Reading recorded history/network/captures still works.
- **resume**: operations are accepted again.
- **stop**: emergency stop. Callers waiting on an operation get
  `409 SESSION_STOPPED` immediately, page loads are stopped, the browser is
  closed and the session removed. Profiles and captures are kept.
- **stop_all** (`POST /v1/stop`, the UI's red button, or Ctrl+C on `serve`):
  stop every session.

## Example
```bash
T=$(cat .ncrawl-data/api-token); A="Authorization: Bearer $T"; J="content-type: application/json"
curl -s -H "$A" -H "$J" -d '{"projectId":"acme"}' http://127.0.0.1:4700/v1/profiles
S=$(curl -s -H "$A" -H "$J" -d '{"kind":"persistent","projectId":"acme"}' http://127.0.0.1:4700/v1/sessions | jq -r .data.sessionId)
P=$(curl -s -H "$A" http://127.0.0.1:4700/v1/sessions/$S | jq -r '.data.pages[0].pageId')
curl -s -H "$A" -H "$J" -d '{"url":"https://erp.example.com/"}' http://127.0.0.1:4700/v1/sessions/$S/pages/$P/navigate
curl -s -H "$A" -H "$J" -d '{"screenshot":"full_page"}' http://127.0.0.1:4700/v1/sessions/$S/pages/$P/inspect | jq .data.navigationLinks
curl -s -H "$A" -X POST http://127.0.0.1:4700/v1/sessions/$S/stop
```
