import type { CDPSession, Page } from 'playwright';

/** Run `fn` with a short-lived CDP session for `page`, always detaching afterwards. */
export async function withCdp<T>(page: Page, fn: (cdp: CDPSession) => Promise<T>): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  try {
    return await fn(cdp);
  } finally {
    await cdp.detach().catch(() => {});
  }
}
