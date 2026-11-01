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
  /** Loopback only: the API drives a logged-in browser and must never be reachable from the network. */
  NCRAWL_API_HOST: z.enum(['127.0.0.1', '::1', 'localhost']).default('127.0.0.1'),
  NCRAWL_API_PORT: z.coerce.number().int().min(0).max(65_535).default(4700),
  /** Fixed API token (>= 32 chars). Unset = generated once and stored in <dataDir>/api-token (mode 0600). */
  NCRAWL_API_TOKEN: z.string().min(32).optional(),
  /** Comma-separated browser origins allowed to call the API (e.g. the NCrawl dashboard). */
  NCRAWL_API_ALLOWED_ORIGINS: z.string().default(''),
  /** Development/testing: validate every API response against its contract schema (500 on mismatch). */
  NCRAWL_API_VALIDATE_RESPONSES: boolFromEnv.default(false),
});

export interface BrowserConfig {
  dataDir: string;
  headless: boolean;
  channel: string | undefined;
  navigationTimeoutMs: number;
  navigationRetries: number;
  viewport: { width: number; height: number };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  api: {
    host: '127.0.0.1' | '::1' | 'localhost';
    port: number;
    token: string | undefined;
    allowedOrigins: string[];
    validateResponses: boolean;
  };
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
    api: {
      host: e.NCRAWL_API_HOST,
      port: e.NCRAWL_API_PORT,
      token: e.NCRAWL_API_TOKEN,
      allowedOrigins: parseOrigins(e.NCRAWL_API_ALLOWED_ORIGINS),
      validateResponses: e.NCRAWL_API_VALIDATE_RESPONSES,
    },
  };
}

function parseOrigins(raw: string): string[] {
  return raw.split(',').map((o) => o.trim()).filter(Boolean).map((o) => {
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      throw new Error(`Invalid NCrawl Browser configuration: NCRAWL_API_ALLOWED_ORIGINS: not a URL: ${o}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`Invalid NCrawl Browser configuration: NCRAWL_API_ALLOWED_ORIGINS: must be http(s): ${o}`);
    }
    return u.origin;
  });
}
