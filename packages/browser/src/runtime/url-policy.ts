import { NcrawlError } from '../errors.ts';

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export interface UrlPolicy {
  /** Exact origins (scheme://host:port) a session may navigate to. Empty = any http(s) origin. */
  allowedOrigins: readonly string[];
}

export function normalizeOrigins(origins: readonly string[]): string[] {
  return [...new Set(origins.map((o) => {
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      throw new NcrawlError('INVALID_INPUT', `Invalid origin: ${o}`);
    }
    if (!ALLOWED_SCHEMES.has(u.protocol)) throw new NcrawlError('INVALID_INPUT', `Origin must be http(s): ${o}`);
    return u.origin;
  }))];
}

/**
 * Validate a URL the caller asked NCrawl to open.
 * Only http(s); `file:`, `javascript:`, `data:`, `chrome:` and friends are refused outright.
 */
export function checkNavigableUrl(raw: string, policy: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NcrawlError('INVALID_INPUT', 'URL is not absolute or not parseable', { details: { url: raw } });
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new NcrawlError('URL_NOT_ALLOWED', `Scheme ${url.protocol} is not allowed`, { details: { url: raw } });
  }
  if (policy.allowedOrigins.length > 0 && !policy.allowedOrigins.includes(url.origin)) {
    throw new NcrawlError('URL_NOT_ALLOWED', `Origin ${url.origin} is outside this session's allowed origins`, {
      details: { url: raw, allowedOrigins: policy.allowedOrigins },
    });
  }
  return url;
}

export function isWithinPolicy(raw: string, policy: UrlPolicy): boolean {
  try {
    checkNavigableUrl(raw, policy);
    return true;
  } catch {
    return false;
  }
}
