/**
 * Typed client for the NCrawl Browser API. Runtime-neutral: only `fetch` — works in the Next.js dashboard
 * (server components / route handlers or the browser), Node, and the future extension.
 * Types come straight from the contract schemas, so client and server cannot disagree silently.
 */
import type { z } from 'zod';
import type * as Req from '../api/schemas.ts';
import type * as R from '../contracts/responses.ts';
import type { CreateSessionSchema, NavigateSchema } from '../schemas.ts';

type Out<S extends z.ZodType> = z.output<S>;
type In<S extends z.ZodType> = z.input<S>;

export type ProfileInfo = Out<typeof R.ProfileInfoSchema>;
export type SessionInfo = Out<typeof R.SessionInfoSchema>;
export type PageInfo = Out<typeof R.PageInfoSchema>;
export type NavigationResult = Out<typeof R.NavigationResultSchema>;
export type OpenPageResult = Out<typeof R.OpenPageResultSchema>;
export type HistoryEntry = Out<typeof R.HistoryEntrySchema>;
export type NetworkQueryResult = Out<typeof R.NetworkQueryResultSchema>;
export type PageMetadata = Out<typeof R.PageMetadataSchema>;
export type DomSnapshot = Out<typeof R.DomSnapshotSchema>;
export type AccessibilitySnapshot = Out<typeof R.AccessibilitySnapshotSchema>;
export type InteractiveResult = Out<typeof R.InteractiveResultSchema>;
export type StabilityResult = Out<typeof R.StabilityResultSchema>;
export type ScreenshotInfo = Out<typeof R.ScreenshotInfoSchema>;
export type PageObservation = Out<typeof R.PageObservationSchema>;
export type CaptureFile = Out<typeof R.CaptureFileSchema>;
export type ServiceStatus = Out<typeof R.StatusSchema>;
export type ApiErrorBody = Out<typeof R.ErrorBodySchema>;

export type CreateSessionRequest = In<typeof CreateSessionSchema>;
export type NavigateRequest = In<typeof NavigateSchema>;
export type OpenPageRequest = In<typeof Req.OpenPageBody>;
export type HistoryNavRequest = In<typeof Req.HistoryNavBody>;
export type ScreenshotRequest = In<typeof Req.ScreenshotBody>;
export type StabilityRequest = In<typeof Req.StabilityBody>;
export type InspectRequest = In<typeof Req.InspectBody>;
export interface NetworkQuery { pageId?: string; sinceSeq?: number; failedOnly?: boolean; resourceTypes?: string[]; limit?: number }

export class NcrawlApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(status: number, body: ApiErrorBody) {
    super(`${body.code}: ${body.message}`);
    this.name = 'NcrawlApiError';
    this.status = status;
    this.code = body.code;
    this.retryable = body.retryable;
    this.details = body.details;
  }
}

