/**
 * Redaction of secrets from anything NCrawl logs, returns, or exports.
 * Conservative by design: a false positive costs a little detail, a false negative leaks a secret.
 */

export const REDACTED = '[REDACTED]';

/** Any key containing one of these tokens is treated as secret, in every context. */
const SECRET_TOKENS = new Set([
  'password', 'passwd', 'pwd', 'passphrase', 'secret', 'token', 'cookie', 'cookies',
  'credential', 'credentials', 'authorization', 'auth', 'jwt', 'bearer', 'otp', 'totp',
  'csrf', 'xsrf', 'apikey', 'pin',
]);
/** Joined-key fragments (e.g. "api_key", "x-api-key", "privateKey"). */
const SECRET_JOINED = ['apikey', 'accesskey', 'privatekey', 'secretkey', 'setcookie', 'clientsecret'];
/**
 * Extra tokens that are secrets in URLs (session IDs, OAuth codes, signed-URL signatures)
 * but are ordinary field names in NCrawl's own structured data (e.g. `sessionId`).
 */
const URL_ONLY_TOKENS = new Set([
  'session', 'sessionid', 'sid', 'jsessionid', 'phpsessid', 'code', 'sig', 'signature', 'ticket', 'nonce', 'saml',
  'samlresponse', 'assertion', 'state', 'key',
]);

function tokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveKey(key: string, context: 'field' | 'url' = 'field'): boolean {
  const parts = tokens(key);
  const joined = parts.join('');
  if (parts.some((t) => SECRET_TOKENS.has(t))) return true;
  if (SECRET_JOINED.some((j) => joined.includes(j))) return true;
  if (context === 'url' && (parts.some((t) => URL_ONLY_TOKENS.has(t)) || URL_ONLY_TOKENS.has(joined))) return true;
  return false;
}

function redactParams(params: URLSearchParams): boolean {
  let changed = false;
  for (const key of new Set(params.keys())) {
    if (isSensitiveKey(key, 'url')) {
      params.set(key, REDACTED);
      changed = true;
    }
  }
  return changed;
}

/** Redact userinfo plus sensitive query and fragment parameters. Non-URLs are returned unchanged. */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.username) url.username = REDACTED;
  if (url.password) url.password = REDACTED;
  const query = new URLSearchParams(url.search);
  if (redactParams(query)) url.search = query.toString();
  if (url.hash.includes('=')) {
    const frag = new URLSearchParams(url.hash.slice(1));
    if (redactParams(frag)) url.hash = frag.toString();
  }
  return url.toString();
}

const EMBEDDED_URL = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi;

/** Redact every URL that appears anywhere in free text (e.g. error messages). */
export function redactText(text: string): string {
  return text.replace(EMBEDDED_URL, (m) => redactUrl(m));
}

/** Deep-redact values under sensitive keys, and URLs inside string values. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return { name: value.name, message: redactText(value.message), ...(typeof code === 'string' ? { code } : {}) };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}
