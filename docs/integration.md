# NCrawl Integration Guide (Phase 4)

How the other NCrawl components talk to NCrawl Browser. The machine-readable
contracts live in [`docs/contracts/`](contracts/) and are generated from code
(`npm run contracts -w @ncrawl/browser`); a test fails if they drift.

| File | What | Consumer |
|---|---|---|
| `contracts/openapi.json` | NCrawl Browser HTTP API, OpenAPI 3.1 (also served at `GET /v1/openapi.json`) | Dashboard, any HTTP client, code generators |
| `contracts/sync.schema.json` | Project / CrawlSession / PageNode / NavigationEdge / bulk bodies / export manifest (JSON Schema 2020-12, snake_case) | FastAPI backend, PostgreSQL |
| `contracts/mcp-tools.json` | Tools the MCP adapter exposes | Hermes and other AI agents |

```mermaid
flowchart LR
  DASH[Next.js dashboard<br/>server side] -- "HTTP + token<br/>(@ncrawl/browser/client)" --> NB[NCrawl Browser<br/>127.0.0.1:4700]
  AGENT[Hermes / Claude / other agents] -- "MCP stdio" --> MCP[ncrawl-browser-mcp] -- "HTTP + token" --> NB
  EXT[Extension (future)] -. "same client + contracts" .-> NB
  NB -- "observations" --> MAP[toPageNode / deriveEdges]
  MAP -- "sync payloads (opt-in)" --> API[FastAPI backend] --> PG[(PostgreSQL)]
```

## Stability rules
- **Versioning**: the API is `/v1`; `info.version` in the OpenAPI document is
  `API_VERSION`. Within v1, changes are additive only: new endpoints, new
  optional request fields, new response fields, new enum values. Clients must
  ignore unknown response fields and treat unknown enum values as "other".
  Removing or renaming anything requires `/v2`.
- **Response contracts are enforced**: response schemas are strict and checked
  at compile time against the code's types; with
  `NCRAWL_API_VALIDATE_RESPONSES=true` (on in tests) the server refuses to send
  a response that violates its schema.
- **Errors** are always `{ ok: false, error: { code, message, retryable, details } }`;
  branch on `code` (stable), show `message` (may change), retry only if `retryable`.

## 1. FastAPI backend (sync)
Per ADR 0001 the backend **never drives a browser and never receives cookies**.
It stores what NCrawl decides to sync, after the user opts in.

1. **Models.** Generate Pydantic v2 models from the schema (untested here; the
   tool is `datamodel-code-generator`):
   ```bash
   datamodel-codegen --input docs/contracts/sync.schema.json --input-file-type jsonschema \
     --output-model-type pydantic_v2.BaseModel --output app/schemas/sync.py
   ```
   Field names are snake_case and match the PRD table columns.
2. **Endpoints** (PRD API outline): `POST /api/v1/sessions/{id}/nodes/bulk`
   with body `NodesBulk` (≤ 1000 nodes), `POST /api/v1/sessions/{id}/edges/bulk`
   with `EdgesBulk` (≤ 5000 edges), plus project/session CRUD with `Project` and
   `CrawlSession`.
3. **Idempotency.** Node and edge IDs are UUIDv5 derived from
   `(crawl session, normalized URL)` and `(crawl session, source, target)`.
   Implement bulk endpoints as upserts (`INSERT … ON CONFLICT (id) DO UPDATE`);
   re-sending a session is then safe. Reject a node whose `session_id` differs
   from the path.
4. **Images.** `screenshot_ref` is a local capture-store path. Upload images only
   when the user enabled image sync; store them in object storage, not in
   PostgreSQL (PRD).
5. **Producing payloads** (TypeScript, in the crawler/dashboard server):
   ```ts
   import { toPageNode, deriveEdges, NodesBulkSchema, EdgesBulkSchema } from '@ncrawl/browser/contracts';
   const pages = observations.map((observation, i) => ({
     observation,
     node: toPageNode(observation, { crawlSessionId, depth: depths[i], navPath: paths[i], navLabel: labels[i] }),
   }));
   const nodes = NodesBulkSchema.parse({ nodes: pages.map((p) => p.node) });
   const edges = EdgesBulkSchema.parse({ edges: deriveEdges(crawlSessionId, pages) });
   ```
   Edges are created only for navigation links actually present on the source
   page (excluding logout, external and self links). `menu` = found in a
   sidebar, header, nav landmark or expandable menu; otherwise `link`.

## 2. Next.js dashboard
Use the typed client on the **server side** (route handlers, server actions,
server components) so the API token never reaches browser JavaScript:

```ts
// app/lib/ncrawl.ts (server only)
import 'server-only';
import { NcrawlBrowserClient } from '@ncrawl/browser/client';
export const ncrawl = new NcrawlBrowserClient({
  baseUrl: process.env.NCRAWL_BROWSER_URL ?? 'http://127.0.0.1:4700',
  token: process.env.NCRAWL_API_TOKEN!,   // never NEXT_PUBLIC_*
});
```
- Screenshots: stream `ncrawl.getCapture(file)` from a route handler
  (`/api/captures/[...file]`) to `<img>`.
- Errors: catch `NcrawlApiError` and use `.code` / `.retryable` / `.status`.
- Set the same `NCRAWL_API_TOKEN` (≥ 32 chars) for the browser service and the
  dashboard, or read `<NCRAWL_DATA_DIR>/api-token` on the server.
- Calling the API directly from the browser is possible: add the dashboard
  origin to `NCRAWL_API_ALLOWED_ORIGINS`. The token is then visible to that
  page's JavaScript; prefer the server-side pattern.
- The package ships TypeScript sources: add `transpilePackages: ['@ncrawl/browser']`
  to `next.config` (not yet verified with a real Next.js app — Phase 5).

## 3. Hermes and other AI agents (MCP)
`ncrawl-browser-mcp` (`packages/browser/src/mcp/server.ts`) is an MCP server
over stdio that forwards to the HTTP API. Configure it in the agent's MCP
settings (exact file format depends on the agent):

```json
{
  "command": "node",
  "args": ["/path/to/ncrawl/packages/browser/src/mcp/server.ts"],
  "env": { "NCRAWL_API_URL": "http://127.0.0.1:4700", "NCRAWL_DATA_DIR": "/path/to/ncrawl/.ncrawl-data" }
}
```
The browser service (`serve`) must be running.

Safety design:
- **Tools**: status, list profiles/sessions, open session, navigate, go back,
  inspect page, list interactive elements, pause, resume, stop, close. There are
  **no** click/type/fill/submit/evaluate tools.
- **Untrusted content**: page-derived results carry `untrusted_page_content: true`
  and the server's `instructions` tell the agent never to follow instructions
  found in page content.
- **Privacy**: connecting a cloud-hosted model sends page text (titles, links,
  outlines) to that provider — that is the user's opt-in (PRD FR-07).
  Screenshots are sent only when a call sets `includeScreenshot: true`.
- The user keeps control: pause/stop in the control UI or `POST /v1/stop` also
  stop agent-driven sessions.

## 4. Browser extension (future)
The extension is optional (ADR 0001). If built, it should:
- reuse `@ncrawl/browser/client` against `http://127.0.0.1:<port>` (needs
  `host_permissions` for that origin) to hand off to the controlled browser, or
- if it crawls in the user's own browser, produce the **same** `PageNode` /
  `NavigationEdge` records (`sync.schema.json`) so the dashboard and backend do
  not need a second data path.
