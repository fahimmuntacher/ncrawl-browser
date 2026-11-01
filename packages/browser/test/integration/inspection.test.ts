import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Page } from 'playwright';
import type { InteractiveElement } from '../../src/inspection/interactive.ts';
import { createHarness, humanLogin, type Harness } from '../helpers.ts';

let h: Harness;
let sessionId: string;
let pageId: string;
let page: Page;

const SECRETS = ['SECRET-VALUE-123', 'hunter2-pass', 'secret-user-xyz', 'mock-secret-token-123', 'mock-query-secret'];

before(async () => {
  h = await createHarness();
  await h.profiles.create('insp');
  const s = await h.sessions.createSession({ kind: 'persistent', projectId: 'insp' });
  sessionId = s.sessionId;
  pageId = s.pages[0]!.pageId;
  await h.sessions.navigate(sessionId, pageId, { url: `${h.erp.url}/login` });
  page = h.sessions.pageHandle(sessionId, pageId);
  await humanLogin(page);
});
after(async () => {
  await h.dispose();
});

/** Navigate, then wait for the SPA to finish rendering (as a crawler would). */
const goto = async (route: string) => {
  const r = await h.sessions.navigate(sessionId, pageId, { url: h.erp.url + route });
  await h.inspector.waitForStable(sessionId, pageId);
  return r;
};
/** Plays the user expanding sidebar groups. The mock app re-renders (and re-fetches) on every toggle. */
const expand = async (...groups: string[]) => {
  for (const g of groups) {
    const t = page.getByTestId(`toggle-${g}`);
    if ((await t.getAttribute('aria-expanded')) !== 'true') await t.click();
  }
  await h.inspector.waitForStable(sessionId, pageId);
};
const collapseAll = () => page.evaluate(() => sessionStorage.removeItem('erp-expanded'));

describe('page observation', () => {
  test('waits for the SPA to render, then records metadata, DOM, a11y, elements, screenshot and network', async () => {
    await collapseAll();
    await goto('/app/hr/employees');
    const obs = await h.inspector.inspectPage(sessionId, pageId);
    assert.equal(obs.status, 'complete', JSON.stringify(obs.errors));
    assert.equal(obs.stability?.stable, true);
    assert.equal(obs.metadata?.title, 'Employees — Mock ERP');
    assert.deepEqual(obs.metadata?.text.headings[0], { level: 1, text: 'Employees' });
    assert.ok(!obs.dom!.nodes.some((n) => n.text === 'Loading…'), 'captured after data loaded');
    assert.ok(obs.dom!.nodes.some((n) => n.tag === 'td'), 'table rows present');
    assert.ok(obs.accessibility!.nodes.length > 10);
    assert.ok(obs.interactiveElements!.length > 5);
    assert.equal(obs.navigationSource?.initiator, 'ncrawl:navigate');

    // Screenshot file matches its metadata.
    const shot = obs.screenshot!;
    const png = await readFile(path.join(h.captures.root, shot.file));
    assert.equal(createHash('sha256').update(png).digest('hex'), shot.sha256);
    assert.deepEqual([shot.width, shot.height], [1440, 900]);
    assert.equal(shot.status, 'ok');
    assert.match(shot.file, /^insp\/ses_[a-f0-9]{16}\/\d{4}_app-hr-employees\.png$/);
    assert.equal((await stat(path.join(h.captures.root, shot.file))).mode & 0o777, 0o600);

    // Observation is saved next to the screenshot and round-trips.
    const saved = JSON.parse(await readFile(path.join(h.captures.root, obs.file!), 'utf8'));
    assert.equal(saved.observationId, obs.observationId);
    assert.equal(h.erp.stats.mutations, 0);
  });

  test('no typed value, password, auth header or query token appears anywhere in observations or logs', async () => {
    // A user types into the create form; the login page of a second (ephemeral) session gets credentials typed in.
    await goto('/app/hr/employees');
    await page.getByLabel('Name').fill('SECRET-VALUE-123');
    const obs1 = await h.inspector.inspectPage(sessionId, pageId);

    const eph = await h.sessions.createSession({ kind: 'ephemeral' });
    const { page: lp } = await h.sessions.openPage(eph.sessionId, `${h.erp.url}/login`);
    const loginPage = h.sessions.pageHandle(eph.sessionId, lp.pageId);
    await loginPage.getByLabel('Username').fill('secret-user-xyz');
    await loginPage.getByLabel('Password').fill('hunter2-pass');
    const obs2 = await h.inspector.inspectPage(eph.sessionId, lp.pageId);
    await h.sessions.closeSession(eph.sessionId);

    await goto('/app'); // dashboard sends the bearer header and the ?access_token= request
    const obs3 = await h.inspector.inspectPage(sessionId, pageId);

    const everything = [JSON.stringify(obs1), JSON.stringify(obs2), JSON.stringify(obs3), h.logLines.join('\n')].join('\n');
    for (const s of SECRETS) assert.ok(!everything.includes(s), `leaked: ${s}`);
    // Password masking bullets (which leak length) must not appear either.
    assert.ok(!everything.includes('••••'), 'masked password value leaked');
    assert.equal(h.erp.stats.mutations, 0, 'inspection never submits forms');
  });
});

