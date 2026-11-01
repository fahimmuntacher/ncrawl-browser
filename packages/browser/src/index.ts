export { loadConfig, type BrowserConfig } from './config.ts';
export { NcrawlError, isNcrawlError, ERROR_CODES, type ErrorCode } from './errors.ts';
export { createLogger, silentLogger, type Logger, type LogLevel } from './logger.ts';
export { ProfileStore, type ProfileInfo } from './profiles/profile-store.ts';
export { redactUrl, redactText, redactValue, REDACTED } from './redaction.ts';
export { SessionManager, type SessionInfo, type SessionStatus, type SessionKind } from './runtime/session-manager.ts';
export type { NavigationResult, NavigateOptions, WaitUntil } from './runtime/navigation.ts';
export type { PageInfo, PageStatus } from './runtime/page-registry.ts';
export { CreateSessionSchema, NavigateSchema, type CreateSessionInput } from './schemas.ts';

import type { BrowserConfig } from './config.ts';
import { createLogger, type Logger } from './logger.ts';
import { ProfileStore } from './profiles/profile-store.ts';
import { SessionManager } from './runtime/session-manager.ts';

/** Wire up the runtime from a config. */
export function createRuntime(config: BrowserConfig, logger: Logger = createLogger(config.logLevel, { svc: 'ncrawl-browser' })) {
  const profiles = new ProfileStore(config.dataDir);
  const sessions = new SessionManager({ config, profiles, logger });
  return { config, logger, profiles, sessions };
}
