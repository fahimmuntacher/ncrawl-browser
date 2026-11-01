/**
 * Phase 5: NCrawl Browser against real framework apps.
 *  - Acme CRM:      React 19 SPA (Vite, React Router 8), token in localStorage, lazy routes, React-state menus.
 *  - Northwind ERP: Next.js 16 App Router, proxy (middleware) auth cookie, server components, streaming,
 *                   server actions.
 * Both must be built first: npm run test-apps:build
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, describe, test } from 'node:test';
import { startNextApp } from '@ncrawl/test-next-app';
import { startReactSpa } from '@ncrawl/test-react-spa';
import type { Page } from 'playwright';
import { deriveEdges, EdgesBulkSchema, NodesBulkSchema, toPageNode } from '../../src/contracts/sync.ts';
import type { PageObservation } from '../../src/inspection/inspector.ts';
import type { InteractiveElement } from '../../src/inspection/interactive.ts';
import { createHarness, type Harness } from '../helpers.ts';

interface NavItem { label: string; path?: string; children?: NavItem[] }
interface RouteFile { nav: NavItem[]; dynamic: string[] }
interface AppUnderTest {
  name: string;
  start: () => Promise<{ url: string; logins: () => Promise<number>; mutations: () => Promise<number>; close: () => Promise<void> }>;
  routes: RouteFile;
  protectedRoute: string;
  dashboardTitle: string;
  listPage: { path: string; dynamicLinks: string[] };
  dangerPage: { path: string; expected: Record<string, string> };
  slowRoute: { path: string; loadingText: string; heading: string };
}

const req = createRequire(import.meta.url);
const readRoutes = (pkg: string): RouteFile => JSON.parse(readFileSync(req.resolve(`${pkg}/routes.json`), 'utf8'));
const flatten = (items: NavItem[], trail: string[] = []): { label: string; path: string; trail: string[] }[] =>
  items.flatMap((i) => (i.children ? flatten(i.children, [...trail, i.label]) : [{ label: i.label, path: i.path!, trail }]));

const APPS: AppUnderTest[] = [
  {
    name: 'React SPA (Acme CRM)',
    start: async () => {
      const app = await startReactSpa();
      return { url: app.url, logins: async () => app.stats.logins, mutations: async () => app.stats.mutations, close: app.close };
    },
    routes: readRoutes('@ncrawl/test-react-spa'),
    protectedRoute: '/crm/contacts',
    dashboardTitle: 'Dashboard — Acme CRM',
    listPage: { path: '/crm/deals', dynamicLinks: ['/crm/deals/101', '/crm/deals/102', '/crm/deals/103'] },
    dangerPage: { path: '/settings/billing', expected: { 'Delete workspace': 'mutating', 'Update card': 'form-submit', 'Sign out': 'logout', 'Card number': 'input' } },
    slowRoute: { path: '/reports/pipeline', loadingText: 'Loading', heading: 'Pipeline report' },
  },
  {
    name: 'Next.js App Router (Northwind ERP)',
    start: async () => {
      const app = await startNextApp();
      return { url: app.url, logins: async () => (await app.stats()).logins, mutations: async () => (await app.stats()).mutations, close: app.close };
    },
    routes: readRoutes('@ncrawl/test-next-app'),
    protectedRoute: '/sales/customers',
    dashboardTitle: 'Dashboard — Northwind ERP',
    listPage: { path: '/inventory/items', dynamicLinks: ['/inventory/items/SKU-1', '/inventory/items/SKU-2', '/inventory/items/SKU-3'] },
    dangerPage: { path: '/admin/danger', expected: { 'Reset all data': 'form-submit', 'Log out': 'logout' } },
    slowRoute: { path: '/analytics', loadingText: 'Loading analytics', heading: 'Analytics overview' },
  },
];

for (const spec of APPS) {
  describe(spec.name, () => {
    let h: Harness;
    let app: Awaited<ReturnType<AppUnderTest['start']>>;
    let sid: string;
    let pid: string;
    let page: Page;
    const projectId = spec.name.startsWith('React') ? 'react-spa' : 'next-app';
    const navRoutes = flatten(spec.routes.nav);
    const observations: PageObservation[] = [];

    const goto = async (p: string) => {
      const r = await h.sessions.navigate(sid, pid, { url: app.url + p });
      await h.inspector.waitForStable(sid, pid);
      return r;
    };
    /** Open every collapsed sidebar group, clicking only controls the inspector rated `safe`. */
    const expandAllSafely = async (): Promise<{ clicked: string[]; refusedUnsafe: string[] }> => {
      const clicked: string[] = [];
      const refusedUnsafe: string[] = [];
      for (let i = 0; i < 30; i++) {
        const r = await h.inspector.getInteractiveElements(sid, pid);
        const next = r.expandableGroups.find((g) => !g.expanded && g.region === 'sidebar' && !refusedUnsafe.includes(g.label));
        if (!next) break;
        if (next.risk !== 'safe') {
          refusedUnsafe.push(next.label);
          continue;
        }
        const el = r.elements.find((e) => e.elementId === next.elementId)!;
        await page.getByRole(el.locator.role as Parameters<Page['getByRole']>[0], { name: new RegExp(el.locator.namePattern) }).nth(el.locator.patternNth).click();
        clicked.push(next.label);
        await h.inspector.waitForStable(sid, pid);
      }
      return { clicked, refusedUnsafe };
    };

    before(async () => {
      app = await spec.start();
      h = await createHarness();
      await h.profiles.create(projectId);
    });
    after(async () => {
      await h.dispose();
      await app.close();
    });

    test('manual login persists across browser restarts in the project profile; other profiles stay logged out', async () => {
      const loginsBefore = await app.logins();
      let s = await h.sessions.createSession({ kind: 'persistent', projectId });
      let p = s.pages[0]!.pageId;
      await h.sessions.navigate(s.sessionId, p, { url: app.url + spec.protectedRoute });
      const pw = h.sessions.pageHandle(s.sessionId, p);
      await pw.waitForURL(/\/login/);
      // The user logs in by hand.
      await pw.getByLabel('Username').fill('demo');
      await pw.getByLabel('Password').fill('demo');
      await pw.getByRole('button', { name: 'Sign in' }).click();
      await pw.waitForURL((u) => u.pathname === spec.protectedRoute);
      await h.sessions.closeSession(s.sessionId);

      s = await h.sessions.createSession({ kind: 'persistent', projectId });
      sid = s.sessionId;
      pid = s.pages[0]!.pageId;
      page = h.sessions.pageHandle(sid, pid);
      await goto(spec.protectedRoute);
      assert.equal(new URL(page.url()).pathname, spec.protectedRoute, 'still logged in after restart');

      await h.profiles.create(`${projectId}-other`);
      const o = await h.sessions.createSession({ kind: 'persistent', projectId: `${projectId}-other` });
      p = o.pages[0]!.pageId;
      await h.sessions.navigate(o.sessionId, p, { url: app.url + spec.protectedRoute });
      await h.sessions.pageHandle(o.sessionId, p).waitForURL(/\/login/);
      await h.sessions.closeSession(o.sessionId);
      assert.equal((await app.logins()) - loginsBefore, 1);
    });

    test('navigation discovery: safe menu expansion finds every sidebar route (PRD target >= 90%)', async (t) => {
      await goto('/');
      const before = await h.inspector.getInteractiveElements(sid, pid);
      const visibleBefore = new Set(before.navigationLinks.map((l) => new URL(l.url).pathname));
      const { clicked, refusedUnsafe } = await expandAllSafely();
      const r = await h.inspector.getInteractiveElements(sid, pid);
      const found = new Set(r.navigationLinks.filter((l) => l.sameOrigin && l.excluded !== 'logout').map((l) => new URL(l.url).pathname));
      const expected = navRoutes.map((x) => x.path);
      const missing = expected.filter((x) => !found.has(x));
      const coverage = (expected.length - missing.length) / expected.length;
      t.diagnostic(`routes visible before expansion: ${expected.filter((x) => visibleBefore.has(x)).length}/${expected.length}; after: ${expected.length - missing.length}/${expected.length} (${Math.round(coverage * 100)}%); groups opened: ${clicked.join(', ')}`);
      assert.deepEqual(refusedUnsafe, [], 'every menu toggle was classified safe');
      assert.deepEqual(missing, []);
      assert.ok(coverage >= 0.9);

      // Menu paths match the app's own navigation tree.
      for (const route of navRoutes) {
        const link = r.navigationLinks.find((l) => new URL(l.url).pathname === route.path && l.region === 'sidebar');
        assert.ok(link, `sidebar link for ${route.path}`);
        assert.deepEqual(link.menuPath, route.trail, `menu path of ${route.label}`);
      }
      const logout = r.elements.find((e) => /^(Sign out|Log out)$/.test(e.label))!;
      assert.equal(logout.risk, 'logout');
    });

    test('locator hints (namePattern + patternNth) resolve to the reported element on every visible control', async () => {
      await goto('/');
      await expandAllSafely();
      const r = await h.inspector.getInteractiveElements(sid, pid);
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      const mismatches: string[] = [];
      for (const e of r.elements.filter((x) => x.visible && x.locator.role)) {
        const box = await page.getByRole(e.locator.role as Parameters<Page['getByRole']>[0], { name: new RegExp(e.locator.namePattern) }).nth(e.locator.patternNth).boundingBox({ timeout: 2000 }).catch(() => null);
        const [x, y, w, hh] = e.rect!;
        if (!box || Math.abs(box.x + scroll.x - x) > 2 || Math.abs(box.y + scroll.y - y) > 2 || Math.abs(box.width - w) > 2 || Math.abs(box.height - hh) > 2) {
          mismatches.push(`${e.role} "${e.name}"`);
        }
      }
      assert.deepEqual(mismatches, []);
    });

    test('dynamic routes are discovered from page content', async () => {
      await goto(spec.listPage.path);
      const r = await h.inspector.getInteractiveElements(sid, pid);
      const inMain = r.navigationLinks.filter((l) => l.region === 'main' && l.excluded === null).map((l) => new URL(l.url).pathname);
      for (const d of spec.listPage.dynamicLinks) assert.ok(inMain.includes(d), `${d} in ${inMain.join(', ')}`);
    });

    test('dangerous controls are classified and never activated', async () => {
      await goto(spec.dangerPage.path);
      const r = await h.inspector.getInteractiveElements(sid, pid);
      const risks = Object.fromEntries(Object.keys(spec.dangerPage.expected).map((label) => [label, r.elements.find((e: InteractiveElement) => e.label === label)?.risk]));
      assert.deepEqual(risks, spec.dangerPage.expected);
    });

    test('every route is captured completely: stable, correct heading, no loading placeholders', async (t) => {
      const all = [...navRoutes.map((r) => ({ path: r.path, heading: r.label })), ...spec.routes.dynamic.map((p) => ({ path: p, heading: null }))];
      const failures: string[] = [];
      const t0 = Date.now();
      for (const route of all) {
        await h.sessions.navigate(sid, pid, { url: app.url + route.path });
        const obs = await h.inspector.inspectPage(sid, pid, { include: { dom: true } });
        observations.push(obs);
        const h1 = obs.metadata?.text.headings.find((x) => x.level === 1)?.text;
        const text = obs.dom?.nodes.map((n) => n.text ?? '').join(' ') ?? '';
        const problems = [
          obs.status !== 'complete' && `status ${obs.status} ${JSON.stringify(obs.errors)}`,
          !obs.stability?.stable && `not stable (${obs.stability?.reason})`,
          route.heading && h1 !== route.heading && `h1 "${h1}"`,
          !route.heading && !h1 && 'no h1',
          /Loading/.test(text) && 'loading placeholder captured',
          new URL(obs.metadata!.url).pathname !== route.path && `landed on ${obs.metadata?.url}`,
          obs.screenshot?.status !== 'ok' && `screenshot ${obs.screenshot?.status}`,
        ].filter(Boolean);
        if (problems.length) failures.push(`${route.path}: ${problems.join('; ')}`);
      }
      t.diagnostic(`${all.length} routes, ${Math.round((Date.now() - t0) / all.length)} ms per inspected page`);
      assert.ok(all.length >= 18, `${all.length} routes`);
      assert.deepEqual(failures, []);
      assert.equal(await app.mutations(), 0, 'no form or destructive action was executed');
    });

    test('slow route: the capture waits for the real content, not the loading state', async () => {
      await h.sessions.navigate(sid, pid, { url: app.url + spec.slowRoute.path, waitUntil: 'commit' });
      const obs = await h.inspector.inspectPage(sid, pid, { screenshot: 'none', include: { accessibility: false, interactive: false, network: false } });
      assert.equal(obs.stability?.stable, true);
      assert.equal(obs.metadata?.text.headings.find((x) => x.level === 1)?.text, spec.slowRoute.heading);
      assert.ok(!obs.dom!.nodes.some((n) => n.text?.includes(spec.slowRoute.loadingText)));
    });

    test('client-side navigation is recorded as same-document and attributed to the page', async () => {
      await goto('/');
      await expandAllSafely();
      const since = h.sessions.getNavigationHistory(sid, pid).at(-1)?.seq ?? 0;
      const target = navRoutes[2]!;
      await page.getByRole('link', { name: target.label, exact: true }).first().click();
      await page.waitForURL((u) => u.pathname === target.path);
      await h.inspector.waitForStable(sid, pid);
      const entries = h.sessions.getNavigationHistory(sid, pid, since);
      const last = entries.at(-1)!;
      assert.equal(new URL(last.url).pathname, target.path);
      assert.equal(last.kind, 'same-document', 'framework router navigated without a document load');
      assert.equal(last.initiator, 'page');
      const back = await h.sessions.goBack(sid, pid);
      assert.equal(new URL(back.finalUrl).pathname, '/');
    });

    test('crawl observations produce valid sync payloads', () => {
      const crawlSessionId = '7d3c1e2a-9f4b-4c6d-8e0a-1b2c3d4e5f60';
      const pages = observations.map((observation) => {
        const p = new URL(observation.metadata!.url).pathname;
        const navPath = [...(navRoutes.find((r) => r.path === p)?.trail ?? [])];
        return { observation, node: toPageNode(observation, { crawlSessionId, depth: navPath.length, navPath }) };
      });
      NodesBulkSchema.parse({ nodes: pages.map((p) => p.node) });
      const edges = deriveEdges(crawlSessionId, pages);
      EdgesBulkSchema.parse({ edges });
      // List page → dynamic detail pages are observed content links.
      const list = pages.find((p) => p.node.normalized_url.endsWith(spec.listPage.path))!.node;
      const fromList = edges.filter((e) => e.source_node_id === list.id && e.interaction_type === 'link').length;
      assert.ok(fromList >= spec.listPage.dynamicLinks.length, `edges from list page: ${fromList}`);
      assert.equal(new Set(pages.map((p) => p.node.id)).size, pages.length, 'one node per route');
    });
  });
}
