import { z } from 'zod';
import type { BrowserConfig } from '../config.ts';
import * as C from '../contracts/responses.ts';
import type { Inspector } from '../inspection/inspector.ts';
import type { Logger } from '../logger.ts';
import type { ProfileStore } from '../profiles/profile-store.ts';
import type { SessionManager } from '../runtime/session-manager.ts';
import { CreateSessionSchema, NavigateSchema } from '../schemas.ts';
import type { CaptureStore } from '../storage/capture-store.ts';
import { parse, Router, sendFile, type RouteContext } from './http.ts';
import {
  AxQuery, CreateProfileBody, defined, DomQuery, EmptyBody, HistoryNavBody, HistoryQuery, InspectBody, InteractiveQuery,
  NetworkQuerySchema, OpenPageBody, queryObject, ScreenshotBody, StabilityBody,
} from './schemas.ts';

export interface ApiRuntime {
  config: BrowserConfig;
  logger: Logger;
  profiles: ProfileStore;
  sessions: SessionManager;
  captures: CaptureStore;
  inspector: Inspector;
}

export const API_VERSION = '1.0.0';

export function buildRouter(rt: ApiRuntime): Router {
  const r = new Router();
  const started = Date.now();
  const s = (c: RouteContext) => c.params.sessionId!;
  const p = (c: RouteContext) => c.params.pageId!;
  const body = (schema: z.ZodType, c: RouteContext) => defined(parse(schema, c.body) as object) as never;
  const query = (schema: z.ZodType, c: RouteContext) => defined(parse(schema, queryObject(c.query)) as object) as never;
  const empty = EmptyBody;

  // ------------------------------------------------------------- service
  let openapi: unknown;
  r.add({
    method: 'GET', path: '/v1/openapi.json', op: 'get_openapi', summary: 'This API as an OpenAPI 3.1 document (no token needed)',
    handler: async () => {
      const { buildOpenApi } = await import('../contracts/openapi.ts');
      openapi ??= buildOpenApi(r, API_VERSION);
      return openapi;
    },
  });
  r.add({ method: 'GET', path: '/v1/health', op: 'health', summary: 'Liveness check (no token needed)', response: C.HealthSchema, handler: () => ({ status: 'ok' as const }) });
  r.add({
    method: 'GET', path: '/v1/status', op: 'get_status', summary: 'Service status and session counts', response: C.StatusSchema,
    handler: async () => {
      const sessions = rt.sessions.listSessions();
      return {
        service: 'ncrawl-browser' as const,
        apiVersion: API_VERSION,
        uptimeSeconds: Math.round((Date.now() - started) / 1000),
        sessions: {
          total: sessions.length,
          running: sessions.filter((x) => x.status === 'running').length,
          paused: sessions.filter((x) => x.control === 'paused').length,
          disconnected: sessions.filter((x) => x.status === 'disconnected').length,
        },
        profiles: (await rt.profiles.list()).length,
        defaults: { headless: rt.config.headless, viewport: rt.config.viewport, navigationTimeoutMs: rt.config.navigationTimeoutMs },
      };
    },
  });
  r.add({
    method: 'POST', path: '/v1/stop', op: 'stop_all', summary: 'Emergency stop of every session', body: empty, response: C.StopAllSchema,
    handler: async () => ({ stopped: (await rt.sessions.stopAll()).map((x) => x.sessionId) }),
  });

  // ------------------------------------------------------------- profiles
  r.add({ method: 'GET', path: '/v1/profiles', op: 'list_profiles', summary: 'List project profiles', response: z.array(C.ProfileInfoSchema), handler: () => rt.profiles.list() });
  r.add({
    method: 'POST', path: '/v1/profiles', op: 'create_profile', summary: 'Create a project profile (idempotent)', status: 201,
    body: CreateProfileBody, response: C.ProfileInfoSchema,
    handler: (c) => {
      const b = parse(CreateProfileBody, c.body);
      return rt.profiles.create(b.projectId, b.displayName);
    },
  });
  r.add({ method: 'GET', path: '/v1/profiles/:projectId', op: 'get_profile', summary: 'Get one profile', response: C.ProfileInfoSchema, handler: (c) => rt.profiles.get(c.params.projectId!) });
  r.add({
    method: 'DELETE', path: '/v1/profiles/:projectId', op: 'delete_profile', summary: 'Delete a profile and its saved logins', response: C.DeletedSchema,
    handler: async (c) => {
      await rt.profiles.delete(c.params.projectId!);
      return { deleted: c.params.projectId! };
    },
  });

  // ------------------------------------------------------------- sessions (browser + context)
  r.add({ method: 'GET', path: '/v1/sessions', op: 'list_sessions', summary: 'List sessions', response: z.array(C.SessionInfoSchema), handler: () => rt.sessions.listSessions() });
  r.add({
    method: 'POST', path: '/v1/sessions', op: 'create_browser', summary: 'Launch a browser session (persistent project profile or ephemeral)', status: 201,
    body: CreateSessionSchema, response: C.SessionInfoSchema, handler: (c) => rt.sessions.createSession(c.body as never),
  });
  r.add({ method: 'GET', path: '/v1/sessions/:sessionId', op: 'get_session', summary: 'Get one session', response: C.SessionInfoSchema, handler: (c) => rt.sessions.getSession(s(c)) });
  r.add({ method: 'DELETE', path: '/v1/sessions/:sessionId', op: 'close_browser', summary: 'Close a session', response: C.SessionInfoSchema, handler: (c) => rt.sessions.closeSession(s(c)) });
  r.add({ method: 'POST', path: '/v1/sessions/:sessionId/restart', op: 'restart_browser', summary: 'Relaunch a disconnected session', body: empty, response: C.SessionInfoSchema, handler: (c) => rt.sessions.restartSession(s(c)) });
  r.add({ method: 'POST', path: '/v1/sessions/:sessionId/pause', op: 'pause', summary: 'Refuse new automated operations', body: empty, response: C.SessionInfoSchema, handler: (c) => rt.sessions.pauseSession(s(c)) });
  r.add({ method: 'POST', path: '/v1/sessions/:sessionId/resume', op: 'resume', summary: 'Accept automated operations again', body: empty, response: C.SessionInfoSchema, handler: (c) => rt.sessions.resumeSession(s(c)) });
  r.add({ method: 'POST', path: '/v1/sessions/:sessionId/stop', op: 'stop', summary: 'Emergency stop: release callers, close the browser', body: empty, response: C.SessionInfoSchema, handler: (c) => rt.sessions.stopSession(s(c)) });
  r.add({
    method: 'GET', path: '/v1/sessions/:sessionId/network', op: 'get_network_metadata', summary: 'Network metadata (no headers or bodies)',
    query: NetworkQuerySchema, response: C.NetworkQueryResultSchema,
    handler: (c) => rt.sessions.getNetworkMetadata(s(c), query(NetworkQuerySchema, c)),
  });

  // ------------------------------------------------------------- pages
  r.add({ method: 'GET', path: '/v1/sessions/:sessionId/pages', op: 'list_pages', summary: 'List pages (tabs)', response: z.array(C.PageInfoSchema), handler: (c) => rt.sessions.listPages(s(c)) });
  r.add({
    method: 'POST', path: '/v1/sessions/:sessionId/pages', op: 'open_page', summary: 'Open a new tab, optionally at a URL', status: 201,
    body: OpenPageBody, response: C.OpenPageResultSchema,
    handler: (c) => {
      const { url, ...opts } = body(OpenPageBody, c) as { url?: string };
      return rt.sessions.openPage(s(c), url, opts);
    },
  });
  r.add({
    method: 'DELETE', path: '/v1/sessions/:sessionId/pages/:pageId', op: 'close_page', summary: 'Close a tab', response: C.ClosedSchema,
    handler: async (c) => {
      await rt.sessions.closePage(s(c), p(c));
      return { closed: p(c) };
    },
  });
  const pg = '/v1/sessions/:sessionId/pages/:pageId';
  r.add({ method: 'POST', path: `${pg}/navigate`, op: 'navigate', summary: 'Navigate the tab to a URL', body: NavigateSchema, response: C.NavigationResultSchema, handler: (c) => rt.sessions.navigate(s(c), p(c), c.body as never) });
  r.add({ method: 'POST', path: `${pg}/back`, op: 'go_back', summary: 'Go back in history', body: HistoryNavBody, response: C.NavigationResultSchema, handler: (c) => rt.sessions.goBack(s(c), p(c), body(HistoryNavBody, c)) });
  r.add({ method: 'POST', path: `${pg}/forward`, op: 'go_forward', summary: 'Go forward in history', body: HistoryNavBody, response: C.NavigationResultSchema, handler: (c) => rt.sessions.goForward(s(c), p(c), body(HistoryNavBody, c)) });
  r.add({ method: 'POST', path: `${pg}/reload`, op: 'reload', summary: 'Reload the tab', body: HistoryNavBody, response: C.NavigationResultSchema, handler: (c) => rt.sessions.reload(s(c), p(c), body(HistoryNavBody, c)) });
  r.add({ method: 'POST', path: `${pg}/recover`, op: 'recover_page', summary: 'Replace a crashed tab, reopening its last URL', body: HistoryNavBody, response: C.OpenPageResultSchema, handler: (c) => rt.sessions.recoverPage(s(c), p(c), body(HistoryNavBody, c)) });
  r.add({
    method: 'GET', path: `${pg}/history`, op: 'get_navigation_history', summary: 'Main-frame navigations of the tab', query: HistoryQuery, response: z.array(C.HistoryEntrySchema),
    handler: (c) => rt.sessions.getNavigationHistory(s(c), p(c), (query(HistoryQuery, c) as { sinceSeq?: number }).sinceSeq),
  });

  // ------------------------------------------------------------- inspection
  r.add({ method: 'GET', path: `${pg}/metadata`, op: 'get_page_metadata', summary: 'URL, title, sizes, headings', response: C.PageMetadataSchema, handler: (c) => rt.inspector.getPageMetadata(s(c), p(c)) });
  r.add({ method: 'GET', path: `${pg}/dom`, op: 'get_dom_snapshot', summary: 'Bounded DOM snapshot (never form values)', query: DomQuery, response: C.DomSnapshotSchema, handler: (c) => rt.inspector.getDomSnapshot(s(c), p(c), query(DomQuery, c)) });
  r.add({ method: 'GET', path: `${pg}/accessibility`, op: 'get_accessibility_snapshot', summary: 'Accessibility tree and text outline', query: AxQuery, response: C.AccessibilitySnapshotSchema, handler: (c) => rt.inspector.getAccessibilitySnapshot(s(c), p(c), query(AxQuery, c)) });
  r.add({ method: 'GET', path: `${pg}/interactive-elements`, op: 'get_interactive_elements', summary: 'Interactive elements, navigation links, expandable groups', query: InteractiveQuery, response: C.InteractiveResultSchema, handler: (c) => rt.inspector.getInteractiveElements(s(c), p(c), query(InteractiveQuery, c)) });
  r.add({ method: 'POST', path: `${pg}/wait-for-stable`, op: 'wait_for_stable', summary: 'Wait for DOM and network quiet', body: StabilityBody, response: C.StabilityResultSchema, handler: (c) => rt.inspector.waitForStable(s(c), p(c), body(StabilityBody, c)) });
  r.add({ method: 'POST', path: `${pg}/screenshot`, op: 'capture_screenshot', summary: 'Capture a screenshot to the capture store', status: 201, body: ScreenshotBody, response: C.ScreenshotInfoSchema, handler: (c) => rt.inspector.captureScreenshot(s(c), p(c), body(ScreenshotBody, c)) });
  r.add({ method: 'POST', path: `${pg}/inspect`, op: 'inspect_page', summary: 'Full page observation (saved next to its screenshot)', status: 201, body: InspectBody, response: C.PageObservationSchema, handler: (c) => rt.inspector.inspectPage(s(c), p(c), body(InspectBody, c)) });

  // ------------------------------------------------------------- captures (files)
  r.add({ method: 'GET', path: '/v1/captures/:scope/:sessionId', op: 'list_captures', summary: 'List capture files of a session (scope = projectId or _ephemeral)', response: z.array(C.CaptureFileSchema), handler: (c) => rt.captures.list(c.params.scope!, s(c)) });
  r.add({
    method: 'GET', path: '/v1/captures/:scope/:sessionId/:file', op: 'get_capture', summary: 'Download a capture file (PNG or JSON)', raw: ['image/png', 'application/json'],
    handler: async (c) => {
      const { data, kind } = await rt.captures.read(c.params.scope!, s(c), c.params.file!);
      sendFile(c.res, data, kind === 'screenshot' ? 'image/png' : 'application/json; charset=utf-8', c.responseHeaders);
      return undefined;
    },
  });

  return r;
}
