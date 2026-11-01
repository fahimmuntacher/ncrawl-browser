import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright';
import { startApiServer, type ApiServer } from '../../src/api/server.ts';
import { createHarness, type Harness } from '../helpers.ts';

let h: Harness;
let api: ApiServer;
const DASHBOARD = 'http://localhost:3000';

before(async () => {
  h = await createHarness({ NCRAWL_API_PORT: '0', NCRAWL_API_ALLOWED_ORIGINS: DASHBOARD });
  api = await startApiServer(h);
});
after(async () => {
  await api.close();
  await h.dispose();
});

interface Raw { status: number; headers: http.IncomingHttpHeaders; body: Buffer; json: any }

/** Raw HTTP so tests can forge Host/Origin headers (fetch does not allow that). */
function raw(method: string, p: string, opts: { headers?: Record<string, string>; body?: string | Buffer; auth?: boolean } = {}): Promise<Raw> {
  const headers: Record<string, string> = { host: `127.0.0.1:${api.port}`, ...(opts.auth === false ? {} : { authorization: `Bearer ${api.token}` }), ...opts.headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: api.port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let json: any = null;
        try { json = JSON.parse(body.toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode!, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const call = (method: string, p: string, body?: unknown) =>
  raw(method, p, body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('API security', () => {
  test('token is required everywhere except /v1/health; token file is owner-only', async () => {
    assert.equal((await raw('GET', '/v1/health', { auth: false })).status, 200);
    const none = await raw('GET', '/v1/status', { auth: false });
    assert.equal(none.status, 401);
    assert.equal(none.json.error.code, 'UNAUTHORIZED');
    assert.equal((await raw('GET', '/v1/status', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await raw('GET', '/v1/status')).status, 200);
    assert.equal(((await stat(api.tokenFile!)).mode & 0o777), 0o600);
  });

  test('DNS rebinding and cross-site requests are refused even with a valid token', async () => {
    const rebound = await raw('GET', '/v1/status', { headers: { host: `evil.example:${api.port}` } });
    assert.equal(rebound.status, 403);
    assert.equal(rebound.json.error.code, 'FORBIDDEN');
    const cross = await raw('POST', '/v1/stop', { headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
    const preflight = await raw('OPTIONS', '/v1/sessions', { auth: false, headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  });

  test('allow-listed dashboard origin gets CORS headers', async () => {
    const pre = await raw('OPTIONS', '/v1/sessions', { auth: false, headers: { origin: DASHBOARD, 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], DASHBOARD);
    assert.match(String(pre.headers['access-control-allow-headers']), /authorization/);
    const r = await raw('GET', '/v1/status', { headers: { origin: DASHBOARD } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], DASHBOARD);
  });

  test('bodies must be JSON, bounded and valid; unknown fields are rejected', async () => {
    assert.equal((await raw('POST', '/v1/profiles', { body: 'projectId=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.equal((await raw('POST', '/v1/profiles', { body: 'x'.repeat(70_000), headers: { 'content-type': 'application/json' } })).status, 413);
    const bad = await raw('POST', '/v1/profiles', { body: '{nope', headers: { 'content-type': 'application/json' } });
    assert.equal(bad.status, 400);
    const extra = await call('POST', '/v1/profiles', { projectId: 'ok', isAdmin: true });
    assert.equal(extra.status, 400);
    assert.match(JSON.stringify(extra.json.error.details), /isAdmin|Unrecognized/);
  });

  test('unknown routes and methods', async () => {
    assert.equal((await call('GET', '/v1/nope')).json.error.code, 'NOT_FOUND');
    const m = await call('DELETE', '/v1/status');
    assert.equal(m.status, 405);
    assert.equal(m.json.error.code, 'METHOD_NOT_ALLOWED');
  });

  test('control UI is served without data and with a strict CSP', async () => {
    const ui = await raw('GET', '/ui', { auth: false });
    assert.equal(ui.status, 200);
    assert.match(String(ui.headers['content-type']), /text\/html/);
    assert.match(String(ui.headers['content-security-policy']), /default-src 'none'/);
    assert.equal(ui.headers['x-frame-options'], 'DENY');
    assert.ok(!ui.body.toString().includes(api.token));
    assert.equal((await raw('GET', '/ui/app.js', { auth: false })).status, 200);
  });
});

describe('API operations end to end', () => {
  test('profile → session → page → navigate → inspect → captures → close', async () => {
    assert.equal((await call('POST', '/v1/profiles', { projectId: 'api-proj', displayName: 'API project' })).status, 201);
    const badProfile = await call('POST', '/v1/profiles', { projectId: '../etc' });
    assert.equal(badProfile.status, 400);
    assert.equal(badProfile.json.error.code, 'INVALID_INPUT');
    assert.ok((await call('GET', '/v1/profiles')).json.data.some((p: any) => p.projectId === 'api-proj'));

    const created = await call('POST', '/v1/sessions', { kind: 'persistent', projectId: 'api-proj', headless: true });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const sid = created.json.data.sessionId;
    assert.equal(created.json.data.control, 'active');
    const pageId = created.json.data.pages[0].pageId;
    const base = `/v1/sessions/${sid}/pages/${pageId}`;

    const nav = await call('POST', `${base}/navigate`, { url: `${h.erp.url}/static/help` });
    assert.equal(nav.status, 200);
    assert.equal(nav.json.data.httpStatus, 200);
    assert.equal((await call('POST', `${base}/navigate`, { url: 'file:///etc/passwd' })).json.error.code, 'URL_NOT_ALLOWED');
    assert.equal((await call('POST', `${base}/navigate`, { url: `${h.erp.url}/x`, script: 'alert(1)' })).status, 400);

    const opened = await call('POST', `/v1/sessions/${sid}/pages`, { url: `${h.erp.url}/static/about` });
    assert.equal(opened.status, 201);
    assert.equal((await call('GET', `/v1/sessions/${sid}/pages`)).json.data.length, 2);
    assert.equal((await call('DELETE', `/v1/sessions/${sid}/pages/${opened.json.data.page.pageId}`)).status, 200);

    assert.equal((await call('GET', `${base}/metadata`)).json.data.title, 'Help — Mock ERP');
    const dom = await call('GET', `${base}/dom?maxNodes=3`);
    assert.equal(dom.json.data.truncated, true);
    assert.equal((await call('GET', `${base}/dom?maxNodes=abc`)).status, 400);
    assert.match((await call('GET', `${base}/accessibility`)).json.data.outline, /heading "Help"/);
    assert.ok((await call('GET', `${base}/interactive-elements`)).json.data.navigationLinks.length >= 4);
    assert.equal((await call('POST', `${base}/wait-for-stable`, { timeoutMs: 5000 })).json.data.stable, true);

    const shot = await call('POST', `${base}/screenshot`, { mode: 'full_page' });
    assert.equal(shot.status, 201);
    const png = await raw('GET', `/v1/captures/${shot.json.data.file}`);
    assert.equal(png.headers['content-type'], 'image/png');
    assert.deepEqual([...png.body.subarray(1, 4)].map((b) => String.fromCharCode(b)).join(''), 'PNG');

    const obs = await call('POST', `${base}/inspect`, { screenshot: 'viewport' });
    assert.equal(obs.status, 201);
    assert.equal(obs.json.data.status, 'complete');
    const saved = await raw('GET', `/v1/captures/${obs.json.data.file}`);
    assert.equal(JSON.parse(saved.body.toString()).observationId, obs.json.data.observationId);

    const list = await call('GET', `/v1/captures/api-proj/${sid}`);
    assert.deepEqual([...new Set(list.json.data.map((f: any) => f.kind))].sort(), ['observation', 'screenshot', 'screenshot-metadata']);
    for (const evil of [`/v1/captures/api-proj/${sid}/..%2F..%2F..%2Fapi-token`, `/v1/captures/..%2F..%2Fprofiles/${sid}/0001_x.png`, `/v1/captures/api-proj/${sid}/0001_static-help.png%00.json`]) {
      assert.equal((await raw('GET', evil)).status, 404, evil);
    }

    const hist = await call('GET', `${base}/history`);
    assert.ok(hist.json.data.some((e: any) => e.initiator === 'ncrawl:navigate'));
    const net = await call('GET', `/v1/sessions/${sid}/network?pageId=${pageId}&limit=50`);
    assert.ok(net.json.data.records.length > 0);
    assert.equal((await call('GET', `/v1/sessions/${sid}/network?evil=1`)).status, 400);

    assert.equal((await call('GET', '/v1/sessions/ses_0000000000000000')).json.error.code, 'SESSION_NOT_FOUND');
    assert.equal((await call('DELETE', `/v1/sessions/${sid}`)).json.data.status, 'closed');
    assert.equal((await call('GET', `/v1/sessions/${sid}`)).status, 404);
  });
});

describe('pause, resume, stop', () => {
  test('pause refuses automation (navigation and inspection); resume allows it again', async () => {
    const sid = (await call('POST', '/v1/sessions', { kind: 'ephemeral', headless: true })).json.data.sessionId;
    const pageId = (await call('POST', `/v1/sessions/${sid}/pages`, { url: `${h.erp.url}/static/help` })).json.data.page.pageId;
    const base = `/v1/sessions/${sid}/pages/${pageId}`;
    assert.equal((await call('POST', `/v1/sessions/${sid}/pause`)).json.data.control, 'paused');
    const refused = await call('POST', `${base}/navigate`, { url: `${h.erp.url}/static/about` });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, 'SESSION_PAUSED');
    assert.equal(refused.json.error.retryable, true);
    assert.equal((await call('POST', `${base}/inspect`, {})).json.error.code, 'SESSION_PAUSED');
    assert.equal((await call('POST', `/v1/sessions/${sid}/pages`, {})).json.error.code, 'SESSION_PAUSED');
    assert.equal((await call('GET', `${base}/history`)).status, 200, 'reading recorded history is still allowed');
    assert.equal((await call('POST', `/v1/sessions/${sid}/resume`)).json.data.control, 'active');
    assert.equal((await call('POST', `${base}/navigate`, { url: `${h.erp.url}/static/about` })).status, 200);
    await call('DELETE', `/v1/sessions/${sid}`);
  });

  test('one operation per page: a concurrent call gets PAGE_BUSY', async () => {
    const sid = (await call('POST', '/v1/sessions', { kind: 'ephemeral', headless: true })).json.data.sessionId;
    const pageId = (await call('POST', `/v1/sessions/${sid}/pages`, {})).json.data.page.pageId;
    const base = `/v1/sessions/${sid}/pages/${pageId}`;
    const slow = call('POST', `${base}/navigate`, { url: `${h.erp.url}/slow?ms=1500` });
    await new Promise((r) => setTimeout(r, 200));
    const busy = await call('POST', `${base}/navigate`, { url: `${h.erp.url}/static/help` });
    assert.equal(busy.status, 409);
    assert.equal(busy.json.error.code, 'PAGE_BUSY');
    assert.equal((await slow).status, 200);
    await call('DELETE', `/v1/sessions/${sid}`);
  });

  test('stop releases an in-flight navigation at once and closes the session', async () => {
    const sid = (await call('POST', '/v1/sessions', { kind: 'ephemeral', headless: true })).json.data.sessionId;
    const pageId = (await call('POST', `/v1/sessions/${sid}/pages`, {})).json.data.page.pageId;
    const t0 = Date.now();
    const slow = call('POST', `/v1/sessions/${sid}/pages/${pageId}/navigate`, { url: `${h.erp.url}/slow?ms=20000`, timeoutMs: 60000 });
    await new Promise((r) => setTimeout(r, 300));
    const stopped = await call('POST', `/v1/sessions/${sid}/stop`);
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.data.status, 'closed');
    assert.equal(stopped.json.data.endReason, 'stopped by user');
    const r = await slow;
    assert.equal(r.json.error.code, 'SESSION_STOPPED');
    assert.ok(Date.now() - t0 < 5000, `stop took ${Date.now() - t0} ms`);
    assert.equal((await call('GET', `/v1/sessions/${sid}`)).status, 404);
  });

  test('stop all closes every session', async () => {
    await call('POST', '/v1/sessions', { kind: 'ephemeral', headless: true });
    await call('POST', '/v1/sessions', { kind: 'ephemeral', headless: true });
    const res = await call('POST', '/v1/stop');
    assert.ok(res.json.data.stopped.length >= 2);
    assert.deepEqual((await call('GET', '/v1/sessions')).json.data, []);
  });
});

describe('control UI', () => {
  test('loads with the token from the URL fragment, hides it, and shows live data', async () => {
    await call('POST', '/v1/profiles', { projectId: 'ui-proj' });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${api.url}/ui#token=${api.token}`);
      await page.getByText('ui-proj').first().waitFor();
      assert.ok(!page.url().includes('token'), 'token removed from the address bar');
      await page.locator('#session-form select[name=kind]').selectOption('ephemeral');
      await page.locator('#session-form input[name=headless]').check();
      await page.getByRole('button', { name: 'Launch browser' }).click();
      await page.locator('#sessions .badge.running').first().waitFor({ timeout: 15000 });
      await page.locator('#open-form input[name=url]').fill(`${h.erp.url}/static/help`);
      await page.getByRole('button', { name: 'Open in new tab' }).click();
      await page.locator('#pages li', { hasText: '/static/help' }).waitFor();
      await page.locator('#pages li', { hasText: '/static/help' }).getByRole('button', { name: 'Inspect' }).click();
      await page.locator('#shot').waitFor({ state: 'visible' });
      assert.match(await page.locator('#output').textContent() ?? '', /"status": "complete"/);
    } finally {
      await browser.close();
      await call('POST', '/v1/stop');
    }
  });
});
