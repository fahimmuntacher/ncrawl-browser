import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import { NcrawlError, type ErrorCode } from '../errors.ts';

/** Every JSON response is { ok: true, data } or { ok: false, error: { code, message, retryable, details } }. */
export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: ReturnType<NcrawlError['toJSON']> };

const STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  URL_NOT_ALLOWED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  PROFILE_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  PAGE_NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PROFILE_IN_USE: 409,
  SESSION_NOT_RUNNING: 409,
  SESSION_PAUSED: 409,
  SESSION_STOPPED: 409,
  PAGE_BUSY: 409,
  PAGE_CRASHED: 409,
  BROWSER_CRASHED: 409,
  HISTORY_UNAVAILABLE: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  NAVIGATION_FAILED: 502,
  BROWSER_LAUNCH_FAILED: 503,
  NAVIGATION_TIMEOUT: 504,
};

export function httpStatusFor(code: ErrorCode): number {
  return STATUS[code] ?? 500;
}

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, ...extra, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export function sendOk(res: ServerResponse, data: unknown, status = 200, extra: Record<string, string> = {}): void {
  sendJson(res, status, { ok: true, data } satisfies ApiResponse<unknown>, extra);
}

export function sendError(res: ServerResponse, err: NcrawlError, extra: Record<string, string> = {}): void {
  sendJson(res, httpStatusFor(err.code), { ok: false, error: err.toJSON() } satisfies ApiResponse<never>, extra);
}

export function sendFile(res: ServerResponse, data: Buffer | string, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(200, { ...BASE_HEADERS, ...extra, 'content-type': contentType, 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

/** Read a JSON body. Empty body = {}. Rejects non-JSON content types and oversized bodies. */
export async function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) throw new NcrawlError('PAYLOAD_TOO_LARGE', `Body larger than ${maxBytes} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new NcrawlError('PAYLOAD_TOO_LARGE', `Body larger than ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') {
    throw new NcrawlError('UNSUPPORTED_MEDIA_TYPE', 'Request bodies must be application/json');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new NcrawlError('INVALID_INPUT', 'Body is not valid JSON');
  }
}

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new NcrawlError('INVALID_INPUT', 'Invalid request', {
      details: { issues: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) },
    });
  }
  return r.data;
}

// ------------------------------------------------------------------- router

export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  req: IncomingMessage;
  res: ServerResponse;
  /** Headers (e.g. CORS) the server has decided for this response; include them when writing raw responses. */
  responseHeaders: Record<string, string>;
}

/** A handler returns data (sent as { ok, data }) or `undefined` if it wrote the response itself. */
export interface Route {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  status?: number;
  /** Operation name from the NCrawl API spec (create_browser, navigate, ...). */
  op: string;
  summary: string;
  /** Request body / query-string schemas (documentation + OpenAPI; handlers still parse). */
  body?: z.ZodType;
  query?: z.ZodType;
  /** Schema of `data` in the success envelope. */
  response?: z.ZodType;
  /** Content types for routes that write raw files instead of JSON envelopes. */
  raw?: string[];
  handler: (ctx: RouteContext) => Promise<unknown> | unknown;
}

export class Router {
  readonly #routes: { route: Route; parts: string[] }[] = [];

  add(route: Route): void {
    this.#routes.push({ route, parts: route.path.split('/').filter(Boolean) });
  }

  get routes(): Route[] {
    return this.#routes.map((r) => r.route);
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } {
    const segs = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const { route, parts } of this.#routes) {
      if (parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length && ok; i++) {
        const p = parts[i]!;
        let s: string;
        try {
          s = decodeURIComponent(segs[i]!);
        } catch {
          ok = false;
          break;
        }
        if (p.startsWith(':')) params[p.slice(1)] = s;
        else ok = p === s;
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    throw pathMatched
      ? new NcrawlError('METHOD_NOT_ALLOWED', `${method} is not supported on ${pathname}`)
      : new NcrawlError('NOT_FOUND', `No route ${pathname}`);
  }
}
