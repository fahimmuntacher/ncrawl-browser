import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Mock ERP for NCrawl tests. Credentials: demo / demo.
 * Everything is in memory; nothing here is a real security implementation.
 */

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'erp_session';

export interface MockErpStats {
  logins: number;
  logouts: number;
  /** POSTs to /api/mutate — any non-zero value means something submitted a form. */
  mutations: number;
  requests: number;
}

export interface MockErp {
  url: string;
  stats: MockErpStats;
  close(): Promise<void>;
}

export const SPA_ROUTES = [
  '/app',
  '/app/hr/employees', '/app/hr/attendance', '/app/hr/payroll/payslips', '/app/hr/payroll/structure',
  '/app/hr/payroll/tax', '/app/hr/leave',
  '/app/inventory/products', '/app/inventory/warehouses', '/app/inventory/movements', '/app/inventory/suppliers',
  '/app/finance/invoices', '/app/finance/payments', '/app/finance/ledger/general', '/app/finance/ledger/trial-balance',
  '/app/reports', '/app/reports/sales', '/app/reports/inventory',
  '/app/settings', '/app/settings/users', '/app/settings/restricted',
] as const;

export const STATIC_ROUTES = ['/static/help', '/static/about', '/static/changelog'] as const;

export async function startMockErp(opts: { port?: number; host?: string } = {}): Promise<MockErp> {
  const sessions = new Set<string>();
  const flaky = new Map<string, number>();
  const stats: MockErpStats = { logins: 0, logouts: 0, mutations: 0, requests: 0 };
  const [appJs, css] = await Promise.all([readFile(path.join(PUBLIC, 'app.js')), readFile(path.join(PUBLIC, 'style.css'))]);

  const server = http.createServer(async (req, res) => {
    stats.requests++;
    const url = new URL(req.url ?? '/', 'http://local');
    const p = url.pathname;
    const authed = sessions.has(readCookie(req, COOKIE) ?? '');

    const html = (status: number, title: string, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>` +
        `<link rel="stylesheet" href="/assets/style.css"></head><body>${body}</body></html>`);
    };
    const redirect = (to: string) => {
      res.writeHead(302, { location: to });
      res.end();
    };

    try {
      if (p === '/') return redirect('/app');
      if (p === '/assets/app.js') return send(res, 200, 'text/javascript', appJs);
      if (p === '/assets/style.css') return send(res, 200, 'text/css', css);

      if (p === '/login' && req.method === 'GET') {
        const next = safeNext(url.searchParams.get('next'));
        return html(200, 'Sign in — Mock ERP', `<form class="login" method="post" action="/login">
          <h1>Sign in</h1><input type="hidden" name="next" value="${esc(next)}">
          <label>Username <input name="username" autocomplete="username" required></label>
          <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
          <button type="submit">Sign in</button></form>`);
      }
      if (p === '/login' && req.method === 'POST') {
        const form = new URLSearchParams(await body(req));
        if (form.get('username') !== 'demo' || form.get('password') !== 'demo') {
          return html(401, 'Sign in failed — Mock ERP', '<p class="error static">Invalid credentials. <a href="/login">Try again</a></p>');
        }
        const sid = randomBytes(18).toString('base64url');
        sessions.add(sid);
        stats.logins++;
        res.writeHead(302, {
          location: safeNext(form.get('next')),
          // Persistent cookie (Max-Age) so the login survives a browser restart with the same profile.
          'set-cookie': `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
        });
        return res.end();
      }
      if (p === '/logout') {
        sessions.delete(readCookie(req, COOKIE) ?? '');
        stats.logouts++;
        res.writeHead(302, { location: '/login', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` });
        return res.end();
      }

      if (p === '/app' || p.startsWith('/app/')) {
        if (!authed) return redirect(`/login?next=${encodeURIComponent(p)}`);
        return html(200, 'Mock ERP', `<header class="topbar"><span class="brand">Mock ERP</span>
          <nav aria-label="Top"><a href="/app">Dashboard</a> · <a href="/app/reports">Reports</a> · <a href="/app/settings">Settings</a> · <a href="/static/help">Help</a></nav>
          <a href="/logout" class="logout">Log out</a></header>
          <div class="layout"><aside aria-label="Sidebar"><nav aria-label="Main navigation" id="sidebar"></nav></aside><main id="main"></main></div>
          <script src="/assets/app.js" type="module"></script>`);
      }

      if (p === '/api/data') {
        if (!authed) return json(res, 401, { error: 'unauthenticated' });
        const page = url.searchParams.get('page') ?? '';
        const rows = Array.from({ length: 3 + (page.length % 5) }, (_, i) => ({
          id: i + 1, name: `${page.split('/').pop() || 'item'} ${i + 1}`, status: i % 2 ? 'Active' : 'Pending',
        }));
        return json(res, 200, { page, rows });
      }
      if (p === '/api/mutate' && req.method === 'POST') {
        await body(req);
        stats.mutations++;
        res.writeHead(303, { location: req.headers.referer ?? '/app' });
        return res.end();
      }
      if (p === '/api/stats') return json(res, 200, stats);

      if (p === '/static/help') {
        return html(200, 'Help — Mock ERP', `<div class="static"><h1>Help</h1>
          <p>Server-rendered page. <a href="/static/about">About</a> · <a href="/static/changelog">Changelog</a> · <a href="/app">Back to app</a></p>
          <p><a href="/static/about" target="_blank" rel="opener" id="popup-link">About (new tab)</a></p>
          <p><a href="https://example.com/docs">External documentation</a></p></div>`);
      }
      if (p === '/static/about') return html(200, 'About — Mock ERP', '<div class="static"><h1>About</h1><p>Mock ERP v1.</p><a href="/static/help">Help</a></div>');
      if (p === '/static/changelog') return html(200, 'Changelog — Mock ERP', '<div class="static"><h1>Changelog</h1><ul><li>1.0 initial</li></ul><a href="/static/help">Help</a></div>');
      if (p === '/static/broken') return html(500, 'Server error — Mock ERP', '<div class="static"><h1 class="error">500 Internal Server Error</h1></div>');

      if (p === '/slow') {
        const ms = Math.min(Number(url.searchParams.get('ms')) || 1000, 60_000);
        await new Promise((r) => setTimeout(r, ms));
        return html(200, 'Slow — Mock ERP', `<p>Waited ${ms} ms</p>`);
      }
      if (p === '/flaky') {
        // Drops the connection for the first `fail` requests per key, then serves normally.
        const key = url.searchParams.get('key') ?? 'default';
        const fail = Number(url.searchParams.get('fail') ?? 1);
        const seen = (flaky.get(key) ?? 0) + 1;
        flaky.set(key, seen);
        if (seen <= fail) return req.socket.destroy();
        return html(200, 'Flaky — Mock ERP', `<p>Served on attempt ${seen}</p>`);
      }

      return html(404, 'Not found — Mock ERP', '<div class="static"><h1>404</h1></div>');
    } catch (e) {
      if (!res.headersSent) html(500, 'Error', `<pre>${esc(String(e))}</pre>`);
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function send(res: http.ServerResponse, status: number, type: string, data: Buffer | string) {
  res.writeHead(status, { 'content-type': type });
  res.end(data);
}

function json(res: http.ServerResponse, status: number, value: unknown) {
  send(res, status, 'application/json', JSON.stringify(value));
}

function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

function safeNext(next: string | null): string {
  return next && next.startsWith('/app') && !next.startsWith('//') ? next : '/app';
}

function body(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      data += c;
      if (data.length > 64_000) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
