import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isNcrawlError } from '../errors.ts';
import type { Logger } from '../logger.ts';
import type { HistoryEntry } from '../observers/history-recorder.ts';
import type { NetworkRecord } from '../observers/network-observer.ts';
import { redactText } from '../redaction.ts';
import type { InspectionTarget, SessionManager } from '../runtime/session-manager.ts';
import type { CaptureStore } from '../storage/capture-store.ts';
import { buildAccessibilitySnapshot, fetchRawAxTree, type AccessibilitySnapshot } from './accessibility.ts';
import { collectDomSnapshot, type DomSnapshot, type DomSnapshotOptions } from './dom-snapshot.ts';
import { collectInteractive, type ExpandableGroup, type InteractiveElement, type InteractiveResult, type NavigationLink } from './interactive.ts';
import { collectPageMetadata, type PageMetadata } from './page-metadata.ts';
import { captureScreenshot, type ScreenshotInfo, type ScreenshotOptions } from './screenshot.ts';
import { waitForStable, type StabilityOptions, type StabilityResult } from './stability.ts';

export type InspectPart = 'metadata' | 'dom' | 'accessibility' | 'interactive' | 'screenshot' | 'network' | 'consistency';

export interface InspectOptions {
  /** Wait for DOM/network quiet first (default true). */
  settle?: boolean | StabilityOptions;
  /** 'none' to skip the screenshot. Default 'viewport'. */
  screenshot?: ScreenshotOptions['mode'] | 'none';
  screenshotViewport?: ScreenshotOptions['viewport'];
  include?: Partial<Record<'dom' | 'accessibility' | 'interactive' | 'network', boolean>>;
  dom?: DomSnapshotOptions;
  maxAccessibilityNodes?: number;
  maxInteractiveElements?: number;
  /** Write the observation JSON next to the screenshot (default true). */
  persist?: boolean;
}

export interface PageObservation {
  schemaVersion: 1;
  observationId: string;
  sessionId: string;
  projectId: string | null;
  pageId: string;
  startedAt: string;
  completedAt: string;
  /** complete: every requested part succeeded. partial: some failed (see errors). failed: nothing usable. */
  status: 'complete' | 'partial' | 'failed';
  errors: { part: InspectPart; code: string; message: string }[];
  stability: StabilityResult | null;
  metadata: PageMetadata | null;
  /** How the browser arrived at this page (last main-frame navigation). */
  navigationSource: Pick<HistoryEntry, 'seq' | 'fromUrl' | 'initiator' | 'kind' | 'navigationType' | 'timestamp'> | null;
  dom?: DomSnapshot;
  accessibility?: AccessibilitySnapshot;
  interactiveElements?: InteractiveElement[];
  navigationLinks?: NavigationLink[];
  expandableGroups?: ExpandableGroup[];
  interactiveTruncated?: boolean;
  screenshot?: ScreenshotInfo;
  network?: { requests: NetworkRecord[]; summary: { total: number; failed: number; byType: Record<string, number> } };
  /** Path of the saved observation JSON, relative to the capture root. */
  file?: string;
}

export interface InspectorDeps {
  sessions: SessionManager;
  captures: CaptureStore;
  logger: Logger;
}

/** Read-only page inspection. Nothing here clicks, types, scrolls the app, or submits anything. */
export class Inspector {
  readonly #d: InspectorDeps;

  constructor(deps: InspectorDeps) {
    this.#d = deps;
  }

  async getPageMetadata(sessionId: string, pageId: string): Promise<PageMetadata> {
    const t = await this.#d.sessions.inspectionTarget(sessionId, pageId);
    return collectPageMetadata(t.page);
  }

  async getDomSnapshot(sessionId: string, pageId: string, opts?: DomSnapshotOptions): Promise<DomSnapshot> {
    const t = await this.#d.sessions.inspectionTarget(sessionId, pageId);
    return collectDomSnapshot(t.page, opts);
  }

  async getAccessibilitySnapshot(sessionId: string, pageId: string, opts?: { maxNodes?: number }): Promise<AccessibilitySnapshot> {
    const t = await this.#d.sessions.inspectionTarget(sessionId, pageId);
    return buildAccessibilitySnapshot(await fetchRawAxTree(t.page), opts);
  }

  async getInteractiveElements(sessionId: string, pageId: string, opts?: { maxElements?: number }): Promise<InteractiveResult> {
    const t = await this.#d.sessions.inspectionTarget(sessionId, pageId);
    return collectInteractive(t.page, await fetchRawAxTree(t.page), opts);
  }

