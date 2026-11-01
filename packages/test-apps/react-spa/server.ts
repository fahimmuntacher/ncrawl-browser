import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Serves the built React SPA (dist/) with history-API fallback, plus a small JSON API. Credentials: demo / demo. */

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml' };

export interface TestAppStats { logins: number; mutations: number; requests: number }
export interface TestApp { url: string; stats: TestAppStats; close(): Promise<void> }

export async function startReactSpa(opts: { port?: number } = {}): Promise<TestApp> {
  const index = await readFile(path.join(DIST, 'index.html')).catch(() => {
    throw new Error('React SPA is not built. Run: npm run test-apps:build');
  });
  const tokens = new Set<string>();
  const stats: TestAppStats = { logins: 0, mutations: 0, requests: 0 };

  const server = http.createServer(async (req, res) => {
    stats.requests++;
    const url = new URL(req.url ?? '/', 'http://local');
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    const authed = tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''));

    if (url.pathname === '/api/login' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const { username, password } = JSON.parse(body || '{}');
      if (username !== 'demo' || password !== 'demo') return json(401, { error: 'invalid' });
      const token = randomBytes(18).toString('base64url');
      tokens.add(token);
      stats.logins++;
      return json(200, { token });
    }
    if (url.pathname === '/api/items') {
      if (!authed) return json(401, { error: 'unauthenticated' });
      await new Promise((r) => setTimeout(r, 250)); // visible loading state
      const route = url.searchParams.get('route') ?? '/';
      return json(200, { rows: Array.from({ length: 3 + (route.length % 4) }, (_, i) => ({ id: i + 1, name: `${route.split('/').pop() || 'home'} ${i + 1}`, owner: i % 2 ? 'Ana' : 'Raj' })) });
    }
    if (url.pathname === '/api/mutate' && req.method === 'POST') {
      stats.mutations++;
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/stats') return json(200, stats);

    if (url.pathname.startsWith('/assets/')) {
      const file = path.join(DIST, path.normalize(url.pathname));
      if (!file.startsWith(DIST + path.sep)) return json(404, {});
      try {
        const data = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
        return res.end(data);
      } catch {
        return json(404, {});
      }
    }
    // History-API fallback: every other path is a client-side route.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(index);
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
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

if (import.meta.main) {
  const app = await startReactSpa({ port: Number(process.env.PORT ?? 4610) });
  console.log(`Acme CRM (React SPA) at ${app.url}  (login: demo / demo)`);
}
