import { setTimeout as sleep } from 'node:timers/promises';
import { errors as pwErrors, type Page, type Response } from 'playwright';
import { NcrawlError } from '../errors.ts';
import type { Logger } from '../logger.ts';
import { redactUrl } from '../redaction.ts';
import { checkNavigableUrl, isWithinPolicy, type UrlPolicy } from './url-policy.ts';

export type WaitUntil = 'commit' | 'domcontentloaded' | 'load' | 'networkidle';

export interface NavigateOptions {
  waitUntil?: WaitUntil;
  timeoutMs?: number;
  retries?: number;
}

export interface NavigationResult {
  requestedUrl: string;
  finalUrl: string;
  /** HTTP status of the main document; null for same-document (SPA) navigations or when unavailable. */
  httpStatus: number | null;
  title: string;
  attempts: number;
  durationMs: number;
  redirected: boolean;
  /** The final URL is outside the session's allowed origins (e.g. redirected to an SSO page). */
  leftAllowedOrigins: boolean;
  waitUntil: WaitUntil;
}

export interface NavigationDeps {
  policy: UrlPolicy;
  defaultTimeoutMs: number;
  defaultRetries: number;
  logger: Logger;
}

/** Chromium network errors worth retrying. Anything else (DNS failure, refused scheme, aborts) fails fast. */
const TRANSIENT = /net::ERR_(CONNECTION_(REFUSED|RESET|CLOSED|ABORTED|TIMED_OUT)|NETWORK_CHANGED|TIMED_OUT|EMPTY_RESPONSE|INTERNET_DISCONNECTED|HTTP2_PROTOCOL_ERROR)/;

export async function navigate(page: Page, rawUrl: string, deps: NavigationDeps, opts: NavigateOptions = {}): Promise<NavigationResult> {
  const url = checkNavigableUrl(rawUrl, deps.policy).toString();
  const waitUntil = opts.waitUntil ?? 'load';
  const timeout = opts.timeoutMs ?? deps.defaultTimeoutMs;
  const retries = opts.retries ?? deps.defaultRetries;
  const started = Date.now();

  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const response = await page.goto(url, { waitUntil, timeout });
      return await result(page, url, response, attempt, started, waitUntil, deps.policy);
    } catch (e) {
      const err = classify(e, url, timeout);
      const canRetry = err.retryable && attempt <= retries && !page.isClosed();
      deps.logger.warn('navigation attempt failed', { url, attempt, code: err.code, willRetry: canRetry, error: err.message });
      if (!canRetry) {
        err.details.attempts = attempt;
        throw err;
      }
      await sleep(Math.min(500 * 2 ** (attempt - 1), 4_000));
    }
  }
}

export async function reload(page: Page, deps: NavigationDeps, opts: NavigateOptions = {}): Promise<NavigationResult> {
  const waitUntil = opts.waitUntil ?? 'load';
  const timeout = opts.timeoutMs ?? deps.defaultTimeoutMs;
  const started = Date.now();
  const before = page.url();
  try {
    const response = await page.reload({ waitUntil, timeout });
    return await result(page, before, response, 1, started, waitUntil, deps.policy);
  } catch (e) {
    throw classify(e, before, timeout);
  }
}

/**
 * Back/forward using Chromium's real history (CDP) so that SPA pushState entries count,
 * and "nothing to go back to" is reported instead of silently doing nothing.
 */
export async function traverseHistory(page: Page, direction: 'back' | 'forward', deps: NavigationDeps, opts: NavigateOptions = {}): Promise<NavigationResult> {
  const waitUntil = opts.waitUntil ?? 'load';
  const timeout = opts.timeoutMs ?? deps.defaultTimeoutMs;
  const cdp = await page.context().newCDPSession(page);
  try {
    const { currentIndex, entries } = await cdp.send('Page.getNavigationHistory');
    const targetIndex = direction === 'back' ? currentIndex - 1 : currentIndex + 1;
    const target = entries[targetIndex];
    // The blank tab a page starts on is not a destination worth returning to.
    if (!target || target.url === 'about:blank') {
      throw new NcrawlError('HISTORY_UNAVAILABLE', `No history entry to go ${direction} to`, {
        details: { currentIndex, length: entries.length },
      });
    }
    // Policy applies to history traversal too: never step back into a disallowed origin.
    checkNavigableUrl(target.url, deps.policy);
    const started = Date.now();
    try {
      const response = direction === 'back'
        ? await page.goBack({ waitUntil, timeout })
        : await page.goForward({ waitUntil, timeout });
      return await result(page, target.url, response, 1, started, waitUntil, deps.policy);
    } catch (e) {
      throw classify(e, target.url, timeout);
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function result(
  page: Page,
  requestedUrl: string,
  response: Response | null,
  attempts: number,
  started: number,
  waitUntil: WaitUntil,
  policy: UrlPolicy,
): Promise<NavigationResult> {
  const finalUrl = page.url();
  return {
    requestedUrl: redactUrl(requestedUrl),
    finalUrl: redactUrl(finalUrl),
    httpStatus: response?.status() ?? null,
    title: await page.title().catch(() => ''),
    attempts,
    durationMs: Date.now() - started,
    redirected: stripHash(finalUrl) !== stripHash(requestedUrl),
    leftAllowedOrigins: !isWithinPolicy(finalUrl, policy),
    waitUntil,
  };
}

function stripHash(u: string): string {
  const i = u.indexOf('#');
  return i === -1 ? u : u.slice(0, i);
}

function classify(e: unknown, url: string, timeoutMs: number): NcrawlError {
  if (e instanceof NcrawlError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const details = { url: redactUrl(url) };
  if (e instanceof pwErrors.TimeoutError) {
    return new NcrawlError('NAVIGATION_TIMEOUT', `Navigation did not finish within ${timeoutMs} ms`, { retryable: true, details, cause: e });
  }
  if (/Target page, context or browser has been closed|Target closed|crash/i.test(message)) {
    return new NcrawlError('PAGE_CRASHED', 'The page or browser closed during navigation', { details, cause: e });
  }
  const net = message.match(/net::ERR_[A-Z_0-9]+/)?.[0];
  return new NcrawlError('NAVIGATION_FAILED', net ? `Navigation failed: ${net}` : 'Navigation failed', {
    retryable: TRANSIENT.test(message),
    details: { ...details, ...(net ? { netError: net } : {}) },
    cause: e,
  });
}