describe('accessibility snapshot', () => {
  test('roles, names, levels and expanded state come from Chromium', async () => {
    await goto('/app/hr/payroll/payslips');
    await expand('HR', 'Payroll');
    const ax = await h.inspector.getAccessibilitySnapshot(sessionId, pageId);
    assert.match(ax.outline, /- heading "Payslips" \[level=1\]/);
    assert.match(ax.outline, /- navigation "Main navigation"/);
    assert.match(ax.outline, /- navigation "Breadcrumb"/);
    assert.match(ax.outline, /- button "▾ HR" \[expanded=true\]/);
    assert.match(ax.outline, /- button "▸ Inventory" \[expanded=false\]/);
    assert.ok(ax.nodes.every((n) => n.value === undefined || ['slider', 'progressbar', 'meter', 'scrollbar'].includes(n.role)));
  });
});

describe('interactive elements and navigation links', () => {
  test('collapsed menu: groups, regions, risks and exclusions', async () => {
    await collapseAll();
    await goto('/app');
    const r = await h.inspector.getInteractiveElements(sessionId, pageId);
    const groups = r.expandableGroups.map((g) => [g.label, g.expanded, g.region, g.risk]);
    assert.deepEqual(groups, [
      ['HR', false, 'sidebar', 'safe'], ['Inventory', false, 'sidebar', 'safe'], ['Finance', false, 'sidebar', 'safe'],
      ['Reports', false, 'sidebar', 'safe'], ['Settings', false, 'sidebar', 'safe'],
    ]);
    const link = (label: string, region: string) => r.navigationLinks.find((l) => l.label === label && l.region === region);
    assert.equal(link('Reports', 'header')?.excluded, null);
    assert.equal(link('Help', 'header')?.normalizedUrl, `${h.erp.url}/static/help`);
    assert.deepEqual(link('Reports overview', 'sidebar')?.menuPath, ['Reports']);
    assert.equal(link('Dashboard', 'sidebar')?.excluded, 'self');
    const logout = r.elements.find((e) => e.label === 'Log out')!;
    assert.equal(logout.risk, 'logout');
    assert.equal(r.navigationLinks.find((l) => l.elementId === logout.elementId)?.excluded, 'logout');
  });

  test('expanded nested menu: menu path and depth', async () => {
    await goto('/app');
    await expand('HR', 'Payroll');
    const r = await h.inspector.getInteractiveElements(sessionId, pageId);
    const payslips = r.navigationLinks.find((l) => l.label === 'Payslips')!;
    assert.deepEqual(payslips.menuPath, ['HR', 'Payroll']);
    assert.equal(payslips.depth, 2);
    assert.equal(payslips.region, 'sidebar');
    assert.deepEqual(r.navigationLinks.find((l) => l.label === 'Employees')?.menuPath, ['HR']);
    assert.ok(r.navigationLinks.every((l) => !l.url.includes('#')));
  });

  test('form controls, submit buttons, breadcrumbs and external links are classified', async () => {
    await goto('/app/hr/employees');
    const r = await h.inspector.getInteractiveElements(sessionId, pageId);
    const by = (label: string) => r.elements.find((e) => e.label === label)!;
    assert.equal(by('Save').risk, 'form-submit');
    assert.equal(by('Name').risk, 'input');
    assert.equal(r.navigationLinks.find((l) => l.label === 'Home')?.region, 'breadcrumb');

    await goto('/static/help');
    const help = await h.inspector.getInteractiveElements(sessionId, pageId);
    const ext = help.navigationLinks.find((l) => l.label === 'External documentation')!;
    assert.equal(ext.sameOrigin, false);
    assert.equal(ext.excluded, 'external');
  });

  test('locator hints resolve to exactly the reported element', async () => {
    await goto('/app/hr/payroll/payslips');
    await expand('HR', 'Payroll', 'Finance');
    const r = await h.inspector.getInteractiveElements(sessionId, pageId);
    const visible = r.elements.filter((e) => e.visible && e.locator.role);
    assert.ok(visible.length > 15);
    const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    const mismatches: string[] = [];
    for (const e of visible) {
      const box = await page.getByRole(e.locator.role as Parameters<Page['getByRole']>[0], { name: e.locator.name, exact: true }).nth(e.locator.nth).boundingBox();
      const [x, y, w, hgt] = e.rect!;
      if (!box || Math.abs(box.x + scroll.x - x) > 2 || Math.abs(box.y + scroll.y - y) > 2 || Math.abs(box.width - w) > 2 || Math.abs(box.height - hgt) > 2) {
        mismatches.push(`${e.role} "${e.name}" nth=${e.locator.nth}`);
      }
    }
    assert.deepEqual(mismatches, []);
  });

  test('element IDs are stable across reloads and across toggle state', async () => {
    await goto('/app/inventory/products');
    await expand('Inventory');
    const ids = (els: InteractiveElement[]) => els.map((e) => e.elementId).join(',');
    const a = await h.inspector.getInteractiveElements(sessionId, pageId);
    await h.sessions.reload(sessionId, pageId);
    await h.inspector.waitForStable(sessionId, pageId);
    const b = await h.inspector.getInteractiveElements(sessionId, pageId);
    assert.equal(ids(b.elements), ids(a.elements));
    assert.equal(new Set(a.elements.map((e) => e.elementId)).size, a.elements.length, 'IDs are unique');

    const hrCollapsed = a.expandableGroups.find((g) => g.label === 'HR')!;
    await expand('HR');
    const c = await h.inspector.getInteractiveElements(sessionId, pageId);
    const hrExpanded = c.expandableGroups.find((g) => g.label === 'HR')!;
    assert.equal(hrExpanded.expanded, true);
    assert.equal(hrExpanded.elementId, hrCollapsed.elementId, '"▸ HR" and "▾ HR" are the same control');
  });
});

