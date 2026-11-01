/** Phase 5: failure and recovery behaviour, and a soak run, against the mock ERP. */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { SPA_ROUTES, startMockErp, STATIC_ROUTES } from '@ncrawl/mock-erp';
import { isNcrawlError } from '../../src/errors.ts';
import { createHarness, humanLogin, waitFor, type Harness } from '../helpers.ts';

let h: Harness;
before(async () => {
  h = await createHarness();
});
after(async () => {
  await h.dispose();
});

describe('network outage and recovery', () => {
  test('server goes down: retryable failure after bounded retries; server comes back: same tab works again', async () => {
    const erp = await startMockErp();
    const port = new URL(erp.url).port;
    const s = await h.sessions.createSession({ kind: 'ephemeral' });
    const { page } = await h.sessions.openPage(s.sessionId, `${erp.url}/static/help`);

    await erp.close();
    const t0 = Date.now();
    const down = await h.sessions.navigate(s.sessionId, page.pageId, { url: `${erp.url}/static/about`, retries: 2 }).catch((e) => e);
    assert.ok(isNcrawlError(down, 'NAVIGATION_FAILED'), String(down));
    assert.equal(down.retryable, true);
    assert.equal(down.details.netError, 'net::ERR_CONNECTION_REFUSED');
    assert.equal(down.details.attempts, 3, 'initial attempt + 2 retries');
    assert.ok(Date.now() - t0 < 5000, 'bounded backoff');

    const back = await startMockErp({ port: Number(port) });
    try {
      const ok = await h.sessions.navigate(s.sessionId, page.pageId, { url: `${back.url}/static/about` });
      assert.equal(ok.httpStatus, 200);
      const obs = await h.inspector.inspectPage(s.sessionId, page.pageId, { screenshot: 'none' });
      assert.equal(obs.status, 'complete');
      assert.equal(obs.stability?.stable, true);
      assert.ok(h.sessions.getNetworkMetadata(s.sessionId, { pageId: page.pageId, failedOnly: true }).records.length >= 1, 'failed attempts were recorded');
    } finally {
      await h.sessions.closeSession(s.sessionId);
      await back.close();
    }
  });
});

describe('crashes during work', () => {
  test('renderer crash in the middle of an inspection: no hang, failure is reported, page recovers', async () => {
    const erp = await startMockErp();
    try {
      const s = await h.sessions.createSession({ kind: 'ephemeral' });
      const { page } = await h.sessions.openPage(s.sessionId, `${erp.url}/static/help`);
      const pw = h.sessions.pageHandle(s.sessionId, page.pageId);
      // Keep the page busy so the inspection is mid-way (waiting for stability) when the renderer dies.
      await pw.evaluate(() => { setInterval(() => { document.body.dataset.tick = String(Date.now()); }, 50); });
      const t0 = Date.now();
      const inspecting = h.inspector.inspectPage(s.sessionId, page.pageId).then((o) => o, (e) => e);
      await sleep(300);
      const cdp = await pw.context().newCDPSession(pw);
      void cdp.send('Page.crash').catch(() => {});
      const result = await inspecting;
      assert.ok(Date.now() - t0 < 15_000, `inspection returned after ${Date.now() - t0} ms`);
      if (isNcrawlError(result)) {
        assert.equal(result.code, 'PAGE_CRASHED');
      } else {
        assert.notEqual(result.status, 'complete', 'a crashed page is never reported as a complete observation');
        assert.equal(result.stability?.stable, false);
      }
      await waitFor(() => h.sessions.listPages(s.sessionId)[0]?.status === 'crashed', 5000, 'crash recorded');
      const rec = await h.sessions.recoverPage(s.sessionId, page.pageId);
      assert.equal(rec.navigation?.httpStatus, 200);
      assert.equal((await h.inspector.inspectPage(s.sessionId, page.pageId, { screenshot: 'none' })).status, 'complete');
      await h.sessions.closeSession(s.sessionId);
    } finally {
      await erp.close();
    }
  });

  test('browser process killed during a slow navigation: the caller is released, the session restarts', async () => {
    const erp = await startMockErp();
    try {
      await h.profiles.create('crash-nav');
      const s = await h.sessions.createSession({ kind: 'persistent', projectId: 'crash-nav' });
      const pageId = s.pages[0]!.pageId;
      const t0 = Date.now();
      const nav = h.sessions.navigate(s.sessionId, pageId, { url: `${erp.url}/slow?ms=20000`, timeoutMs: 60_000 }).then((r) => r, (e) => e);
      await sleep(400);
      const pid = await findBrowserPid(h.profiles.userDataDir('crash-nav'));
      assert.ok(pid);
      process.kill(pid, 'SIGKILL');
      const result = await nav;
      assert.ok(Date.now() - t0 < 10_000, `navigate returned after ${Date.now() - t0} ms`);
      assert.ok(isNcrawlError(result, 'PAGE_CRASHED'), String(result));
      await waitFor(() => h.sessions.getSession(s.sessionId).status === 'disconnected', 10_000, 'disconnect');
      const restarted = await h.sessions.restartSession(s.sessionId);
      const ok = await h.sessions.navigate(s.sessionId, restarted.pages[0]!.pageId, { url: `${erp.url}/static/help` });
      assert.equal(ok.httpStatus, 200);
      await h.sessions.closeSession(s.sessionId);
    } finally {
      await erp.close();
    }
  });
});

