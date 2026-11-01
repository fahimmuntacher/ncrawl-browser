import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockErp, type MockErp } from '@ncrawl/mock-erp';
import type { Page } from 'playwright';
import { loadConfig, type BrowserConfig } from '../src/config.ts';
import { createLogger, type Logger } from '../src/logger.ts';
import { Inspector } from '../src/inspection/inspector.ts';
import { ProfileStore } from '../src/profiles/profile-store.ts';
import { SessionManager } from '../src/runtime/session-manager.ts';
import { CaptureStore } from '../src/storage/capture-store.ts';

export interface Harness {
  erp: MockErp;
  config: BrowserConfig;
  profiles: ProfileStore;
  sessions: SessionManager;
  captures: CaptureStore;
  inspector: Inspector;
  logLines: string[];
  logger: Logger;
  dispose(): Promise<void>;
}

export async function createHarness(env: Record<string, string> = {}): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ncrawl-test-'));
  const config = loadConfig({ NCRAWL_DATA_DIR: dataDir, NCRAWL_HEADLESS: 'true', NCRAWL_NAV_TIMEOUT_MS: '10000', ...env });
  const logLines: string[] = [];
  const logger = createLogger('debug', {}, (l) => logLines.push(l));
  const profiles = new ProfileStore(dataDir);
  const sessions = new SessionManager({ config, profiles, logger });
  const captures = new CaptureStore(dataDir);
  const inspector = new Inspector({ sessions, captures, logger });
  const erp = await startMockErp();
  return {
    erp, config, profiles, sessions, captures, inspector, logLines, logger,
    async dispose() {
      await sessions.shutdown();
      await erp.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Plays the human: fills the mock ERP login form in the page the user would type into. */
export async function humanLogin(page: Page): Promise<void> {
  await page.getByLabel('Username').fill('demo');
  await page.getByLabel('Password').fill('demo');
  await Promise.all([page.waitForURL(/\/app/), page.getByRole('button', { name: 'Sign in' }).click()]);
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
