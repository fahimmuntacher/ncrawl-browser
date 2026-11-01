import path from 'node:path';
import { z } from 'zod';

const boolFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NCRAWL_DATA_DIR: z.string().min(1).default('.ncrawl-data'),
  NCRAWL_HEADLESS: boolFromEnv.default(false),
  /** Use an installed Chrome channel ("chrome", "msedge") instead of Playwright's Chromium. */
  NCRAWL_BROWSER_CHANNEL: z.string().min(1).optional(),
  NCRAWL_NAV_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  NCRAWL_NAV_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  NCRAWL_VIEWPORT_WIDTH: z.coerce.number().int().min(320).max(7_680).default(1440),
  NCRAWL_VIEWPORT_HEIGHT: z.coerce.number().int().min(240).max(4_320).default(900),
  NCRAWL_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface BrowserConfig {
  dataDir: string;
  headless: boolean;
  channel: string | undefined;
  navigationTimeoutMs: number;
  navigationRetries: number;
  viewport: { width: number; height: number };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrowserConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid NCrawl Browser configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    dataDir: path.resolve(e.NCRAWL_DATA_DIR),
    headless: e.NCRAWL_HEADLESS,
    channel: e.NCRAWL_BROWSER_CHANNEL,
    navigationTimeoutMs: e.NCRAWL_NAV_TIMEOUT_MS,
    navigationRetries: e.NCRAWL_NAV_RETRIES,
    viewport: { width: e.NCRAWL_VIEWPORT_WIDTH, height: e.NCRAWL_VIEWPORT_HEIGHT },
    logLevel: e.NCRAWL_LOG_LEVEL,
  };
}
