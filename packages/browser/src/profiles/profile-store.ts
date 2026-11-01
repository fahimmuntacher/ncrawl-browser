import { promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { NcrawlError } from '../errors.ts';
import { assertProjectId } from '../ids.ts';

export interface ProfileInfo {
  projectId: string;
  displayName: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** True while a Chromium instance (this process or another) holds the profile. */
  inUse: boolean;
}

interface ProfileFile {
  version: 1;
  projectId: string;
  displayName: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * One Chromium user-data directory per NCrawl project:
 *   <dataDir>/profiles/<projectId>/profile.json   — metadata only, never secrets
 *   <dataDir>/profiles/<projectId>/user-data/     — Chromium profile (cookies, storage); never read by NCrawl
 */
export class ProfileStore {
  readonly root: string;
  readonly #held = new Set<string>();

  constructor(dataDir: string) {
    this.root = path.join(path.resolve(dataDir), 'profiles');
  }

  #dir(projectId: string): string {
    const dir = path.join(this.root, assertProjectId(projectId));
    // assertProjectId already forbids separators; this is defence in depth.
    if (path.dirname(dir) !== this.root) throw new NcrawlError('INVALID_INPUT', 'Invalid project path');
    return dir;
  }

  userDataDir(projectId: string): string {
    return path.join(this.#dir(projectId), 'user-data');
  }

  async create(projectId: string, displayName?: string): Promise<ProfileInfo> {
    const dir = this.#dir(projectId);
    await fs.mkdir(path.join(dir, 'user-data'), { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'profile.json');
    const existing = await this.#read(projectId);
    if (!existing) {
      const meta: ProfileFile = {
        version: 1,
        projectId,
        displayName: displayName?.trim() || projectId,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      await writeJsonAtomic(file, meta);
    }
    return this.get(projectId);
  }

  async get(projectId: string): Promise<ProfileInfo> {
    const meta = await this.#read(projectId);
    if (!meta) throw new NcrawlError('PROFILE_NOT_FOUND', `No profile for project "${projectId}"`, { details: { projectId } });
    return { ...stripVersion(meta), inUse: await this.isInUse(projectId) };
  }

  async exists(projectId: string): Promise<boolean> {
    return (await this.#read(projectId)) !== null;
  }

  async list(): Promise<ProfileInfo[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: ProfileInfo[] = [];
    for (const name of names.sort()) {
      try {
        out.push(await this.get(name));
      } catch {
        // Not a valid profile directory; ignore.
      }
    }
    return out;
  }

  async delete(projectId: string): Promise<void> {
    if (await this.isInUse(projectId)) {
      throw new NcrawlError('PROFILE_IN_USE', `Profile "${projectId}" is open in a browser; close it first`, { details: { projectId } });
    }
    await fs.rm(this.#dir(projectId), { recursive: true, force: true });
  }

  async touch(projectId: string): Promise<void> {
    const meta = await this.#read(projectId);
    if (!meta) return;
    meta.lastUsedAt = new Date().toISOString();
    await writeJsonAtomic(path.join(this.#dir(projectId), 'profile.json'), meta);
  }

  /** Reserve the profile for this process. Fails if held here or by another live Chromium. */
  async acquire(projectId: string): Promise<() => void> {
    const inUse = () => new NcrawlError('PROFILE_IN_USE', `Profile "${projectId}" is already open`, { details: { projectId } });
    if (this.#held.has(projectId)) throw inUse();
    // Claim synchronously, before any await, so concurrent acquires in this process cannot both win.
    this.#held.add(projectId);
    if (await this.#lockedByOtherProcess(projectId)) {
      this.#held.delete(projectId);
      throw inUse();
    }
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.#held.delete(projectId);
      }
    };
  }

  async isInUse(projectId: string): Promise<boolean> {
    return this.#held.has(projectId) || (await this.#lockedByOtherProcess(projectId));
  }

  /**
   * Chromium on Linux/macOS writes `SingletonLock` -> "<hostname>-<pid>" into the user-data dir.
   * A lock is live if it names this host and that PID is still running.
   * Windows uses a different mechanism; there only the in-process lock applies (see docs/limitations.md).
   */
  async #lockedByOtherProcess(projectId: string): Promise<boolean> {
    let target: string;
    try {
      target = await fs.readlink(path.join(this.userDataDir(projectId), 'SingletonLock'));
    } catch {
      return false;
    }
    const sep = target.lastIndexOf('-');
    const host = target.slice(0, sep);
    const pid = Number(target.slice(sep + 1));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (host !== hostname()) return true; // Shared/network home dir: assume held.
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  async #read(projectId: string): Promise<ProfileFile | null> {
    try {
      const raw = await fs.readFile(path.join(this.#dir(projectId), 'profile.json'), 'utf8');
      const meta = JSON.parse(raw) as ProfileFile;
      return meta.version === 1 && meta.projectId === projectId ? meta : null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (e instanceof NcrawlError) throw e;
      return null;
    }
  }
}

function stripVersion(meta: ProfileFile): Omit<ProfileInfo, 'inUse'> {
  const { version: _v, ...rest } = meta;
  return rest;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, file);
}
