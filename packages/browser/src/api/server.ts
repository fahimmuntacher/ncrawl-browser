import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNcrawlError, NcrawlError } from '../errors.ts';
import { readJson, sendError, sendFile, sendOk, type Router } from './http.ts';
import { buildRouter, type ApiRuntime } from './routes.ts';
import { buildPolicy, checkHostAndOrigin, checkToken, loadOrCreateToken, type SecurityPolicy } from './security.ts';

export interface ApiServer {
  url: string;
  port: number;
  token: string;
  /** Where the token is stored (null when it came from NCRAWL_API_TOKEN). */
  tokenFile: string | null;
  router: Router;
  close(): Promise<void>;
}

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const UI_FILES: Record<string, { file: string; type: string }> = {
  '/ui': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/ui/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/ui/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};
const UI_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
};

/** Start the local API. It never listens on a non-loopback address (enforced by config validation). */
export async function startApiServer(rt: ApiRuntime, opts: { port?: number } = {}): Promise<ApiServer> {
  const { host, allowedOrigins } = rt.config.api;
  const { token, file: tokenFile } = await loadOrCreateToken(rt.config.dataDir, rt.config.api.token);
  const router = buildRouter(rt);
  const ui = Object.fromEntries(
    await Promise.all(Object.entries(UI_FILES).map(async ([route, f]) => [route, { data: await readFile(path.join(UI_DIR, f.file)), type: f.type }] as const)),
  );
  const log = rt.logger.child({ component: 'api' });
  let policy: SecurityPolicy;

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url ?? '/', 'http://local');
    const responseHeaders: Record<string, string> = {};
    try {
      const origin = checkHostAndOrigin(req, policy);
      if (origin) {
        responseHeaders['access-control-allow-origin'] = origin;
        responseHeaders.vary = 'Origin';
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...responseHeaders,
          'access-control-allow-methods': 'GET, POST, DELETE',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-max-age': '600',
        });
        return res.end();
      }
      if (url.pathname === '/' || url.pathname === '/ui/') {
        res.writeHead(302, { location: '/ui' });
        return res.end();
      }
      const asset = ui[url.pathname];
      if (asset && req.method === 'GET') return sendFile(res, asset.data, asset.type, UI_HEADERS);

      const { route, params } = router.match(req.method ?? 'GET', url.pathname);
      if (route.op !== 'health' && route.op !== 'get_openapi') checkToken(req, policy);
      const body = req.method === 'POST' || req.method === 'DELETE' ? await readJson(req) : {};
      const data = await route.handler({ params, query: url.searchParams, body, req, res, responseHeaders });
      if (data !== undefined) {
        if (rt.config.api.validateResponses && route.response) {
          const check = route.response.safeParse(data);
          if (!check.success) {
            log.error('response violates its contract', { op: route.op, issues: check.error.issues.slice(0, 10) });
            throw new NcrawlError('INTERNAL', `Response of ${route.op} violates its contract`, {
              details: { op: route.op, issues: check.error.issues.slice(0, 10).map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) },
            });
          }
        }
        sendOk(res, data, route.status ?? 200, responseHeaders);
      }
    } catch (e) {
      let err: NcrawlError;
      if (isNcrawlError(e)) {
        err = e;
      } else {
        log.error('unhandled API error', { path: url.pathname, error: e });
        err = new NcrawlError('INTERNAL', 'Internal error; see service logs');
      }
      if (!res.headersSent) sendError(res, err, responseHeaders);
      else res.destroy();
    } finally {
      log.debug('request', { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - t0 });
    }
  });
  server.requestTimeout = 330_000; // longest operation timeout (300 s) plus headroom
  server.headersTimeout = 10_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? rt.config.api.port, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  policy = buildPolicy(token, port, allowedOrigins);
  const shownHost = host === '::1' ? '[::1]' : host;
  log.info('API listening', { url: `http://${shownHost}:${port}`, allowedOrigins });

  return {
    url: `http://${shownHost}:${port}`,
    port,
    token,
    tokenFile,
    router,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