export interface ClientOptions {
  /** e.g. "http://127.0.0.1:4700" */
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export class NcrawlBrowserClient {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(opts: ClientOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, '');
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // service
  health = () => this.#call<{ status: 'ok' }>('GET', '/v1/health');
  status = () => this.#call<ServiceStatus>('GET', '/v1/status');
  stopAll = () => this.#call<{ stopped: string[] }>('POST', '/v1/stop', {});

  // profiles
  listProfiles = () => this.#call<ProfileInfo[]>('GET', '/v1/profiles');
  createProfile = (projectId: string, displayName?: string) =>
    this.#call<ProfileInfo>('POST', '/v1/profiles', displayName === undefined ? { projectId } : { projectId, displayName });
  getProfile = (projectId: string) => this.#call<ProfileInfo>('GET', `/v1/profiles/${enc(projectId)}`);
  deleteProfile = (projectId: string) => this.#call<{ deleted: string }>('DELETE', `/v1/profiles/${enc(projectId)}`);

  // sessions
  listSessions = () => this.#call<SessionInfo[]>('GET', '/v1/sessions');
  createBrowser = (req: CreateSessionRequest) => this.#call<SessionInfo>('POST', '/v1/sessions', req);
  getSession = (sessionId: string) => this.#call<SessionInfo>('GET', `/v1/sessions/${enc(sessionId)}`);
  closeBrowser = (sessionId: string) => this.#call<SessionInfo>('DELETE', `/v1/sessions/${enc(sessionId)}`);
  restartBrowser = (sessionId: string) => this.#call<SessionInfo>('POST', `/v1/sessions/${enc(sessionId)}/restart`, {});
  pause = (sessionId: string) => this.#call<SessionInfo>('POST', `/v1/sessions/${enc(sessionId)}/pause`, {});
  resume = (sessionId: string) => this.#call<SessionInfo>('POST', `/v1/sessions/${enc(sessionId)}/resume`, {});
  stop = (sessionId: string) => this.#call<SessionInfo>('POST', `/v1/sessions/${enc(sessionId)}/stop`, {});
  getNetworkMetadata = (sessionId: string, q: NetworkQuery = {}) =>
    this.#call<NetworkQueryResult>('GET', `/v1/sessions/${enc(sessionId)}/network${qs({ ...q, resourceTypes: q.resourceTypes?.join(',') })}`);

  // pages
  listPages = (sessionId: string) => this.#call<PageInfo[]>('GET', `/v1/sessions/${enc(sessionId)}/pages`);
  openPage = (sessionId: string, req: OpenPageRequest = {}) => this.#call<OpenPageResult>('POST', `/v1/sessions/${enc(sessionId)}/pages`, req);
  closePage = (sessionId: string, pageId: string) => this.#call<{ closed: string }>('DELETE', this.#page(sessionId, pageId));
  navigate = (sessionId: string, pageId: string, req: NavigateRequest) => this.#call<NavigationResult>('POST', `${this.#page(sessionId, pageId)}/navigate`, req);
  goBack = (sessionId: string, pageId: string, req: HistoryNavRequest = {}) => this.#call<NavigationResult>('POST', `${this.#page(sessionId, pageId)}/back`, req);
  goForward = (sessionId: string, pageId: string, req: HistoryNavRequest = {}) => this.#call<NavigationResult>('POST', `${this.#page(sessionId, pageId)}/forward`, req);
  reload = (sessionId: string, pageId: string, req: HistoryNavRequest = {}) => this.#call<NavigationResult>('POST', `${this.#page(sessionId, pageId)}/reload`, req);
  recoverPage = (sessionId: string, pageId: string, req: HistoryNavRequest = {}) => this.#call<OpenPageResult>('POST', `${this.#page(sessionId, pageId)}/recover`, req);
  getNavigationHistory = (sessionId: string, pageId: string, sinceSeq?: number) =>
    this.#call<HistoryEntry[]>('GET', `${this.#page(sessionId, pageId)}/history${qs({ sinceSeq })}`);

  // inspection
  getPageMetadata = (sessionId: string, pageId: string) => this.#call<PageMetadata>('GET', `${this.#page(sessionId, pageId)}/metadata`);
  getDomSnapshot = (sessionId: string, pageId: string, q: { maxNodes?: number; maxTextLength?: number } = {}) =>
    this.#call<DomSnapshot>('GET', `${this.#page(sessionId, pageId)}/dom${qs(q)}`);
  getAccessibilitySnapshot = (sessionId: string, pageId: string, q: { maxNodes?: number } = {}) =>
    this.#call<AccessibilitySnapshot>('GET', `${this.#page(sessionId, pageId)}/accessibility${qs(q)}`);
  getInteractiveElements = (sessionId: string, pageId: string, q: { maxElements?: number } = {}) =>
    this.#call<InteractiveResult>('GET', `${this.#page(sessionId, pageId)}/interactive-elements${qs(q)}`);
  waitForStable = (sessionId: string, pageId: string, req: StabilityRequest = {}) => this.#call<StabilityResult>('POST', `${this.#page(sessionId, pageId)}/wait-for-stable`, req);
  captureScreenshot = (sessionId: string, pageId: string, req: ScreenshotRequest = {}) => this.#call<ScreenshotInfo>('POST', `${this.#page(sessionId, pageId)}/screenshot`, req);
  inspectPage = (sessionId: string, pageId: string, req: InspectRequest = {}) => this.#call<PageObservation>('POST', `${this.#page(sessionId, pageId)}/inspect`, req);

  // captures
  listCaptures = (scope: string, sessionId: string) => this.#call<CaptureFile[]>('GET', `/v1/captures/${enc(scope)}/${enc(sessionId)}`);
  /** `file` as returned in ScreenshotInfo.file / PageObservation.file ("scope/session/0001_x.png"). */
  getCapture = async (file: string): Promise<{ contentType: string; data: ArrayBuffer }> => {
    const res = await this.#send('GET', `/v1/captures/${file.split('/').map(enc).join('/')}`);
    if (!res.ok) throw await toError(res);
    return { contentType: res.headers.get('content-type') ?? '', data: await res.arrayBuffer() };
  };

  #page(sessionId: string, pageId: string): string {
    return `/v1/sessions/${enc(sessionId)}/pages/${enc(pageId)}`;
  }

  async #send(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await this.#fetch(this.#base + path, {
        method,
        headers: { authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new NcrawlApiError(0, { code: 'NETWORK_ERROR', message: `Cannot reach NCrawl Browser at ${this.#base}: ${(e as Error).message}`, retryable: true, details: {} });
    }
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#send(method, path, body);
    const json = (await res.json().catch(() => null)) as { ok: true; data: T } | { ok: false; error: ApiErrorBody } | null;
    if (!json) throw new NcrawlApiError(res.status, { code: 'INVALID_RESPONSE', message: 'Response was not JSON', retryable: false, details: {} });
    if (!json.ok) throw new NcrawlApiError(res.status, json.error);
    return json.data;
  }
}

async function toError(res: Response): Promise<NcrawlApiError> {
  const json = (await res.json().catch(() => null)) as { error?: ApiErrorBody } | null;
  return new NcrawlApiError(res.status, json?.error ?? { code: 'HTTP_' + res.status, message: res.statusText, retryable: false, details: {} });
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function qs(q: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
