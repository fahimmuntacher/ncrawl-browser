import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { SPA_ROUTES, STATIC_ROUTES } from '@ncrawl/mock-erp';
import { isNcrawlError } from '../../src/errors.ts';
import { createHarness, humanLogin, waitFor, type Harness } from '../helpers.ts';

let h: Harness;
before(async () => {
  h = await createHarness();
});
after(async () => {
  await h.dispose();
});

describe('navigation (ephemeral session, headless)', () => {
  test('opens a server-rendered page and reports status, title and timing', async () => {
    const s = await h.sessions.createSession({ kind: 'ephemeral' });
    const { page, navigation } = await h.sessions.openPage(s.sessionId, `${h.erp.url}/static/help`);
    assert.equal(navigation?.httpStatus, 200);
    assert.equal(navigation?.title, 'Help — Mock ERP');
    assert.equal(navigation?.redirected, false);
    assert.equal(navigation?.attempts, 1);
    assert.equal(h.sessions.getSession(s.sessionId).pages.find((p) => p.pageId === page.pageId)?.status, 'open');
    await h.sessions.closeSession(s.sessionId);
  });

  test('HTTP errors are evidence, not exceptions', async () => {
    const s = await h.sessions.createSession({ kind: 'ephemeral' });
    const { navigation } = await h.sessions.openPage(s.sessionId, `${h.erp.url}/static/broken`);
    assert.equal(navigation?.httpStatus, 500);
    const { page } = await h.sessions.openPage(s.sessionId);
    const r = await h.sessions.navigate(s.sessionId, page.pageId, { url: `${h.erp.url}/nope` });
    assert.equal(r.httpStatus, 404);
    await h.sessions.closeSession(s.sessionId);
  });

  test('redirects are reported (unauthenticated /app -> /login)', async () => {
    const s = await h.sessions.createSession({ kind: 'ephemeral' });
    const { navigation } = await h.sessions.openPage(s.sessionId, `${h.erp.url}/app/hr/employees`);
    assert.equal(navigation?.redirected, true);
    assert.match(navigation!.finalUrl, /\/login\?next=/);
    await h.sessions.closeSession(s.sessionId);
  });

  test('URL policy is enforced before Chromium sees the URL', async () => {
    const s = await h.sessions.createSession({ kind: 'ephemeral', allowedOrigins: [h.erp.url] });
    const { page } = await h.sessions.openPage(s.sessionId);
    await assert.rejects(h.sessions.navigate(s.sessionId, page.pageId, { url: 'file:///etc/passwd' }), (e) => isNcrawlError(e, 'URL_NOT_ALLOWED'));
    await assert.rejects(h.sessions.navigate(s.sessionId, page.pageId, { url: 'https://example.com/' }), (e) => isNcrawlError(e, 'URL_NOT_ALLOWED'));
    await assert.rejects(h.sessions.navigate(s.sessionId, page.pageId, { url: `${h.erp.url}/x`, timeoutMs: 5 }), (e) => isNcrawlError(e, 'INVALID_INPUT'));
    await h.sessions.closeSession(s.sessionId);
  });

  test('timeout is reported with a stable code', async () => {
    const s = await h.sessions.createSession({ kind: 'ephemeral' });
    const { page } = await h.sessions.openPage(s.sessionId);
    await assert.rejects(
      h.sessions.navigate(s.sessionId, page.pageId, { url: `${h.erp.url}/slow?ms=4000`, timeoutMs: 1000, retries: 0 }),
      (e) => isNcrawlError(e, 'NAVIGATION_TIMEOUT') && e.details.attempts === 1,
    );
    // The page is still usable afterwards.
    const ok = await h.sessions.navigate(s.sessionId, page.pageId, { url: `${h.erp.url}/static/about` });
    assert.equal(ok.httpStatus, 200);
    await h.sessions.closeSession(s.sessionId);
  });

  test('transient network failures are retried within the limit', async () => {
    const s = await h.sessions.createSession({ kind: 'ephemeral' });
    const { page } = await h.sessions.openPage(s.sessionId);
    const r = await h.sessions.navigate(s.sessionId, page.pageId, { url: `${h.erp.url}/flaky?key=a&fail=1`, retries: 2 });
    assert.equal(r.httpStatus, 200);
    assert.equal(r.attempts, 2);
    await assert.rejects(
      h.sessions.navigate(s.sessionId, page.pageId, { url: `${h.erp.url}/flaky?key=b&fail=5`, retries: 1 }),
      (e) => isNcrawlError(e, 'NAVIGATION_FAILED') && e.details.attempts === 2,
    );
    await h.sessions.closeSession(s.sessionId);
  });

  test('back/forward follow real history and refuse when there is none', async () => {
    const s = await h.sessions.createSession({ kind: 'ephemeral' });
    const { page } = await h.sessions.openPage(s.sessionId, `${h.erp.url}/static/help`);
    await h.sessions.navigate(s.sessionId, page.pageId, { url: `${h.erp.url}/static/about` });
    assert.match((await h.sessions.goBack(s.sessionId, page.pageId)).finalUrl, /\/static\/help$/);
    assert.match((await h.sessions.goForward(s.sessionId, page.pageId)).finalUrl, /\/static\/about$/);
    await assert.rejects(h.sessions.goForward(s.sessionId, page.pageId), (e) => isNcrawlError(e, 'HISTORY_UNAVAILABLE'));
    await h.sessions.goBack(s.sessionId, page.pageId);
    await assert.rejects(h.sessions.goBack(s.sessionId, page.pageId), (e) => isNcrawlError(e, 'HISTORY_UNAVAILABLE'));
    const r = await h.sessions.reload(s.sessionId, page.pageId);
    assert.equal(r.httpStatus, 200);
    await h.sessions.closeSession(s.sessionId);
  });

  test('pages opened by the site (target=_blank) are tracked with their opener', async () => {
    const s = await h.sessions.createSession({ kind: 'ephemeral' });
    const { page } = await h.sessions.openPage(s.sessionId, `${h.erp.url}/static/help`);
    await h.sessions.pageHandle(s.sessionId, page.pageId).locator('#popup-link').click();
    await waitFor(() => h.sessions.listPages(s.sessionId).length === 2, 5000, 'popup page');
    const popup = h.sessions.listPages(s.sessionId).find((p) => p.pageId !== page.pageId)!;
    assert.equal(popup.openerPageId, page.pageId);
    await h.sessions.closeSession(s.sessionId);
  });

  test('ephemeral sessions are isolated from each other', async () => {
    const a = await h.sessions.createSession({ kind: 'ephemeral' });
    const b = await h.sessions.createSession({ kind: 'ephemeral' });
    const pa = (await h.sessions.openPage(a.sessionId, `${h.erp.url}/login`)).page;
    await humanLogin(h.sessions.pageHandle(a.sessionId, pa.pageId));
    const nb = (await h.sessions.openPage(b.sessionId, `${h.erp.url}/app`)).navigation!;
    assert.match(nb.finalUrl, /\/login/);
    await h.sessions.closeSession(a.sessionId);
    await h.sessions.closeSession(b.sessionId);
  });
});