describe('screenshots', () => {
  test('full-page, viewport and custom-viewport captures', async () => {
    await goto('/app/reports/inventory');
    await h.inspector.waitForStable(sessionId, pageId);
    const full = await h.inspector.captureScreenshot(sessionId, pageId, { mode: 'full_page' });
    assert.equal(full.mode, 'full_page');
    assert.equal(full.width, 1440);
    assert.ok(full.height > 2000, `full page height ${full.height}`);
    const vp = await h.inspector.captureScreenshot(sessionId, pageId, { mode: 'viewport' });
    assert.deepEqual([vp.width, vp.height], [1440, 900]);
    const small = await h.inspector.captureScreenshot(sessionId, pageId, { viewport: { width: 800, height: 600 } });
    assert.deepEqual([small.width, small.height], [800, 600]);
    assert.deepEqual(page.viewportSize(), { width: 1440, height: 900 }, 'viewport restored');
    assert.ok(vp.seq === full.seq + 1 && small.seq === vp.seq + 1, 'sequential numbering');
    const meta = JSON.parse(await readFile(path.join(h.captures.root, small.file.replace(/\.png$/, '.screenshot.json')), 'utf8'));
    assert.equal(meta.captureId, small.captureId);
  });

  test('full-page captures above the height limit fall back to the viewport and say so', async () => {
    await goto('/app/reports/inventory');
    const shot = await h.inspector.captureScreenshot(sessionId, pageId, { mode: 'full_page', maxFullPageHeight: 1000 });
    assert.equal(shot.mode, 'viewport');
    assert.equal(shot.requestedMode, 'full_page');
    assert.equal(shot.status, 'fallback');
    assert.match(shot.notes[0]!, /exceeds 1000px/);
  });
});

describe('navigation history', () => {
  test('records document and SPA navigations with initiator and source', async () => {
    const since = h.sessions.getNavigationHistory(sessionId, pageId).at(-1)?.seq ?? 0;
    await goto('/app');
    await expand('HR');
    await page.getByRole('link', { name: 'Employees', exact: true }).click(); // a user click, not NCrawl
    await page.waitForURL(/\/app\/hr\/employees$/);
    await h.sessions.goBack(sessionId, pageId);
    await h.sessions.reload(sessionId, pageId);
    const entries = h.sessions.getNavigationHistory(sessionId, pageId, since).map((e) => [new URL(e.url).pathname, e.kind, e.initiator]);
    assert.deepEqual(entries, [
      ['/app', 'document', 'ncrawl:navigate'],
      ['/app/hr/employees', 'same-document', 'page'],
      ['/app', 'same-document', 'ncrawl:back'],
      ['/app', 'document', 'ncrawl:reload'],
    ]);
    const all = h.sessions.getNavigationHistory(sessionId, pageId, since);
    assert.match(all[1]!.fromUrl!, /\/app$/);
    assert.match(all[2]!.fromUrl!, /\/app\/hr\/employees$/);
  });
});

