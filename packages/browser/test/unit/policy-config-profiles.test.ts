import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { isNcrawlError } from '../../src/errors.ts';
import { ProfileStore } from '../../src/profiles/profile-store.ts';
import { checkNavigableUrl, normalizeOrigins } from '../../src/runtime/url-policy.ts';

test('URL policy: only http(s), optional origin allow-list', () => {
  const open = { allowedOrigins: [] };
  assert.equal(checkNavigableUrl('https://a.example/x', open).host, 'a.example');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'about:blank']) {
    assert.throws(() => checkNavigableUrl(bad, open), (e) => isNcrawlError(e, 'URL_NOT_ALLOWED'), bad);
  }
  assert.throws(() => checkNavigableUrl('/relative', open), (e) => isNcrawlError(e, 'INVALID_INPUT'));
  const scoped = { allowedOrigins: normalizeOrigins(['https://erp.example/some/path']) };
  assert.deepEqual(scoped.allowedOrigins, ['https://erp.example']);
  checkNavigableUrl('https://erp.example/app', scoped);
  assert.throws(() => checkNavigableUrl('https://evil.example/', scoped), (e) => isNcrawlError(e, 'URL_NOT_ALLOWED'));
  assert.throws(() => checkNavigableUrl('http://erp.example/app', scoped), (e) => isNcrawlError(e, 'URL_NOT_ALLOWED'));
});

test('config: defaults, parsing and validation', () => {
  const c = loadConfig({});
  assert.equal(c.headless, false);
  assert.equal(c.navigationTimeoutMs, 30_000);
  assert.deepEqual(c.viewport, { width: 1440, height: 900 });
  assert.equal(loadConfig({ NCRAWL_HEADLESS: '1' }).headless, true);
  assert.throws(() => loadConfig({ NCRAWL_NAV_TIMEOUT_MS: '5' }), /NCRAWL_NAV_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ NCRAWL_HEADLESS: 'yes' }), /NCRAWL_HEADLESS/);
});

test('profiles: create, list, isolation of paths, delete, invalid IDs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ncrawl-prof-'));
  try {
    const store = new ProfileStore(dir);
    const a = await store.create('acme-erp', 'Acme ERP');
    await store.create('beta');
    assert.equal(a.displayName, 'Acme ERP');
    assert.equal(a.inUse, false);
    assert.deepEqual((await store.list()).map((p) => p.projectId), ['acme-erp', 'beta']);
    assert.notEqual(store.userDataDir('acme-erp'), store.userDataDir('beta'));
    // Re-creating keeps the original metadata.
    assert.equal((await store.create('acme-erp', 'Renamed')).displayName, 'Acme ERP');
    for (const bad of ['../x', 'A', 'a/b', '', '-a', 'a'.repeat(65)]) {
      await assert.rejects(store.create(bad), (e) => isNcrawlError(e, 'INVALID_INPUT'), bad);
    }
    await store.delete('beta');
    assert.equal(await store.exists('beta'), false);
    await assert.rejects(store.get('beta'), (e) => isNcrawlError(e, 'PROFILE_NOT_FOUND'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('profiles: in-process lock and Chromium SingletonLock detection', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ncrawl-lock-'));
  try {
    const store = new ProfileStore(dir);
    await store.create('p1');
    // Concurrent acquires: exactly one wins.
    const results = await Promise.allSettled([store.acquire('p1'), store.acquire('p1')]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const release = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<() => void>).value;
    await assert.rejects(store.delete('p1'), (e) => isNcrawlError(e, 'PROFILE_IN_USE'));
    release();
    assert.equal(await store.isInUse('p1'), false);

    // A live Chromium elsewhere: SingletonLock -> "<host>-<live pid>".
    const lock = path.join(store.userDataDir('p1'), 'SingletonLock');
    await symlink(`${hostname()}-${process.pid}`, lock);
    assert.equal(await store.isInUse('p1'), true);
    await assert.rejects(store.acquire('p1'), (e) => isNcrawlError(e, 'PROFILE_IN_USE'));
    // A stale lock (dead PID) does not block.
    await rm(lock);
    await symlink(`${hostname()}-2147483646`, lock);
    assert.equal(await store.isInUse('p1'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