describe('persistent project profiles and manual login', () => {
  test('a manual login is kept in the project profile across browser restarts; other projects stay logged out', async () => {
    await h.profiles.create('acme');
    await h.profiles.create('other');
    const loginsBefore = h.erp.stats.logins;

    // 1. First run: not logged in -> login page. The "user" logs in by hand.
    let s = await h.sessions.createSession({ kind: 'persistent', projectId: 'acme' });
    assert.equal(s.pages.length, 1, 'persistent context starts with one tab');
    const pageId = s.pages[0]!.pageId;
    let nav = await h.sessions.navigate(s.sessionId, pageId, { url: `${h.erp.url}/app/finance/invoices` });
    assert.match(nav.finalUrl, /\/login/);
    await humanLogin(h.sessions.pageHandle(s.sessionId, pageId));
    assert.match(h.sessions.listPages(s.sessionId)[0]!.url, /\/app\/finance\/invoices$/);
    assert.equal((await h.profiles.get('acme')).inUse, true);
    await h.sessions.closeSession(s.sessionId);
    assert.equal((await h.profiles.get('acme')).inUse, false);

    // 2. New browser process, same profile: still logged in.
    s = await h.sessions.createSession({ kind: 'persistent', projectId: 'acme' });
    nav = await h.sessions.navigate(s.sessionId, s.pages[0]!.pageId, { url: `${h.erp.url}/app/finance/invoices` });
    assert.equal(nav.redirected, false);
    assert.equal(nav.httpStatus, 200);
    await h.sessions.closeSession(s.sessionId);

    // 3. A different project's profile does not share the login.
    const o = await h.sessions.createSession({ kind: 'persistent', projectId: 'other' });
    nav = await h.sessions.navigate(o.sessionId, o.pages[0]!.pageId, { url: `${h.erp.url}/app` });
    assert.match(nav.finalUrl, /\/login/);
    await h.sessions.closeSession(o.sessionId);

    assert.equal(h.erp.stats.logins - loginsBefore, 1, 'exactly one (manual) login');
    assert.equal(h.erp.stats.mutations, 0);
  });

  test('NCrawl does not write profile secrets into its own files or logs', async () => {
    const meta = await readFile(`${h.profiles.root}/acme/profile.json`, 'utf8');
    assert.ok(!/erp_session|cookie/i.test(meta));
    assert.deepEqual((await readdir(`${h.profiles.root}/acme`)).sort(), ['profile.json', 'user-data']);
    const logs = h.logLines.join('\n');
    assert.ok(!logs.includes('erp_session'), 'cookie name must not appear in logs');
  });

  test('a profile cannot be opened twice', async () => {
    const s = await h.sessions.createSession({ kind: 'persistent', projectId: 'acme' });
    await assert.rejects(h.sessions.createSession({ kind: 'persistent', projectId: 'acme' }), (e) => isNcrawlError(e, 'PROFILE_IN_USE'));
    await h.sessions.closeSession(s.sessionId);
  });

  test('persistent session requires an existing profile', async () => {
    await assert.rejects(h.sessions.createSession({ kind: 'persistent', projectId: 'missing' }), (e) => isNcrawlError(e, 'PROFILE_NOT_FOUND'));
    await assert.rejects(h.sessions.createSession({ kind: 'persistent' }), (e) => isNcrawlError(e, 'INVALID_INPUT'));
  });

  test(`all ${SPA_ROUTES.length} SPA routes and ${STATIC_ROUTES.length} static routes load with the saved login`, async () => {
    const s = await h.sessions.createSession({ kind: 'persistent', projectId: 'acme' });
    const pageId = s.pages[0]!.pageId;
    const page = h.sessions.pageHandle(s.sessionId, pageId);
    for (const route of [...SPA_ROUTES, ...STATIC_ROUTES]) {
      const nav = await h.sessions.navigate(s.sessionId, pageId, { url: h.erp.url + route });
      assert.equal(nav.httpStatus, 200, route);
      assert.equal(nav.redirected, false, route);
      await page.locator('h1').first().waitFor();
    }
    assert.equal(h.erp.stats.mutations, 0);
    await h.sessions.closeSession(s.sessionId);
  });

  test('client-side (pushState) navigation creates history entries that back/forward can traverse', async () => {
    const s = await h.sessions.createSession({ kind: 'persistent', projectId: 'acme' });
    const pageId = s.pages[0]!.pageId;
    await h.sessions.navigate(s.sessionId, pageId, { url: `${h.erp.url}/app` });
    const page = h.sessions.pageHandle(s.sessionId, pageId);
    await page.getByTestId('toggle-HR').click();
    await page.getByTestId('toggle-Payroll').click();
    await page.getByRole('link', { name: 'Payslips' }).click();
    await page.waitForURL(/\/app\/hr\/payroll\/payslips$/);
    await page.getByRole('heading', { name: 'Payslips' }).waitFor();
    const back = await h.sessions.goBack(s.sessionId, pageId);
    assert.match(back.finalUrl, /\/app$/);
    assert.equal(back.httpStatus, null, 'same-document navigation has no HTTP response');
    const fwd = await h.sessions.goForward(s.sessionId, pageId);
    assert.match(fwd.finalUrl, /\/payslips$/);
    await h.sessions.closeSession(s.sessionId);
  });
});

