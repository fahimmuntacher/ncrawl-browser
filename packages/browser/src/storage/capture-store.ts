import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NcrawlError } from '../errors.ts';

/**
 * Capture files live under <dataDir>/captures/<projectId | _ephemeral>/<sessionId>/:
 *   0001_app-hr-employees.png
 *   0001_app-hr-employees.json   (screenshot metadata or full page observation)
 * Files are created exclusively (never overwritten) with owner-only permissions.
 */
export class CaptureStore {
  readonly root: string;
  readonly #seq = new Map<string, number>();

  constructor(dataDir: string) {
    this.root = path.join(path.resolve(dataDir), 'captures');
  }

  sessionDir(projectId: string | null, sessionId: string): string {
    if (!/^ses_[a-f0-9]{16}$/.test(sessionId)) throw new NcrawlError('INVALID_INPUT', 'Invalid session ID');
    return path.join(this.root, projectId ?? '_ephemeral', sessionId);
  }

  /** Reserve the next sequence number and a base file name for a capture of `url`. */
  async allocate(projectId: string | null, sessionId: string, url: string): Promise<{ dir: string; base: string; seq: number; captureId: string }> {
    const dir = this.sessionDir(projectId, sessionId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const key = dir;
    if (!this.#seq.has(key)) {
      // Resume numbering after a service restart.
      const existing = (await fs.readdir(dir)).map((f) => Number(f.slice(0, 4))).filter(Number.isFinite);
      this.#seq.set(key, Math.max(0, ...existing));
    }
    const seq = this.#seq.get(key)! + 1;
    this.#seq.set(key, seq);
    return { dir, base: `${String(seq).padStart(4, '0')}_${slugForUrl(url)}`, seq, captureId: `cap_${randomUUID().replaceAll('-', '').slice(0, 16)}` };
  }

  /** List capture files of one session. `scope` is a project ID or "_ephemeral". */
  async list(scope: string, sessionId: string): Promise<{ file: string; kind: CaptureFileKind; bytes: number }[]> {
    const dir = this.#scopedDir(scope, sessionId);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NcrawlError('NOT_FOUND', 'No captures for this session');
      throw e;
    }
    const out = [];
    for (const name of names.sort()) {
      const kind = captureKind(name);
      if (!kind) continue;
      out.push({ file: name, kind, bytes: (await fs.stat(path.join(dir, name))).size });
    }
    return out;
  }

  /** Read one capture file. Only names this store itself produces are accepted. */
  async read(scope: string, sessionId: string, file: string): Promise<{ data: Buffer; kind: CaptureFileKind }> {
    const kind = captureKind(file);
    if (!kind) throw new NcrawlError('NOT_FOUND', 'Unknown capture file');
    const dir = this.#scopedDir(scope, sessionId);
    const full = path.join(dir, file);
    if (path.dirname(full) !== dir) throw new NcrawlError('NOT_FOUND', 'Unknown capture file');
    try {
      return { data: await fs.readFile(full), kind };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NcrawlError('NOT_FOUND', 'Capture file not found');
      throw e;
    }
  }

  #scopedDir(scope: string, sessionId: string): string {
    if (scope !== '_ephemeral' && !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(scope)) throw new NcrawlError('NOT_FOUND', 'Unknown capture scope');
    if (!/^ses_[a-f0-9]{16}$/.test(sessionId)) throw new NcrawlError('NOT_FOUND', 'Unknown session');
    return path.join(this.root, scope, sessionId);
  }

  async writeFile(dir: string, name: string, data: Buffer | string): Promise<{ path: string; bytes: number; sha256: string }> {
    const file = path.join(dir, name);
    if (path.dirname(file) !== dir || name.includes('/') || name.includes('\\')) throw new NcrawlError('INVALID_INPUT', 'Invalid capture file name');
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    await fs.writeFile(file, buf, { flag: 'wx', mode: 0o600 });
    return { path: file, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  }
}

export type CaptureFileKind = 'screenshot' | 'screenshot-metadata' | 'observation';

export function captureKind(name: string): CaptureFileKind | null {
  const m = /^\d{4}_[a-z0-9-]{1,60}\.(png|screenshot\.json|observation\.json)$/.exec(name);
  if (!m) return null;
  return m[1] === 'png' ? 'screenshot' : m[1] === 'screenshot.json' ? 'screenshot-metadata' : 'observation';
}

/** Filesystem-safe, readable name from a URL path: "/app/hr/Payroll?x=1" -> "app-hr-payroll". */
export function slugForUrl(url: string): string {
  let p = '';
  try {
    p = new URL(url).pathname;
  } catch {
    p = url;
  }
  const slug = p.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return slug || 'root';
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) throw new Error('Not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
