export const ERROR_CODES = [
  'INVALID_INPUT',
  'URL_NOT_ALLOWED',
  'PROFILE_NOT_FOUND',
  'PROFILE_IN_USE',
  'SESSION_NOT_FOUND',
  'SESSION_NOT_RUNNING',
  'PAGE_NOT_FOUND',
  'PAGE_CRASHED',
  'BROWSER_LAUNCH_FAILED',
  'BROWSER_CRASHED',
  'NAVIGATION_TIMEOUT',
  'NAVIGATION_FAILED',
  'HISTORY_UNAVAILABLE',
  'CAPTURE_FAILED',
  'INSPECTION_FAILED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class NcrawlError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NcrawlError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }

  toJSON(): { code: ErrorCode; message: string; retryable: boolean; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

export function isNcrawlError(e: unknown, code?: ErrorCode): e is NcrawlError {
  return e instanceof NcrawlError && (code === undefined || e.code === code);
}
