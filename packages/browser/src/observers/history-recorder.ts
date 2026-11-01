import type { CDPSession, Page } from 'playwright';
import { redactUrl } from '../redaction.ts';

export type NavigationInitiator = 'ncrawl:navigate' | 'ncrawl:back' | 'ncrawl:forward' | 'ncrawl:reload' | 'ncrawl:recover' | 'page';

export interface HistoryEntry {
  seq: number;
  url: string;
  fromUrl: string | null;
  /** document = new document loaded; same-document = pushState/replaceState/fragment change. */
  kind: 'document' | 'same-document';
  /**
   * Chromium's own label. Note: going back to a pushState entry is reported as "fragment" by Chromium,
   * so use `initiator` (not this field) to know whether NCrawl caused the navigation.
   */
  navigationType: string;
  /** Who started it: an NCrawl operation, or the page itself (a user click, a script, a redirect). */
  initiator: NavigationInitiator;
  timestamp: string;
}

/**
 * Records main-frame navigations of one page from Chromium's own events (CDP Page domain),
 * which see SPA pushState navigations that a URL poll would miss.
 */
export class HistoryRecorder {
  readonly #entries: HistoryEntry[] = [];
  readonly #max: number;
  #seq = 0;
  #cdp: CDPSession | null = null;
  #mainFrameId: string | null = null;
  #lastUrl: string | null = null;
  #pending: NavigationInitiator | null = null;

  constructor(maxEntries = 1_000) {
    this.#max = maxEntries;
  }

  #bound: Promise<void> = Promise.resolve();

  /** Start (or, after a page was replaced, resume) recording on `page`. Earlier entries are kept. */
  bind(page: Page): Promise<void> {
    this.#bound = this.#bind(page);
    return this.#bound;
  }

  /** Resolves once the latest bind() has finished (so no navigation event can be missed). */
  whenBound(): Promise<void> {
    return this.#bound;
  }

  async #bind(page: Page): Promise<void> {
    await this.#cdp?.detach().catch(() => {});
    const cdp = await page.context().newCDPSession(page);
    this.#cdp = cdp;
    const { frameTree } = await cdp.send('Page.getFrameTree');
    this.#mainFrameId = frameTree.frame.id;
    cdp.on('Page.frameNavigated', (e) => {
      if (e.frame.parentId) return;
      this.#mainFrameId = e.frame.id;
      this.#add(e.frame.url, 'document', e.type === 'BackForwardCacheRestore' ? 'back_forward_cache' : 'navigation');
    });
    cdp.on('Page.navigatedWithinDocument', (e) => {
      if (e.frameId !== this.#mainFrameId) return;
      this.#add(e.url, 'same-document', (e as { navigationType?: string }).navigationType ?? 'other');
    });
    await cdp.send('Page.enable');
    const current = page.url();
    if (this.#lastUrl === null && current && current !== 'about:blank') this.#lastUrl = redactUrl(current);
  }

  /** Attribute navigations that happen until `end()` to an NCrawl operation. */
  begin(initiator: NavigationInitiator): void {
    this.#pending = initiator;
  }

  end(): void {
    this.#pending = null;
  }

  #add(rawUrl: string, kind: HistoryEntry['kind'], navigationType: string): void {
    if (rawUrl === 'about:blank' && this.#lastUrl === null) return;
    const url = redactUrl(rawUrl);
    this.#entries.push({
      seq: ++this.#seq,
      url,
      fromUrl: this.#lastUrl,
      kind,
      navigationType,
      initiator: this.#pending ?? 'page',
      timestamp: new Date().toISOString(),
    });
    if (this.#entries.length > this.#max) this.#entries.shift();
    this.#lastUrl = url;
  }

  entries(sinceSeq = 0): HistoryEntry[] {
    return this.#entries.filter((e) => e.seq > sinceSeq).map((e) => ({ ...e }));
  }

  last(): HistoryEntry | null {
    const e = this.#entries.at(-1);
    return e ? { ...e } : null;
  }

  get lastSeq(): number {
    return this.#seq;
  }

  async detach(): Promise<void> {
    await this.#cdp?.detach().catch(() => {});
    this.#cdp = null;
  }
}