describe('soak', () => {
  test('3 full passes over all 24 mock-ERP routes: every observation complete, no slowdown, bounded memory', async (t) => {
    const erp = await startMockErp();
    try {
      const s = await h.sessions.createSession({ kind: 'ephemeral' });
      const { page } = await h.sessions.openPage(s.sessionId, `${erp.url}/login`);
      await humanLogin(h.sessions.pageHandle(s.sessionId, page.pageId));
      const routes = [...SPA_ROUTES, ...STATIC_ROUTES];
      const passMs: number[] = [];
      const failures: string[] = [];
      const heap0 = process.memoryUsage().heapUsed;
      for (let pass = 0; pass < 3; pass++) {
        const t0 = Date.now();
        for (const r of routes) {
          await h.sessions.navigate(s.sessionId, page.pageId, { url: erp.url + r });
          const obs = await h.inspector.inspectPage(s.sessionId, page.pageId);
          if (obs.status !== 'complete' || !obs.stability?.stable) failures.push(`pass ${pass + 1} ${r}: ${obs.status} ${obs.stability?.reason} ${JSON.stringify(obs.errors)}`);
        }
        passMs.push(Date.now() - t0);
      }
      const heapGrowthMb = (process.memoryUsage().heapUsed - heap0) / 1024 / 1024;
      t.diagnostic(`pass times (s): ${passMs.map((m) => (m / 1000).toFixed(1)).join(', ')}; heap growth: ${heapGrowthMb.toFixed(1)} MB; ${routes.length * 3} observations`);
      assert.deepEqual(failures, []);
      assert.ok(passMs[2]! < passMs[0]! * 1.5, 'no progressive slowdown');
      assert.ok(heapGrowthMb < 150, `heap grew ${heapGrowthMb.toFixed(1)} MB`);
      assert.equal(h.sessions.listPages(s.sessionId).length, 1, 'no leaked tabs');
      const files = await readdir(`${h.captures.root}/_ephemeral/${s.sessionId}`);
      assert.equal(files.filter((f) => f.endsWith('.observation.json')).length, routes.length * 3);
      assert.equal(erp.stats.mutations, 0);
      await h.sessions.closeSession(s.sessionId);
    } finally {
      await erp.close();
    }
  });
});

async function findBrowserPid(userDataDir: string): Promise<number | null> {
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cmd = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).replaceAll('\0', ' ');
      if (cmd.includes(`--user-data-dir=${userDataDir}`) && !cmd.includes('--type=')) return Number(entry);
    } catch {
      // gone
    }
  }
  return null;
}
