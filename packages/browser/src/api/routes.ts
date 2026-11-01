import type { BrowserConfig } from '../config.ts';
import type { Inspector } from '../inspection/inspector.ts';
import type { Logger } from '../logger.ts';
import type { ProfileStore } from '../profiles/profile-store.ts';
import type { SessionManager } from '../runtime/session-manager.ts';
import type { CaptureStore } from '../storage/capture-store.ts';
import { sendFile, parse, Router, type RouteContext } from './http.ts';
import {
  AxQuery, CreateProfileBody, defined, DomQuery, HistoryNavBody, HistoryQuery, InspectBody, InteractiveQuery,
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
  const body = <T extends Parameters<typeof parse>[0]>(schema: T, c: RouteContext) => defined(parse(schema, c.body) as object) as never;
  const query = <T extends Parameters<typeof parse>[0]>(schema: T, c: RouteContext) => defined(parse(schema, queryObject(c.query)) as object) as never;

  // ------------------------------------------------------------- service
  r.add({ method: 'GET', path: '/v1/health', op: 'health', handler: () => ({ status: 'ok' }) });
  r.add({
    method: 'GET', path: '/v1/status', op: 'get_status',
    handler: async () => {
      const sessions = rt.sessions.listSessions();
      return {
        service: 'ncrawl-browser',
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
  r.add({ method: 'POST', path: '/v1/stop', op: 'stop_all', handler: async () => ({ stopped: (await rt.sessions.stopAll()).map((x) => x.sessionId) }) });

  // ------------------------------------------------------------- profiles
  r.add({ method: 'GET', path: '/v1/profiles', op: 'list_profiles', handler: () => rt.profiles.list() });
  r.add({
    method: 'POST', path: '/v1/profiles', op: 'create_profile', status: 201,
    handler: (c) => {
      const b = parse(CreateProfileBody, c.body);
      return rt.profiles.create(b.projectId, b.displayName);
    },
  });
  r.add({ method: 'GET', path: '/v1/profiles/:projectId', op: 'get_profile', handler: (c) => rt.profiles.get(c.params.projectId!) });
  r.add({
    method: 'DELETE', path: '/v1/profiles/:projectId', op: 'delete_profile',
    handler: async (c) => {
      await rt.profiles.delete(c.params.projectId!);
      return { deleted: c.params.projectId };
    },
  });

  // ------------------------------------------------------------- sessions (browser + context)
  r.add({ method: 'GET', path: '/v1/sessions', op: 'list_sessions', handler: () => rt.sessions.listSessions() });
  r.add({ method: 'POST', path: '/v1/sessions', op: 'create_browser', status: 201, handler: (c) => rt.sessions.createSession(c.body as never) });
  r.add({ method: 'GET', path: '/v1/sessions/:sessionId', op: 'get_session', handler: (c) => rt.sessions.getSession(s(c)) });
  r.add({ method: 'DELETE', path: '/v1/sessions/:sessionId', op: 'close_browser', handler: (c) => rt.sessions.closeSession(s(c)) });
  r.add({ method: 'POST', path: '/v1/sessions/:sessionId/restart', op: 'restart_browser', handler: (c) => rt.sessions.restartSession(s(c)) });
  r.add({ method: 'POST', path: '/v1/sessions/:sessionId/pause', op: 'pause', handler: (c) => rt.sessions.pauseSession(s(c)) });
  r.add({ method: 'POST', path: '/v1/sessions/:sessionId/resume', op: 'resume', handler: (c) => rt.sessions.resumeSession(s(c)) });
  r.add({ method: 'POST', path: '/v1/sessions/:sessionId/stop', op: 'stop', handler: (c) => rt.sessions.stopSession(s(c)) });
  r.add({
    method: 'GET', path: '/v1/sessions/:sessionId/network', op: 'get_network_metadata',
    handler: (c) => rt.sessions.getNetworkMetadata(s(c), query(NetworkQuerySchema, c)),
  });

  // ------------------------------------------------------------- pages
  r.add({ method: 'GET', path: '/v1/sessions/:sessionId/pages', op: 'list_pages', handler: (c) => rt.sessions.listPages(s(c)) });
  r.add({
    method: 'POST', path: '/v1/sessions/:sessionId/pages', op: 'open_page', status: 201,
    handler: (c) => {
      const { url, ...opts } = body(OpenPageBody, c) as { url?: string };
      return rt.sessions.openPage(s(c), url, opts);
    },
  });
  r.add({
    method: 'DELETE', path: '/v1/sessions/:sessionId/pages/:pageId', op: 'close_page',
    handler: async (c) => {
      await rt.sessions.closePage(s(c), p(c));
      return { closed: p(c) };
    },
  });
  const pg = '/v1/sessions/:sessionId/pages/:pageId';
  r.add({ method: 'POST', path: `${pg}/navigate`, op: 'navigate', handler: (c) => rt.sessions.navigate(s(c), p(c), c.body as never) });
  r.add({ method: 'POST', path: `${pg}/back`, op: 'go_back', handler: (c) => rt.sessions.goBack(s(c), p(c), body(HistoryNavBody, c)) });
  r.add({ method: 'POST', path: `${pg}/forward`, op: 'go_forward', handler: (c) => rt.sessions.goForward(s(c), p(c), body(HistoryNavBody, c)) });
  r.add({ method: 'POST', path: `${pg}/reload`, op: 'reload', handler: (c) => rt.sessions.reload(s(c), p(c), body(HistoryNavBody, c)) });
  r.add({ method: 'POST', path: `${pg}/recover`, op: 'recover_page', handler: (c) => rt.sessions.recoverPage(s(c), p(c), body(HistoryNavBody, c)) });
  r.add({ method: 'GET', path: `${pg}/history`, op: 'get_navigation_history', handler: (c) => rt.sessions.getNavigationHistory(s(c), p(c), (query(HistoryQuery, c) as { sinceSeq?: number }).sinceSeq) });

  // ------------------------------------------------------------- inspection
  r.add({ method: 'GET', path: `${pg}/metadata`, op: 'get_page_metadata', handler: (c) => rt.inspector.getPageMetadata(s(c), p(c)) });
  r.add({ method: 'GET', path: `${pg}/dom`, op: 'get_dom_snapshot', handler: (c) => rt.inspector.getDomSnapshot(s(c), p(c), query(DomQuery, c)) });
  r.add({ method: 'GET', path: `${pg}/accessibility`, op: 'get_accessibility_snapshot', handler: (c) => rt.inspector.getAccessibilitySnapshot(s(c), p(c), query(AxQuery, c)) });
  r.add({ method: 'GET', path: `${pg}/interactive-elements`, op: 'get_interactive_elements', handler: (c) => rt.inspector.getInteractiveElements(s(c), p(c), query(InteractiveQuery, c)) });
  r.add({ method: 'POST', path: `${pg}/wait-for-stable`, op: 'wait_for_stable', handler: (c) => rt.inspector.waitForStable(s(c), p(c), body(StabilityBody, c)) });
  r.add({ method: 'POST', path: `${pg}/screenshot`, op: 'capture_screenshot', status: 201, handler: (c) => rt.inspector.captureScreenshot(s(c), p(c), body(ScreenshotBody, c)) });
  r.add({ method: 'POST', path: `${pg}/inspect`, op: 'inspect_page', status: 201, handler: (c) => rt.inspector.inspectPage(s(c), p(c), body(InspectBody, c)) });

  // ------------------------------------------------------------- captures (files)
  r.add({ method: 'GET', path: '/v1/captures/:scope/:sessionId', op: 'list_captures', handler: (c) => rt.captures.list(c.params.scope!, s(c)) });
  r.add({
    method: 'GET', path: '/v1/captures/:scope/:sessionId/:file', op: 'get_capture',
    handler: async (c) => {
      const { data, kind } = await rt.captures.read(c.params.scope!, s(c), c.params.file!);
      sendFile(c.res, data, kind === 'screenshot' ? 'image/png' : 'application/json; charset=utf-8', c.responseHeaders);
      return undefined;
    },
  });

  return r;
}
