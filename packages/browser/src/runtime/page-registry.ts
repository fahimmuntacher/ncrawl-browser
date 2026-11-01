import type { Page } from 'playwright';
import { NcrawlError } from '../errors.ts';
import { newId } from '../ids.ts';
import { redactUrl } from '../redaction.ts';

export type PageStatus = 'open' | 'crashed' | 'closed';

export interface PageEntry {
  readonly id: string;
  page: Page;
  status: PageStatus;
  readonly openerPageId: string | null;
  readonly createdAt: string;
  crashedAt: string | null;
}

export interface PageInfo {
  pageId: string;
  status: PageStatus;
  url: string;
  openerPageId: string | null;
  createdAt: string;
  crashedAt: string | null;
}

/** Stable NCrawl page IDs for the Playwright pages of one session. */
export class PageRegistry {
  readonly #byId = new Map<string, PageEntry>();
  readonly #byPage = new WeakMap<Page, PageEntry>();
  readonly #onCrash: (entry: PageEntry) => void;

  constructor(onCrash: (entry: PageEntry) => void = () => {}) {
    this.#onCrash = onCrash;
  }

  /** Idempotent: a page already registered keeps its ID. */
  register(page: Page, openerPageId: string | null = null): PageEntry {
    const existing = this.#byPage.get(page);
    if (existing) return existing;
    const entry: PageEntry = {
      id: newId('pg'),
      page,
      status: 'open',
      openerPageId,
      createdAt: new Date().toISOString(),
      crashedAt: null,
    };
    this.#attach(entry);
    this.#byId.set(entry.id, entry);
    this.#byPage.set(page, entry);
    return entry;
  }

  /** Swap a crashed page for a fresh one while keeping the NCrawl page ID. */
  replace(entry: PageEntry, page: Page): void {
    this.#byPage.delete(entry.page);
    entry.page = page;
    entry.status = 'open';
    entry.crashedAt = null;
    this.#attach(entry);
    this.#byPage.set(page, entry);
  }

  #attach(entry: PageEntry): void {
    const page = entry.page;
    page.on('crash', () => {
      if (entry.page !== page) return;
      entry.status = 'crashed';
      entry.crashedAt = new Date().toISOString();
      this.#onCrash(entry);
    });
    page.on('close', () => {
      if (entry.page === page && entry.status === 'open') entry.status = 'closed';
    });
  }

  idOf(page: Page): string | null {
    return this.#byPage.get(page)?.id ?? null;
  }

  get(pageId: string): PageEntry {
    const entry = this.#byId.get(pageId);
    if (!entry || entry.status === 'closed') {
      throw new NcrawlError('PAGE_NOT_FOUND', `No open page "${pageId}"`, { details: { pageId } });
    }
    return entry;
  }

  /** Like get(), but also refuses crashed pages — use for operations that drive the page. */
  getUsable(pageId: string): PageEntry {
    const entry = this.get(pageId);
    if (entry.status === 'crashed') {
      throw new NcrawlError('PAGE_CRASHED', `Page "${pageId}" crashed; call recoverPage first`, { details: { pageId }, retryable: true });
    }
    return entry;
  }

  list(): PageInfo[] {
    return [...this.#byId.values()].filter((e) => e.status !== 'closed').map(toInfo);
  }

  clear(): void {
    this.#byId.clear();
  }
}

export function toInfo(e: PageEntry): PageInfo {
  return {
    pageId: e.id,
    status: e.status,
    url: e.status === 'closed' ? '' : redactUrl(e.page.url()),
    openerPageId: e.openerPageId,
    createdAt: e.createdAt,
    crashedAt: e.crashedAt,
  };
}
