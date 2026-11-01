import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { API_VERSION, buildRouter } from '../../src/api/routes.ts';
import { startApiServer, type ApiServer } from '../../src/api/server.ts';
import { NcrawlApiError, NcrawlBrowserClient, type PageObservation } from '../../src/client/index.ts';
import { checkContracts } from '../../src/contracts/generate.ts';
import { buildOpenApi } from '../../src/contracts/openapi.ts';
import {
  deriveEdges, EdgesBulkSchema, ExportManifestSchema, NodesBulkSchema, pageNodeId, toPageNode, uuidV5, type PageNode,
} from '../../src/contracts/sync.ts';
import { createHarness, type Harness } from '../helpers.ts';

let h: Harness;
let api: ApiServer;
let client: NcrawlBrowserClient;

before(async () => {
  h = await createHarness({ NCRAWL_API_PORT: '0' });
  api = await startApiServer(h);
  client = new NcrawlBrowserClient({ baseUrl: api.url, token: api.token });
});
after(async () => {
  await api.close();
  await h.dispose();
});

describe('published contracts', () => {
  test('docs/contracts/* match what the code generates', async () => {
    assert.deepEqual(await checkContracts(), [], 'run: npm run contracts -w @ncrawl/browser');
  });

  test('OpenAPI covers every route once, with resolvable refs and correct auth', async () => {
    const router = buildRouter({} as never);
    const doc = buildOpenApi(router, API_VERSION) as any;
    assert.equal(doc.openapi, '3.1.0');
    const ops = Object.values(doc.paths).flatMap((p: any) => Object.values(p)) as any[];
    assert.deepEqual(ops.map((o) => o.operationId).sort(), router.routes.map((r) => r.op).sort());
    assert.equal(new Set(ops.map((o) => o.operationId)).size, ops.length, 'operationIds unique');
    const refs = [...new Set(JSON.stringify(doc).match(/#\/components\/schemas\/[A-Za-z]+/g) ?? [])];
    assert.deepEqual(refs.filter((r) => !doc.components.schemas[r.split('/').pop()!]), []);
    assert.deepEqual(ops.filter((o) => Array.isArray(o.security) && o.security.length === 0).map((o) => o.operationId).sort(), ['get_openapi', 'health']);
    for (const r of router.routes) if (!r.raw && r.op !== 'get_openapi') assert.ok(r.response, `${r.op} has a response contract`);

    const served = await fetch(`${api.url}/v1/openapi.json`); // no token needed
    assert.equal(served.status, 200);
    assert.deepEqual((await served.json()).data, doc);
  });

  test('response validation turns a drifted response into a visible 500', async () => {
    const original = h.profiles.list.bind(h.profiles);
    h.profiles.list = async () => [{ ...(await h.profiles.create('drift')), cookie: 'x' } as never];
    try {
      const err = await client.listProfiles().then(() => null, (e) => e);
      assert.ok(err instanceof NcrawlApiError);
      assert.equal(err.status, 500);
      assert.equal(err.code, 'INTERNAL');
      assert.equal(err.details.op, 'list_profiles');
    } finally {
      h.profiles.list = original;
    }
  });
});

describe('typed client', () => {
  test('drives the API end to end and surfaces structured errors', async () => {
    assert.deepEqual(await client.health(), { status: 'ok' });
    await client.createProfile('client-proj', 'Client project');
    const s = await client.createBrowser({ kind: 'persistent', projectId: 'client-proj', headless: true });
    const pageId = s.pages[0]!.pageId;
    const nav = await client.navigate(s.sessionId, pageId, { url: `${h.erp.url}/static/help` });
    assert.equal(nav.httpStatus, 200);
    const obs = await client.inspectPage(s.sessionId, pageId, { screenshot: 'viewport', include: { dom: false } });
    assert.equal(obs.status, 'complete');
    const png = await client.getCapture(obs.screenshot!.file);
    assert.equal(png.contentType, 'image/png');
    assert.equal(Buffer.from(png.data).subarray(1, 4).toString(), 'PNG');

    const notAllowed = await client.navigate(s.sessionId, pageId, { url: 'file:///etc/passwd' }).catch((e) => e);
    assert.ok(notAllowed instanceof NcrawlApiError);
    assert.deepEqual([notAllowed.status, notAllowed.code, notAllowed.retryable], [403, 'URL_NOT_ALLOWED', false]);
    await client.pause(s.sessionId);
    const paused = await client.reload(s.sessionId, pageId).catch((e) => e);
    assert.deepEqual([paused.status, paused.code, paused.retryable], [409, 'SESSION_PAUSED', true]);
    await client.closeBrowser(s.sessionId);

    const bad = new NcrawlBrowserClient({ baseUrl: api.url, token: 'wrong-token' });
    assert.equal((await bad.status().catch((e) => e)).code, 'UNAUTHORIZED');
    const down = new NcrawlBrowserClient({ baseUrl: 'http://127.0.0.1:1', token: 'x' });
    const net = await down.status().catch((e) => e);
    assert.deepEqual([net.status, net.code, net.retryable], [0, 'NETWORK_ERROR', true]);
  });
});

describe('sync contracts (FastAPI payloads)', () => {
  test('UUIDv5 matches the RFC 4122 test vector', () => {
    assert.equal(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  test('observations become valid PageNodes and only observed edges', async () => {
    const crawlSessionId = '0b9f0d6e-3a7c-4c55-9a51-2f6f3f0d9c11';
    const s = await client.createBrowser({ kind: 'ephemeral', headless: true });
    const { page } = await client.openPage(s.sessionId, { url: `${h.erp.url}/login` });
    // Plays the user logging in by hand in the session's window.
    const pw = h.sessions.pageHandle(s.sessionId, page.pageId);
    await pw.getByLabel('Username').fill('demo');
    await pw.getByLabel('Password').fill('demo');
    await Promise.all([pw.waitForURL(/\/app/), pw.getByRole('button', { name: 'Sign in' }).click()]);

    const routes = ['/app', '/app/reports', '/app/settings', '/static/help', '/static/about'];
    const pages: { node: PageNode; observation: PageObservation }[] = [];
    for (const [i, route] of routes.entries()) {
      await client.navigate(s.sessionId, page.pageId, { url: h.erp.url + route });
      const observation = await client.inspectPage(s.sessionId, page.pageId, { include: { dom: false } });
      const node = toPageNode(observation as never, { crawlSessionId, depth: i === 0 ? 0 : 1, navPath: route.startsWith('/app/') ? [route.split('/')[2]!] : [] });
      pages.push({ node, observation });
    }
    await client.closeBrowser(s.sessionId);

    const nodes = pages.map((p) => p.node);
    NodesBulkSchema.parse({ nodes });
    assert.ok(nodes.every((n) => n.status === 'captured' && n.screenshot_ref && n.capture_method === 'viewport'));
    assert.equal(nodes[0]!.id, pageNodeId(crawlSessionId, `${h.erp.url}/app`), 'node IDs are deterministic');
    assert.equal(nodes[1]!.module, 'reports');

    const edges = deriveEdges(crawlSessionId, pages as never);
    EdgesBulkSchema.parse({ edges });
    const pathOf = (id: string) => new URL(nodes.find((n) => n.id === id)!.normalized_url).pathname;
    const pairs = edges.map((e) => `${pathOf(e.source_node_id)} -> ${pathOf(e.target_node_id)} [${e.interaction_type}] ${e.label}`).sort();
    for (const expected of [
      '/app -> /app/reports [menu] Reports',
      '/app -> /static/help [menu] Help',
      '/static/help -> /static/about [link] About',
      '/static/help -> /app [link] Back to app',
      '/static/about -> /static/help [link] Help',
    ]) assert.ok(pairs.includes(expected), `missing edge: ${expected}\n${pairs.join('\n')}`);
    assert.ok(!edges.some((e) => e.source_node_id === e.target_node_id), 'no self loops');
    assert.equal(new Set(edges.map((e) => `${e.source_node_id}>${e.target_node_id}`)).size, edges.length, 'no duplicate edges');
    assert.deepEqual(deriveEdges(crawlSessionId, pages as never), edges, 'deterministic: re-sync upserts the same IDs');

    ExportManifestSchema.parse({
      manifest_version: 1,
      session_id: crawlSessionId,
      origin: h.erp.url,
      created_at: new Date().toISOString(),
      pages: nodes.map((n) => ({
        node_id: n.id, url: n.original_url, title: n.title, parent_node_id: n.parent_node_id, source_node_id: n.source_node_id,
        depth: n.depth, status: n.status, image_filename: n.screenshot_ref && path.basename(n.screenshot_ref), errors: [],
      })),
    });
    const all = JSON.stringify({ nodes, edges });
    assert.ok(!/erp_session|cookie|password|Bearer/i.test(all), 'no secrets in sync payloads');
  });
});

describe('MCP adapter (agents)', () => {
  let proc: ChildProcessWithoutNullStreams;
  const pending = new Map<number, (msg: any) => void>();
  let nextId = 1;
  const rpc = (method: string, params?: unknown): Promise<any> => {
    const id = nextId++;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
    return new Promise((resolve) => pending.set(id, resolve));
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  const parsed = (result: any) => JSON.parse(result.content[0].text);
  const nonJson: string[] = [];

  before(() => {
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/mcp/server.ts');
    proc = spawn(process.execPath, [entry], { env: { ...process.env, NCRAWL_API_URL: api.url, NCRAWL_API_TOKEN: api.token } });
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { nonJson.push(line); return; }
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    });
  });
  after(() => {
    proc.kill();
  });

  test('handshake, tool list without click/type tools, and safety instructions', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'ncrawl-browser');
    assert.match(init.result.instructions, /UNTRUSTED DATA/);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const { tools } = (await rpc('tools/list')).result;
    const names = tools.map((t: any) => t.name);
    assert.ok(names.includes('ncrawl_inspect_page') && names.includes('ncrawl_stop'));
    assert.ok(!names.some((n: string) => /click|type|fill|submit|press|select|evaluate|script/.test(n)), names.join(','));
    assert.ok(tools.every((t: any) => t.inputSchema?.type === 'object'));
    assert.equal((await rpc('nope/method')).error.code, -32601);
  });

  test('agent opens a session, navigates, inspects (with screenshot), and stops', async () => {
    const opened = parsed(await call('ncrawl_open_session', { headless: true }));
    assert.match(opened.sessionId, /^ses_/);
    const nav = parsed(await call('ncrawl_navigate', { sessionId: opened.sessionId, pageId: opened.pageId, url: `${h.erp.url}/static/help` }));
    assert.equal(nav.untrusted_page_content, true);
    assert.equal(nav.httpStatus, 200);

    const insp = await call('ncrawl_inspect_page', { sessionId: opened.sessionId, pageId: opened.pageId, includeScreenshot: true });
    const summary = parsed(insp);
    assert.equal(summary.untrusted_page_content, true);
    assert.equal(summary.title, 'Help — Mock ERP');
    assert.ok(summary.navigationLinks.some((l: any) => l.label === 'External documentation' && l.excluded === 'external'));
    assert.equal(insp.content[1].type, 'image');
    assert.equal(Buffer.from(insp.content[1].data, 'base64').subarray(1, 4).toString(), 'PNG');

    const noShot = await call('ncrawl_inspect_page', { sessionId: opened.sessionId, pageId: opened.pageId });
    assert.equal(noShot.content.length, 1, 'screenshots are not sent to the agent by default');

    const denied = await call('ncrawl_navigate', { sessionId: opened.sessionId, pageId: opened.pageId, url: 'file:///etc/passwd' });
    assert.equal(denied.isError, true);
    assert.equal(parsed(denied).error.code, 'URL_NOT_ALLOWED');
    assert.equal((await call('ncrawl_navigate', { sessionId: opened.sessionId })).isError, true, 'invalid arguments are a tool error');

    const stopped = parsed(await call('ncrawl_stop', { sessionId: opened.sessionId }));
    assert.equal(stopped.status, 'closed');
    assert.deepEqual(nonJson, [], 'stdout carries protocol messages only');
  });
});
