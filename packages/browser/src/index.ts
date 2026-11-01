export { loadConfig, type BrowserConfig } from './config.ts';
export { NcrawlError, isNcrawlError, ERROR_CODES, type ErrorCode } from './errors.ts';
export { createLogger, silentLogger, type Logger, type LogLevel } from './logger.ts';
export { ProfileStore, type ProfileInfo } from './profiles/profile-store.ts';
export { redactUrl, redactText, redactValue, REDACTED } from './redaction.ts';
export { SessionManager, type SessionInfo, type SessionStatus, type SessionKind } from './runtime/session-manager.ts';
export type { NavigationResult, NavigateOptions, WaitUntil } from './runtime/navigation.ts';
export type { PageInfo, PageStatus } from './runtime/page-registry.ts';
export { CreateSessionSchema, NavigateSchema, type CreateSessionInput } from './schemas.ts';
export type { InspectionTarget } from './runtime/session-manager.ts';
export type { HistoryEntry, NavigationInitiator } from './observers/history-recorder.ts';
export type { NetworkRecord, NetworkQuery } from './observers/network-observer.ts';
export { CaptureStore } from './storage/capture-store.ts';
export { Inspector, type InspectOptions, type PageObservation, type InspectPart } from './inspection/inspector.ts';
export type { PageMetadata } from './inspection/page-metadata.ts';
export type { DomSnapshot, DomNode } from './inspection/dom-snapshot.ts';
export type { AccessibilitySnapshot, AxNode } from './inspection/accessibility.ts';
export type { InteractiveElement, NavigationLink, ExpandableGroup, Risk, Region } from './inspection/interactive.ts';
export type { ScreenshotInfo, CaptureMode } from './inspection/screenshot.ts';
export type { StabilityResult } from './inspection/stability.ts';

import type { BrowserConfig } from './config.ts';
import { createLogger, type Logger } from './logger.ts';
import { ProfileStore } from './profiles/profile-store.ts';
import { SessionManager } from './runtime/session-manager.ts';
import { CaptureStore } from './storage/capture-store.ts';
import { Inspector } from './inspection/inspector.ts';

/** Wire up the runtime from a config. */
export function createRuntime(config: BrowserConfig, logger: Logger = createLogger(config.logLevel, { svc: 'ncrawl-browser' })) {
  const profiles = new ProfileStore(config.dataDir);
  const sessions = new SessionManager({ config, profiles, logger });
  const captures = new CaptureStore(config.dataDir);
  const inspector = new Inspector({ sessions, captures, logger });
  return { config, logger, profiles, sessions, captures, inspector };
}
