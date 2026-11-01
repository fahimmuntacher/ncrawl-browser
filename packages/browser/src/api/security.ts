import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { NcrawlError } from '../errors.ts';

/**
 * The API controls a browser that may be logged in to the user's applications, so "only on 127.0.0.1"
 * is not enough: any website open in any browser on this machine can send requests to localhost.
 * Defences, all required:
 *  1. Host header must be this server's loopback host:port  -> blocks DNS-rebinding.
 *  2. Origin, when present, must be this server or an allow-listed origin -> blocks cross-site calls.
 *  3. Bearer token on every /v1 request (except /v1/health)    -> blocks everything that cannot read the token.
 *  4. JSON-only request bodies                                  -> no "simple" cross-site form posts.
 */

const TOKEN_FILE = 'api-token';

export async function loadOrCreateToken(dataDir: string, fixed?: string): Promise<{ token: string; file: string | null }> {
  if (fixed) return { token: fixed, file: null };
  const file = path.join(path.resolve(dataDir), TOKEN_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const token = randomBytes(32).toString('base64url');
    await fs.writeFile(file, token + '\n', { flag: 'wx', mode: 0o600 });
    return { token, file };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  await fs.chmod(file, 0o600).catch(() => {});
  const token = (await fs.readFile(file, 'utf8')).trim();
  if (token.length < 32) throw new Error(`API token in ${file} is too short; delete the file to regenerate it`);
  return { token, file };
}

export interface SecurityPolicy {
  token: string;
  /** Accepted Host header values, e.g. "127.0.0.1:4700". */
  hosts: Set<string>;
  /** Origins allowed to call from a browser (always includes the server's own origins). */
  origins: Set<string>;
}

export function buildPolicy(token: string, port: number, allowedOrigins: readonly string[]): SecurityPolicy {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const own = [...hosts].map((h) => `http://${h}`);
  return { token, hosts, origins: new Set([...own, ...allowedOrigins]) };
}

/** Host + Origin checks. Applies to every request, including the UI and CORS preflights. */
export function checkHostAndOrigin(req: IncomingMessage, policy: SecurityPolicy): string | null {
  const host = req.headers.host ?? '';
  if (!policy.hosts.has(host.toLowerCase())) {
    throw new NcrawlError('FORBIDDEN', 'Unexpected Host header', { details: { reason: 'host' } });
  }
  const origin = req.headers.origin;
  if (origin === undefined) return null;
  if (!policy.origins.has(origin)) {
    throw new NcrawlError('FORBIDDEN', 'Origin not allowed', { details: { reason: 'origin' } });
  }
  return origin;
}

export function checkToken(req: IncomingMessage, policy: SecurityPolicy): void {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  const given = Buffer.from(m?.[1] ?? '');
  const expected = Buffer.from(policy.token);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new NcrawlError('UNAUTHORIZED', 'Missing or invalid API token');
  }
}