describe('network metadata', () => {
  test('records method, type, status, content type, timing and failures with secrets redacted', async () => {
    await goto('/app');
    const obs = await h.inspector.inspectPage(sessionId, pageId, { screenshot: 'none', include: { dom: false, accessibility: false, interactive: false } });
    const reqs = obs.network!.requests;
    const data = reqs.find((r) => r.url.includes('/api/data'))!;
    assert.equal(data.method, 'GET');
    assert.equal(data.resourceType, 'fetch');
    assert.equal(data.status, 200);
    assert.equal(data.contentType, 'application/json');
    assert.equal(data.state, 'finished');
    assert.ok(data.durationMs! >= 0);
    const ping = reqs.find((r) => r.url.includes('/api/ping'))!;
    assert.equal(new URL(ping.url).searchParams.get('access_token'), '[REDACTED]');
    assert.equal(new URL(ping.url).searchParams.get('view'), 'dashboard');
    const failed = reqs.find((r) => r.url.includes('missing-logo.png'))!;
    assert.equal(failed.state, 'failed');
    assert.match(failed.failure!, /^net::ERR_/);
    assert.ok(obs.network!.summary.failed >= 1);
    assert.equal(reqs.filter((r) => r.isNavigation).length, 1, 'scoped to the current document');
  });

  test('requests abandoned by a navigation are marked cancelled and do not block stability (regression)', async () => {
    await goto('/static/help');
    // A fetch that is still running when the page navigates away never gets a completion event from Chromium.
    await page.evaluate((u) => { void fetch(u).catch(() => {}); }, `${h.erp.url}/slow?ms=4000&tag=abandoned`);
    await new Promise((r) => setTimeout(r, 200));
    await h.sessions.navigate(sessionId, pageId, { url: `${h.erp.url}/static/about` });
    const t0 = Date.now();
    const st = await h.inspector.waitForStable(sessionId, pageId);
    assert.equal(st.stable, true, JSON.stringify(st));
    assert.ok(Date.now() - t0 < 3000, `stability took ${Date.now() - t0} ms`);
    const rec = h.sessions.getNetworkMetadata(sessionId, { pageId }).records.find((r) => r.url.includes('tag=abandoned'))!;
    assert.equal(rec.state, 'cancelled');
    assert.match(rec.failure!, /superseded/);
  });

  test('a long-running request (long-polling) stops blocking stability after longRequestMs', async () => {
    await goto('/static/changelog');
    await page.evaluate((u) => { void fetch(u).catch(() => {}); }, `${h.erp.url}/slow?ms=8000&tag=longpoll`);
    const t0 = Date.now();
    const st = await h.inspector.waitForStable(sessionId, pageId, { longRequestMs: 1000 });
    const took = Date.now() - t0;
    assert.equal(st.stable, true, JSON.stringify(st));
    assert.ok(took >= 900 && took < 4000, `took ${took} ms`);
    await goto('/static/help'); // cancels the long poll
  });

  test('after an SPA route change, only that route\'s requests are attributed to the page', async () => {
    await goto('/app');
    await h.inspector.waitForStable(sessionId, pageId);
    await expand('Finance');
    await page.getByRole('link', { name: 'Payments', exact: true }).click();
    await page.getByRole('heading', { name: 'Payments' }).waitFor();
    const obs = await h.inspector.inspectPage(sessionId, pageId, { screenshot: 'none', include: { dom: false, accessibility: false, interactive: false } });
    const urls = obs.network!.requests.map((r) => new URL(r.url).pathname + new URL(r.url).search);
    assert.ok(urls.some((u) => u.includes('page=%2Fapp%2Ffinance%2Fpayments')), urls.join('\n'));
    assert.ok(!urls.some((u) => u.startsWith('/api/ping')), 'dashboard requests are not attributed to Payments');
    assert.equal(obs.navigationSource?.kind, 'same-document');
    assert.equal(obs.navigationSource?.initiator, 'page');
  });
});
