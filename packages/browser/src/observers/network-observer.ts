import type { BrowserContext, Page, Request } from 'playwright';
import { redactText, redactUrl } from '../redaction.ts';

/**
 * Safe network metadata only: no request/response headers (except content-type), no bodies, no cookies.
 * URLs are redacted before they are stored.
 */
export interface NetworkRecord {
  seq: number;
  pageId: string | null;
  url: string;
  method: string;
  resourceType: string;
  isNavigation: boolean;
  /**
   * cancelled = still pending when its page loaded a new document. Chromium abandons such requests
   * without a completion or failure event, so without this they would look in-flight forever.
   */
  state: 'pending' | 'finished' | 'failed' | 'cancelled';
  status: number | null;
  contentType: string | null;
  startedAt: string;
  durationMs: number | null;
  failure: string | null;
}

export interface NetworkQuery {
  pageId?: string;
  sinceSeq?: number;
  resourceTypes?: readonly string[];
  failedOnly?: boolean;
  limit?: number;
}

/** Long-lived connections never "finish"; they must not block stability checks. */
const STREAMING = new Set(['websocket', 'eventsource']);

interface Entry { rec: NetworkRecord; t0: number }

export class NetworkObserver {
  readonly #records: NetworkRecord[] = [];
  readonly #byRequest = new WeakMap<Request, Entry>();
  /** Pending, non-streaming requests per page. */
  readonly #pending = new Map<string, Set<Entry>>();
  readonly #lastActivity = new Map<string, number>();
  readonly #max: number;
  #seq = 0;
  #dropped = 0;

  constructor(maxRecords = 5_000) {
    this.#max = maxRecords;
  }

  attach(context: BrowserContext, pageIdOf: (page: Page) => string | null): void {
    context.on('request', (req) => this.#onRequest(req, pageIdOf));
    context.on('response', (res) => {
      const entry = this.#byRequest.get(res.request());
      if (!entry) return;
      entry.rec.status = res.status();
      entry.rec.contentType = res.headers()['content-type']?.split(';')[0]?.trim() ?? null;
    });
    context.on('requestfinished', (req) => this.#settle(req, 'finished', null));
    context.on('requestfailed', (req) => this.#settle(req, 'failed', req.failure()?.errorText ?? 'failed'));
  }

  #onRequest(req: Request, pageIdOf: (page: Page) => string | null): void {
    let pageId: string | null = null;
    let mainFrameNavigation = false;
    try {
      const frame = req.frame();
      pageId = pageIdOf(frame.page());
      mainFrameNavigation = req.isNavigationRequest() && frame.parentFrame() === null;
    } catch {
      // Service-worker requests have no frame.
    }
    // A new document in the main frame abandons the previous document's outstanding requests.
    if (pageId && mainFrameNavigation) this.#cancelPending(pageId);

    const raw = req.url();
    const rec: NetworkRecord = {
      seq: ++this.#seq,
      pageId,
      url: raw.startsWith('data:') ? 'data:[omitted]' : redactUrl(raw),
      method: req.method(),
      resourceType: req.resourceType(),
      isNavigation: req.isNavigationRequest(),
      state: 'pending',
      status: null,
      contentType: null,
      startedAt: new Date().toISOString(),
      durationMs: null,
      failure: null,
    };
    const entry: Entry = { rec, t0: performance.now() };
    this.#byRequest.set(req, entry);
    this.#records.push(rec);
    if (this.#records.length > this.#max) {
      this.#records.shift();
      this.#dropped++;
    }
    if (pageId && !STREAMING.has(rec.resourceType)) {
      let set = this.#pending.get(pageId);
      if (!set) this.#pending.set(pageId, (set = new Set()));
      set.add(entry);
      this.#lastActivity.set(pageId, Date.now());
    }
  }

  #cancelPending(pageId: string): void {
    const set = this.#pending.get(pageId);
    if (!set) return;
    for (const entry of set) {
      entry.rec.state = 'cancelled';
      entry.rec.failure = 'superseded by a new document before completing';
      entry.rec.durationMs = Math.round(performance.now() - entry.t0);
    }
    set.clear();
  }

  #settle(req: Request, state: 'finished' | 'failed', failure: string | null): void {
    const entry = this.#byRequest.get(req);
    if (!entry || entry.rec.state !== 'pending') return;
    const { rec, t0 } = entry;
    rec.state = state;
    rec.failure = failure === null ? null : redactText(failure);
    rec.durationMs = Math.round(performance.now() - t0);
    if (rec.pageId) {
      this.#pending.get(rec.pageId)?.delete(entry);
      this.#lastActivity.set(rec.pageId, Date.now());
    }
  }

  query(q: NetworkQuery = {}): { records: NetworkRecord[]; droppedRecords: number } {
    let out = this.#records.filter((r) =>
      (q.pageId === undefined || r.pageId === q.pageId) &&
      (q.sinceSeq === undefined || r.seq > q.sinceSeq) &&
      (q.resourceTypes === undefined || q.resourceTypes.includes(r.resourceType)) &&
      (!q.failedOnly || r.state === 'failed' || (r.status !== null && r.status >= 400)));
    if (q.limit !== undefined) out = out.slice(-q.limit);
    return { records: out.map((r) => ({ ...r })), droppedRecords: this.#dropped };
  }

  get lastSeq(): number {
    return this.#seq;
  }

  /**
   * Requests of this page still in flight. With `ignoreOlderThanMs`, requests running longer than that
   * (long-polling, stalled beacons) are not counted, so they cannot block stability forever.
   */
  inflight(pageId: string, opts: { ignoreOlderThanMs?: number } = {}): number {
    const set = this.#pending.get(pageId);
    if (!set) return 0;
    if (opts.ignoreOlderThanMs === undefined) return set.size;
    const cutoff = performance.now() - opts.ignoreOlderThanMs;
    let n = 0;
    for (const e of set) if (e.t0 >= cutoff) n++;
    return n;
  }

  /** Milliseconds since the last request started or ended on this page (Infinity if none). */
  idleFor(pageId: string): number {
    const t = this.#lastActivity.get(pageId);
    return t === undefined ? Infinity : Date.now() - t;
  }
}