describe('crash detection and recovery', () => {
  test('renderer crash: page is marked crashed, refuses work, and recovers at its last URL', async () => {
    const s = await h.sessions.createSession({ kind: 'ephemeral' });
    const { page } = await h.sessions.openPage(s.sessionId, `${h.erp.url}/static/changelog`);
    const pw = h.sessions.pageHandle(s.sessionId, page.pageId);
    const cdp = await pw.context().newCDPSession(pw);
    void cdp.send('Page.crash').catch(() => {}); // never settles: the renderer dies under it
    await waitFor(() => h.sessions.listPages(s.sessionId)[0]?.status === 'crashed', 5000, 'crash event');
    await assert.rejects(h.sessions.reload(s.sessionId, page.pageId), (e) => isNcrawlError(e, 'PAGE_CRASHED'));
    const rec = await h.sessions.recoverPage(s.sessionId, page.pageId);
    assert.equal(rec.page.pageId, page.pageId);
    assert.equal(rec.page.status, 'open');
    assert.match(rec.navigation!.finalUrl, /\/static\/changelog$/);
    assert.equal(rec.navigation!.httpStatus, 200);
    await h.sessions.closeSession(s.sessionId);
  });

  test('browser process killed: session becomes disconnected, profile is released, restart works', async () => {
    const s = await h.sessions.createSession({ kind: 'persistent', projectId: 'acme' });
    const pid = await findChromiumPid(h.profiles.userDataDir('acme'));
    assert.ok(pid, 'found the Chromium browser process for the profile');
    process.kill(pid, 'SIGKILL');
    await waitFor(() => h.sessions.getSession(s.sessionId).status === 'disconnected', 10_000, 'disconnect');
    const info = h.sessions.getSession(s.sessionId);
    assert.match(info.endReason ?? '', /unexpectedly/);
    await assert.rejects(h.sessions.openPage(s.sessionId), (e) => isNcrawlError(e, 'BROWSER_CRASHED') && e.retryable);

    const restarted = await h.sessions.restartSession(s.sessionId);
    assert.equal(restarted.status, 'running');
    assert.equal(restarted.restarts, 1);
    const nav = await h.sessions.navigate(s.sessionId, restarted.pages[0]!.pageId, { url: `${h.erp.url}/app/reports` });
    assert.equal(nav.redirected, false, 'login survived the crash');
    await h.sessions.closeSession(s.sessionId);
    assert.equal((await h.profiles.get('acme')).inUse, false);
  });
});

