import type { Page } from 'playwright';
import type { NetworkObserver } from '../observers/network-observer.ts';

export interface StabilityOptions {
  /** Upper bound for the whole wait. */
  timeoutMs?: number;
  /** How long the DOM and the network must both be quiet. */
  quietMs?: number;
  /** Requests running longer than this (long-polling, stalled beacons) do not block stability. Default 5000. */
  longRequestMs?: number;
}

export interface StabilityResult {
  stable: boolean;
  waitedMs: number;
  /** Why the wait ended without stability, when it did. */
  reason: 'stable' | 'timeout-dom-busy' | 'timeout-network-busy' | 'page-closed';
}

/**
 * Wait until the page has loaded, its DOM has stopped changing for `quietMs`, and no requests
 * (other than websockets/event streams and requests older than `longRequestMs`) are in flight for `quietMs`. A fixed delay alone is never used.
 * Never throws: an unstable page is still inspected, with `stable: false` recorded as evidence.
 */
export async function waitForStable(page: Page, network: NetworkObserver, pageId: string, opts: StabilityOptions = {}): Promise<StabilityResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const quietMs = opts.quietMs ?? 500;
  const start = Date.now();
  const left = () => Math.max(0, timeoutMs - (Date.now() - start));
  let reason: StabilityResult['reason'] = 'timeout-dom-busy';

  try {
    await page.waitForLoadState('load', { timeout: left() || 1 }).catch(() => {});
    while (left() > 0) {
      const domQuiet = await page.evaluate(
        ({ quiet, max }) =>
          new Promise<boolean>((resolve) => {
            let timer = setTimeout(() => finish(true), quiet);
            const obs = new MutationObserver(() => {
              clearTimeout(timer);
              timer = setTimeout(() => finish(true), quiet);
            });
            const cap = setTimeout(() => finish(false), max);
            function finish(ok: boolean) {
              obs.disconnect();
              clearTimeout(timer);
              clearTimeout(cap);
              resolve(ok);
            }
            obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          }),
        { quiet: quietMs, max: Math.max(quietMs, left()) },
      );
      if (!domQuiet) {
        reason = 'timeout-dom-busy';
        break;
      }
      if (network.inflight(pageId, { ignoreOlderThanMs: opts.longRequestMs ?? 5_000 }) === 0 && network.idleFor(pageId) >= quietMs) {
        await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1_000))])).catch(() => {});
        return { stable: true, waitedMs: Date.now() - start, reason: 'stable' };
      }
      reason = 'timeout-network-busy';
      await new Promise((r) => setTimeout(r, Math.min(100, left())));
    }
  } catch {
    if (page.isClosed()) return { stable: false, waitedMs: Date.now() - start, reason: 'page-closed' };
    // A navigation during the wait destroys the evaluation context; report as not stable.
  }
  return { stable: false, waitedMs: Date.now() - start, reason };
}
