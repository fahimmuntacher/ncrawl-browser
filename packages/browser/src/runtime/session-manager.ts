import { chromium, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright';
import type { BrowserConfig } from '../config.ts';
import { NcrawlError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { Logger } from '../logger.ts';
import { HistoryRecorder, type HistoryEntry, type NavigationInitiator } from '../observers/history-recorder.ts';
import { NetworkObserver, type NetworkQuery, type NetworkRecord } from '../observers/network-observer.ts';
import type { ProfileStore } from '../profiles/profile-store.ts';
import { redactText } from '../redaction.ts';
import { CreateSessionSchema, NavigateSchema, type CreateSessionInput, type CreateSessionOptions } from '../schemas.ts';
import { OperationGate, type ControlState } from './operation-gate.ts';
import { navigate, reload, traverseHistory, type NavigateOptions, type NavigationDeps, type NavigationResult } from './navigation.ts';
import { PageRegistry, toInfo, type PageEntry, type PageInfo } from './page-registry.ts';
import { normalizeOrigins } from './url-policy.ts';

export type SessionKind = 'persistent' | 'ephemeral';
/**
 * starting → running → closing → closed
 *                    ↘ disconnected (browser exited without NCrawl asking: crash, kill, or user closed the window)
 * disconnected → (restartSession) → starting → running
 */
export type SessionStatus = 'starting' | 'running' | 'closing' | 'closed' | 'disconnected';

export interface SessionInfo {
  sessionId: string;
  kind: SessionKind;
  projectId: string | null;
  status: SessionStatus;
  headless: boolean;
  viewport: { width: number; height: number };
  allowedOrigins: string[];
  createdAt: string;
  endedAt: string | null;
  endReason: string | null;
  restarts: number;
  /** User control: active, paused (automation refused), stopping. */
  control: ControlState;
  pages: PageInfo[];
}

interface Session {
  id: string;
  kind: SessionKind;
  projectId: string | null;
  headless: boolean;
  viewport: { width: number; height: number };
  allowedOrigins: string[];
  status: SessionStatus;
  context: BrowserContext | null;
  pages: PageRegistry;
  histories: Map<string, HistoryRecorder>;
  /** Kept across restarts so network metadata from before a crash is not lost. */
  network: NetworkObserver;
  gate: OperationGate;
  releaseProfile: (() => void) | null;
  createdAt: string;
  endedAt: string | null;
  endReason: string | null;
  restarts: number;
}

/** What the inspection engine needs to observe one page. */
export interface InspectionTarget {
  sessionId: string;
  projectId: string | null;
  pageId: string;
  page: Page;
  history: HistoryRecorder;
  network: NetworkObserver;
}

export interface SessionManagerDeps {
  config: BrowserConfig;
  profiles: ProfileStore;
  logger: Logger;
  browserType?: BrowserType;
  launchTimeoutMs?: number;
}

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #shared = new Map<'headless' | 'headed', Promise<Browser>>();
  readonly #deps: Required<SessionManagerDeps>;

  constructor(deps: SessionManagerDeps) {
    this.#deps = { browserType: chromium, launchTimeoutMs: 60_000, ...deps };
  }

  // ---------------------------------------------------------------- lifecycle

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    const parsed = CreateSessionSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error);
    const opts: CreateSessionOptions = parsed.data;
    const { config } = this.#deps;

    const session: Session = {
      id: newId('ses'),
      kind: opts.kind,
      projectId: opts.projectId ?? null,
      headless: opts.headless ?? config.headless,
      viewport: opts.viewport ?? config.viewport,
      allowedOrigins: normalizeOrigins(opts.allowedOrigins),
      status: 'starting',
      context: null,
      pages: new PageRegistry((entry) => this.#log(session).warn('page crashed', { pageId: entry.id })),
      histories: new Map(),
      network: new NetworkObserver(),
      gate: new OperationGate(),
      releaseProfile: null,
      createdAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      restarts: 0,
    };

    if (session.kind === 'persistent') {
      const projectId = session.projectId!;
      if (!(await this.#deps.profiles.exists(projectId))) {
        throw new NcrawlError('PROFILE_NOT_FOUND', `No profile for project "${projectId}"; create it first`, { details: { projectId } });
      }
      session.releaseProfile = await this.#deps.profiles.acquire(projectId);
    }

    this.#sessions.set(session.id, session);
    try {
      await this.#start(session);
    } catch (e) {
      this.#sessions.delete(session.id);
      session.releaseProfile?.();
      throw e;
    }
    return this.#info(session);
  }

  async #start(session: Session): Promise<void> {
    const log = this.#log(session);
    session.status = 'starting';
    let context: BrowserContext;
    try {
      if (session.kind === 'persistent') {
        const userDataDir = this.#deps.profiles.userDataDir(session.projectId!);
        context = await this.#deps.browserType.launchPersistentContext(userDataDir, {
          headless: session.headless,
          viewport: session.viewport,
          timeout: this.#deps.launchTimeoutMs,
          ...(this.#deps.config.channel ? { channel: this.#deps.config.channel } : {}),
        });
        await this.#deps.profiles.touch(session.projectId!);
      } else {
        const browser = await this.#sharedBrowser(session.headless);
        context = await browser.newContext({ viewport: session.viewport });
      }
    } catch (e) {
      log.error('browser launch failed', { error: e });
      throw new NcrawlError('BROWSER_LAUNCH_FAILED', `Could not start Chromium: ${redactText(firstLine(e))}`, { cause: e, retryable: true });
    }

    session.context = context;
    context.setDefaultNavigationTimeout(this.#deps.config.navigationTimeoutMs);
    context.on('close', () => this.#onContextClosed(session, context));
    context.on('page', (page) => this.#adoptPage(session, page));
    session.network.attach(context, (page) => session.pages.idOf(page));
    for (const page of context.pages()) await this.#track(session, session.pages.register(page));
    session.status = 'running';
    log.info('session started', { headless: session.headless, restarts: session.restarts });
  }

  #adoptPage(session: Session, page: Page): void {
    // Pages the site opens itself (window.open, target=_blank) are tracked with their opener.
    void page.opener()
      .then((opener) => session.pages.register(page, opener ? session.pages.idOf(opener) : null))
      .catch(() => session.pages.register(page))
      .then((entry) => this.#track(session, entry))
      .catch((e) => this.#log(session).warn('could not record history for adopted page', { error: e }));
  }

  /** Start history recording for a page (idempotent). Must finish before NCrawl navigates the page. */
  async #track(session: Session, entry: PageEntry): Promise<HistoryRecorder> {
    let rec = session.histories.get(entry.id);
    if (!rec) {
      // Registered synchronously so a concurrent caller (newPage + context 'page' event) reuses it.
      rec = new HistoryRecorder();
      session.histories.set(entry.id, rec);
      void rec.bind(entry.page);
    }
    await rec.whenBound();
    return rec;
  }

  async #withInitiator<T>(session: Session, pageId: string, initiator: NavigationInitiator, op: () => Promise<T>): Promise<T> {
    const rec = session.histories.get(pageId);
    rec?.begin(initiator);
    try {
      return await op();
    } finally {
      rec?.end();
    }
  }

  #onContextClosed(session: Session, context: BrowserContext): void {
    if (session.context !== context) return; // An older context from before a restart.
    session.context = null;
    session.endedAt = new Date().toISOString();
    if (session.status === 'closing') {
      session.status = 'closed';
      session.endReason ??= 'closed by request';
    } else {
      session.status = 'disconnected';
      session.endReason = 'browser exited unexpectedly (crash, killed, or window closed by the user)';
      this.#log(session).warn('session disconnected');
    }
    session.releaseProfile?.();
    session.releaseProfile = null;
  }

  async #sharedBrowser(headless: boolean): Promise<Browser> {
    const key = headless ? 'headless' : 'headed';
    let pending = this.#shared.get(key);
    if (!pending) {
      pending = this.#deps.browserType.launch({
        headless,
        timeout: this.#deps.launchTimeoutMs,
        ...(this.#deps.config.channel ? { channel: this.#deps.config.channel } : {}),
      });
      this.#shared.set(key, pending);
      pending.then(
        (b) => b.on('disconnected', () => this.#shared.get(key) === pending && this.#shared.delete(key)),
        () => this.#shared.delete(key),
      );
    }
    return pending;
  }

  /** Relaunch a disconnected session with the same options and profile. Open pages are not restored. */
  async restartSession(sessionId: string): Promise<SessionInfo> {
    const session = this.#get(sessionId);
    if (session.status !== 'disconnected') {
      throw new NcrawlError('INVALID_INPUT', `Only disconnected sessions can be restarted (status: ${session.status})`);
    }
    if (session.kind === 'persistent') session.releaseProfile = await this.#deps.profiles.acquire(session.projectId!);
    session.pages.clear();
    session.pages = new PageRegistry((entry) => this.#log(session).warn('page crashed', { pageId: entry.id }));
    session.histories.clear();
    session.endedAt = null;
    session.endReason = null;
    session.restarts++;
    try {
      await this.#start(session);
    } catch (e) {
      session.status = 'disconnected';
      session.endReason = 'restart failed';
      session.releaseProfile?.();
      session.releaseProfile = null;
      throw e;
    }
    return this.#info(session);
  }

  async closeSession(sessionId: string): Promise<SessionInfo> {
    const session = this.#get(sessionId);
    if (session.status === 'running' || session.status === 'starting') {
      session.status = 'closing';
      const context = session.context;
      if (context) {
        // Bounded: a wedged browser must not hang shutdown forever.
        await withTimeout(context.close(), 15_000).catch((e) => {
          // Already gone (e.g. Playwright's own SIGINT handler killed Chromium first) is not a failure.
          const gone = /has been closed|Target closed/i.test(String((e as Error)?.message));
          this.#log(session)[gone ? 'debug' : 'warn']('context close failed', { error: e });
        });
      }
      // If 'close' never fired (timeout), finish the bookkeeping here.
      if (session.status === 'closing') this.#onContextClosed(session, context!);
    }
    this.#sessions.delete(sessionId);
    return this.#info(session);
  }

  /** Close every session and shared browser. Safe to call more than once. */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.#sessions.keys()].map((id) => this.closeSession(id)));
    const browsers = [...this.#shared.values()];
    this.#shared.clear();
    await Promise.allSettled(browsers.map(async (p) => (await p).close()));
  }

  getSession(sessionId: string): SessionInfo {
    return this.#info(this.#get(sessionId));
  }

  listSessions(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => this.#info(s));
  }

  // ------------------------------------------------------------- user control

  /** Refuse new automated operations until resume(). Running operations finish; the window stays usable. */
  pauseSession(sessionId: string): SessionInfo {
    const session = this.#get(sessionId);
    session.gate.pause();
    this.#log(session).info('session paused');
    return this.#info(session);
  }

  resumeSession(sessionId: string): SessionInfo {
    const session = this.#get(sessionId);
    session.gate.resume();
    this.#log(session).info('session resumed');
    return this.#info(session);
  }

  /**
   * Emergency stop: release in-flight callers immediately (SESSION_STOPPED), stop page loads, close the browser.
   * Irreversible for this session; the profile and captures are kept.
   */
  async stopSession(sessionId: string): Promise<SessionInfo> {
    const session = this.#get(sessionId);
    session.gate.stop();
    this.#log(session).warn('session stopped by user');
    session.endReason = 'stopped by user';
    if (session.context) {
      await Promise.allSettled(session.context.pages().map((p) =>
        withTimeout(p.context().newCDPSession(p).then(async (cdp) => {
          await cdp.send('Page.stopLoading');
          await cdp.detach();
        }), 2_000)));
    }
    return this.closeSession(sessionId);
  }

  async stopAll(): Promise<SessionInfo[]> {
    const results = await Promise.allSettled([...this.#sessions.keys()].map((id) => this.stopSession(id)));
    return results.filter((r): r is PromiseFulfilledResult<SessionInfo> => r.status === 'fulfilled').map((r) => r.value);
  }

  // -------------------------------------------------------------------- pages

  async openPage(sessionId: string, url?: string, opts: NavigateOptions = {}): Promise<{ page: PageInfo; navigation: NavigationResult | null }> {
    const session = this.#running(sessionId);
    return session.gate.run(null, async () => {
      const page = await session.context!.newPage();
      const entry = session.pages.register(page);
      await this.#track(session, entry);
      let navigation: NavigationResult | null = null;
      if (url !== undefined) {
        try {
          navigation = await this.#withInitiator(session, entry.id, 'ncrawl:navigate', () => navigate(page, url, this.#navDeps(session), opts));
        } catch (e) {
          await page.close().catch(() => {});
          throw e;
        }
      }
      return { page: toInfo(entry), navigation };
    });
  }

  async closePage(sessionId: string, pageId: string): Promise<void> {
    const session = this.#running(sessionId);
    const entry = session.pages.get(pageId);
    entry.status = 'closed';
    await entry.page.close().catch(() => {});
    await session.histories.get(pageId)?.detach();
  }

  listPages(sessionId: string): PageInfo[] {
    return this.#get(sessionId).pages.list();
  }

  async navigate(sessionId: string, pageId: string, input: { url: string } & NavigateOptions): Promise<NavigationResult> {
    const parsed = NavigateSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error);
    const { url, ...opts } = parsed.data;
    const { session, entry } = this.#usablePage(sessionId, pageId);
    return session.gate.run(pageId, () => crashGuarded(entry.page, () => this.#withInitiator(session, pageId, 'ncrawl:navigate', () =>
      navigate(entry.page, url, this.#navDeps(session), stripUndefined(opts) as NavigateOptions))));
  }

  async goBack(sessionId: string, pageId: string, opts: NavigateOptions = {}): Promise<NavigationResult> {
    const { session, entry } = this.#usablePage(sessionId, pageId);
    return session.gate.run(pageId, () => crashGuarded(entry.page, () =>
      this.#withInitiator(session, pageId, 'ncrawl:back', () => traverseHistory(entry.page, 'back', this.#navDeps(session), opts))));
  }

  async goForward(sessionId: string, pageId: string, opts: NavigateOptions = {}): Promise<NavigationResult> {
    const { session, entry } = this.#usablePage(sessionId, pageId);
    return session.gate.run(pageId, () => crashGuarded(entry.page, () =>
      this.#withInitiator(session, pageId, 'ncrawl:forward', () => traverseHistory(entry.page, 'forward', this.#navDeps(session), opts))));
  }

  async reload(sessionId: string, pageId: string, opts: NavigateOptions = {}): Promise<NavigationResult> {
    const { session, entry } = this.#usablePage(sessionId, pageId);
    return session.gate.run(pageId, () => crashGuarded(entry.page, () =>
      this.#withInitiator(session, pageId, 'ncrawl:reload', () => reload(entry.page, this.#navDeps(session), opts))));
  }

  /** Replace a crashed page with a new tab at its last URL, keeping the page ID. */
  async recoverPage(sessionId: string, pageId: string, opts: NavigateOptions = {}): Promise<{ page: PageInfo; navigation: NavigationResult | null }> {
    const session = this.#running(sessionId);
    const entry = session.pages.get(pageId);
    if (entry.status !== 'crashed') {
      throw new NcrawlError('INVALID_INPUT', `Page "${pageId}" has not crashed`, { details: { status: entry.status } });
    }
    return session.gate.run(pageId, async () => {
      const lastUrl = entry.page.url();
      await entry.page.close().catch(() => {});
      const fresh = await session.context!.newPage();
      session.pages.replace(entry, fresh);
      const history = await this.#track(session, entry);
      await history.bind(fresh); // keep earlier entries, follow the new tab
      let navigation: NavigationResult | null = null;
      if (/^https?:/i.test(lastUrl)) {
        navigation = await this.#withInitiator(session, pageId, 'ncrawl:recover', () => navigate(fresh, lastUrl, this.#navDeps(session), opts));
      }
      return { page: toInfo(entry), navigation };
    });
  }

  /** Raw Playwright page, for tests and in-package tooling only. Never expose through the API. */
  pageHandle(sessionId: string, pageId: string): Page {
    return this.#usablePage(sessionId, pageId).entry.page;
  }

  /**
   * Run an inspection operation on one page through the session's gate
   * (refused while paused/stopped; one operation per page at a time).
   */
  async runOnPage<T>(sessionId: string, pageId: string, op: (target: InspectionTarget) => Promise<T>): Promise<T> {
    const { session, entry } = this.#usablePage(sessionId, pageId);
    return session.gate.run(pageId, () => crashGuarded(entry.page, async () => {
      const history = await this.#track(session, entry);
      return op({ sessionId, projectId: session.projectId, pageId, page: entry.page, history, network: session.network });
    }));
  }

  getNavigationHistory(sessionId: string, pageId: string, sinceSeq = 0): HistoryEntry[] {
    const session = this.#get(sessionId);
    session.pages.get(pageId);
    return session.histories.get(pageId)?.entries(sinceSeq) ?? [];
  }

  getNetworkMetadata(sessionId: string, query: NetworkQuery = {}): { records: NetworkRecord[]; droppedRecords: number } {
    return this.#get(sessionId).network.query(query);
  }

  // ------------------------------------------------------------------ helpers

  #get(sessionId: string): Session {
    const s = this.#sessions.get(sessionId);
    if (!s) throw new NcrawlError('SESSION_NOT_FOUND', `No session "${sessionId}"`, { details: { sessionId } });
    return s;
  }

  #running(sessionId: string): Session {
    const s = this.#get(sessionId);
    if (s.status !== 'running' || !s.context) {
      throw new NcrawlError(
        s.status === 'disconnected' ? 'BROWSER_CRASHED' : 'SESSION_NOT_RUNNING',
        `Session "${sessionId}" is ${s.status}`,
        { details: { sessionId, status: s.status }, retryable: s.status === 'disconnected' },
      );
    }
    return s;
  }

  #usablePage(sessionId: string, pageId: string): { session: Session; entry: PageEntry } {
    const session = this.#running(sessionId);
    return { session, entry: session.pages.getUsable(pageId) };
  }

  #navDeps(session: Session): NavigationDeps {
    return {
      policy: { allowedOrigins: session.allowedOrigins },
      defaultTimeoutMs: this.#deps.config.navigationTimeoutMs,
      defaultRetries: this.#deps.config.navigationRetries,
      logger: this.#log(session),
    };
  }

  #log(session: Session): Logger {
    return this.#deps.logger.child({ sessionId: session.id, projectId: session.projectId });
  }

  #info(s: Session): SessionInfo {
    return {
      sessionId: s.id,
      kind: s.kind,
      projectId: s.projectId,
      status: s.status,
      headless: s.headless,
      viewport: { ...s.viewport },
      allowedOrigins: [...s.allowedOrigins],
      createdAt: s.createdAt,
      endedAt: s.endedAt,
      endReason: s.endReason,
      restarts: s.restarts,
      control: s.gate.state,
      pages: s.pages.list(),
    };
  }
}

/**
 * Run `op` but fail fast with PAGE_CRASHED if the page's renderer crashes or the page closes meanwhile.
 * Needed because a pending page.evaluate() on a crashed renderer never settles in Playwright,
 * which would otherwise hang the caller and keep the page locked forever.
 */
function crashGuarded<T>(page: Page, op: () => Promise<T>): Promise<T> {
  let onCrash!: () => void;
  let onClose!: () => void;
  const guard = new Promise<never>((_, reject) => {
    onCrash = () => reject(new NcrawlError('PAGE_CRASHED', 'The page crashed during the operation; call recoverPage', { retryable: true }));
    onClose = () => reject(new NcrawlError('PAGE_CRASHED', 'The page or browser closed during the operation', { retryable: true }));
    page.once('crash', onCrash);
    page.once('close', onClose);
  });
  guard.catch(() => {});
  return Promise.race([op(), guard]).finally(() => {
    page.off('crash', onCrash);
    page.off('close', onClose);
  });
}

function invalid(error: { issues: { path: PropertyKey[]; message: string }[] }): NcrawlError {
  return new NcrawlError('INVALID_INPUT', 'Invalid request', {
    details: { issues: error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) },
  });
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';
}

function stripUndefined(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    }),
  ]);
}