describe('headed mode', { skip: process.env.NCRAWL_TEST_HEADED === '1' ? false : 'set NCRAWL_TEST_HEADED=1 (opens a visible window)' }, () => {
  test('launches a visible browser window', async () => {
    const s = await h.sessions.createSession({ kind: 'ephemeral', headless: false });
    assert.equal(s.headless, false);
    const { navigation } = await h.sessions.openPage(s.sessionId, `${h.erp.url}/static/help`);
    assert.equal(navigation?.httpStatus, 200);
    const visible = await h.sessions.pageHandle(s.sessionId, h.sessions.listPages(s.sessionId)[0]!.pageId)
      .evaluate(() => document.visibilityState);
    assert.equal(visible, 'visible');
    await h.sessions.closeSession(s.sessionId);
  });
});

/**
 * Linux test helper: the browser process is the one whose command line names this user-data dir and has no --type=.
 * Chromium rewrites its process title, so /proc/<pid>/cmdline may be space-joined rather than NUL-separated.
 */
async function findChromiumPid(userDataDir: string): Promise<number | null> {
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cmd = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).replaceAll('\0', ' ');
      if (cmd.includes(`--user-data-dir=${userDataDir}`) && !cmd.includes('--type=')) return Number(entry);
    } catch {
      // process exited
    }
  }
  return null;
}