  async captureScreenshot(sessionId: string, pageId: string, opts?: ScreenshotOptions): Promise<ScreenshotInfo> {
    const t = await this.#d.sessions.inspectionTarget(sessionId, pageId);
    return captureScreenshot(t.page, this.#d.captures, t, opts);
  }

  async waitForStable(sessionId: string, pageId: string, opts?: StabilityOptions): Promise<StabilityResult> {
    const t = await this.#d.sessions.inspectionTarget(sessionId, pageId);
    return waitForStable(t.page, t.network, t.pageId, opts);
  }

  /** Collect everything about the current page in one consistent observation. */
  async inspectPage(sessionId: string, pageId: string, opts: InspectOptions = {}): Promise<PageObservation> {
    const t = await this.#d.sessions.inspectionTarget(sessionId, pageId);
    const log = this.#d.logger.child({ sessionId, pageId });
    const inc = { dom: true, accessibility: true, interactive: true, network: true, ...opts.include };
    const obs: PageObservation = {
      schemaVersion: 1,
      observationId: `obs_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      sessionId,
      projectId: t.projectId,
      pageId,
      startedAt: new Date().toISOString(),
      completedAt: '',
      status: 'complete',
      errors: [],
      stability: null,
      metadata: null,
      navigationSource: null,
    };
    const part = async <T>(name: InspectPart, fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        const code = isNcrawlError(e) ? e.code : 'INSPECTION_FAILED';
        const message = redactText((e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '');
        obs.errors.push({ part: name, code, message });
        log.warn('inspection part failed', { part: name, code, error: message });
        return undefined;
      }
    };

    if (opts.settle !== false) {
      obs.stability = await waitForStable(t.page, t.network, pageId, typeof opts.settle === 'object' ? opts.settle : {});
    }
    const historyAtStart = t.history.lastSeq;
    const last = t.history.last();
    if (last) {
      obs.navigationSource = { seq: last.seq, fromUrl: last.fromUrl, initiator: last.initiator, kind: last.kind, navigationType: last.navigationType, timestamp: last.timestamp };
    }

    obs.metadata = (await part('metadata', () => collectPageMetadata(t.page))) ?? null;
    if (inc.dom) {
      const dom = await part('dom', () => collectDomSnapshot(t.page, opts.dom));
      if (dom) obs.dom = dom;
    }
    if (inc.accessibility || inc.interactive) {
      const raw = await part('accessibility', () => fetchRawAxTree(t.page));
      if (raw && inc.accessibility) obs.accessibility = buildAccessibilitySnapshot(raw, { maxNodes: opts.maxAccessibilityNodes ?? 5_000 });
      if (raw && inc.interactive) {
        const res = await part('interactive', () => collectInteractive(t.page, raw, { maxElements: opts.maxInteractiveElements ?? 1_000 }));
        if (res) {
          obs.interactiveElements = res.elements;
          obs.navigationLinks = res.navigationLinks;
          obs.expandableGroups = res.expandableGroups;
          obs.interactiveTruncated = res.truncated;
        }
      }
    }
    const mode = opts.screenshot ?? 'viewport';
    if (mode !== 'none') {
      const shot = await part('screenshot', () =>
        captureScreenshot(t.page, this.#d.captures, t, { mode, ...(opts.screenshotViewport ? { viewport: opts.screenshotViewport } : {}) }));
      if (shot) obs.screenshot = shot;
    }
    if (inc.network) obs.network = networkForCurrentDocument(t);

    if (t.history.lastSeq !== historyAtStart) {
      obs.errors.push({ part: 'consistency', code: 'PAGE_NAVIGATED', message: 'The page navigated while it was being inspected; parts may describe different pages' });
    }
    obs.status = obs.metadata === null ? 'failed' : obs.errors.length ? 'partial' : 'complete';
    obs.completedAt = new Date().toISOString();

    if (opts.persist !== false) {
      await part('screenshot', async () => {
        let dir: string;
        let base: string;
        if (obs.screenshot) {
          const abs = path.join(this.#d.captures.root, obs.screenshot.file);
          dir = path.dirname(abs);
          base = path.basename(abs, '.png');
        } else {
          const slot = await this.#d.captures.allocate(t.projectId, sessionId, t.page.url());
          dir = slot.dir;
          base = slot.base;
        }
        const name = `${base}.observation.json`;
        obs.file = path.relative(this.#d.captures.root, path.join(dir, name));
        await this.#d.captures.writeFile(dir, name, JSON.stringify(obs, null, 2) + '\n');
      });
    }
    log.info('page inspected', { status: obs.status, errors: obs.errors.length, url: obs.metadata?.url });
    return obs;
  }
}

/**
 * Requests that belong to the page as currently shown:
 *  - after a full document load: from that document's navigation request onwards;
 *  - after an SPA route change (pushState): from the route change onwards.
 */
function networkForCurrentDocument(t: InspectionTarget): NonNullable<PageObservation['network']> {
  const all = t.network.query({ pageId: t.pageId }).records;
  const last = t.history.last();
  let requests = all;
  if (last?.kind === 'same-document') {
    const since = Date.parse(last.timestamp);
    requests = all.filter((r) => Date.parse(r.startedAt) >= since);
  } else {
    const nav = all.findLast((r) => r.isNavigation);
    if (nav) requests = all.filter((r) => r.seq >= nav.seq);
  }
  const byType: Record<string, number> = {};
  for (const r of requests) byType[r.resourceType] = (byType[r.resourceType] ?? 0) + 1;
  return {
    requests,
    summary: {
      total: requests.length,
      failed: requests.filter((r) => r.state === 'failed' || (r.status !== null && r.status >= 400)).length,
      byType,
    },
  };
}
