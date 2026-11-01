import { NcrawlError } from '../errors.ts';

/**
 * active   — operations run normally.
 * paused   — new automated operations are refused (SESSION_PAUSED); running ones finish; the user can still use the window.
 * stopping — everything is refused and in-flight callers are released at once with SESSION_STOPPED.
 */
export type ControlState = 'active' | 'paused' | 'stopping';

/**
 * Single choke point for every operation that drives or reads a page on behalf of a client.
 * Also serialises work per page: a second concurrent operation on the same page gets PAGE_BUSY
 * instead of interleaving with the first.
 */
export class OperationGate {
  #state: ControlState = 'active';
  readonly #busy = new Set<string>();
  readonly #inflight = new Set<AbortController>();

  get state(): ControlState {
    return this.#state;
  }

  get inflight(): number {
    return this.#inflight.size;
  }

  async run<T>(pageKey: string | null, op: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#assertOpen();
    if (pageKey !== null) {
      if (this.#busy.has(pageKey)) {
        throw new NcrawlError('PAGE_BUSY', 'Another operation is running on this page', { retryable: true, details: { pageId: pageKey } });
      }
      this.#busy.add(pageKey);
    }
    const ac = new AbortController();
    this.#inflight.add(ac);
    try {
      const aborted = new Promise<never>((_, reject) => {
        ac.signal.addEventListener('abort', () => reject(stopped()), { once: true });
      });
      aborted.catch(() => {}); // only observed through the race below
      return await Promise.race([op(ac.signal), aborted]);
    } catch (e) {
      if (this.#state === 'stopping') throw stopped(e);
      throw e;
    } finally {
      this.#inflight.delete(ac);
      if (pageKey !== null) this.#busy.delete(pageKey);
    }
  }

  pause(): void {
    if (this.#state === 'stopping') throw stopped();
    this.#state = 'paused';
  }

  resume(): void {
    if (this.#state === 'stopping') throw stopped();
    this.#state = 'active';
  }

  /** Irreversible: refuse new work and release every in-flight caller now. */
  stop(): void {
    this.#state = 'stopping';
    for (const ac of this.#inflight) ac.abort();
  }

  #assertOpen(): void {
    if (this.#state === 'paused') {
      throw new NcrawlError('SESSION_PAUSED', 'Session is paused; resume it to continue', { retryable: true });
    }
    if (this.#state === 'stopping') throw stopped();
  }
}

function stopped(cause?: unknown): NcrawlError {
  return new NcrawlError('SESSION_STOPPED', 'Session was stopped by the user', cause === undefined ? {} : { cause });
}
