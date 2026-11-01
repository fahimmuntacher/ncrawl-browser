import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger } from '../../src/logger.ts';
import { isSensitiveKey, REDACTED, redactText, redactUrl, redactValue } from '../../src/redaction.ts';

test('secret field names are detected; ordinary NCrawl fields are not', () => {
  for (const k of ['password', 'Authorization', 'set-cookie', 'x-api-key', 'accessToken', 'refresh_token', 'client_secret', 'csrfToken', 'apiKey', 'privateKey']) {
    assert.ok(isSensitiveKey(k), k);
  }
  for (const k of ['sessionId', 'pageId', 'code', 'errorCode', 'status', 'author', 'url', 'title', 'keyboard', 'state']) {
    assert.ok(!isSensitiveKey(k), k);
  }
});

test('URL query/fragment secrets, session IDs, OAuth codes and userinfo are redacted', () => {
  const out = redactUrl('https://user:pw@erp.example/cb?code=abc&state=xyz&page=2&jsessionid=s1&X-Amz-Signature=f#access_token=t&view=1');
  const u = new URL(out);
  assert.equal(u.username, encodeURIComponent(REDACTED));
  assert.equal(u.password, encodeURIComponent(REDACTED));
  assert.equal(u.searchParams.get('code'), REDACTED);
  assert.equal(u.searchParams.get('state'), REDACTED);
  assert.equal(u.searchParams.get('jsessionid'), REDACTED);
  assert.equal(u.searchParams.get('X-Amz-Signature'), REDACTED);
  assert.equal(u.searchParams.get('page'), '2');
  const frag = new URLSearchParams(u.hash.slice(1));
  assert.equal(frag.get('access_token'), REDACTED);
  assert.equal(frag.get('view'), '1');
});

test('URLs without secrets are unchanged; non-URLs pass through', () => {
  assert.equal(redactUrl('https://erp.example/app/hr?tab=2#top'), 'https://erp.example/app/hr?tab=2#top');
  assert.equal(redactUrl('not a url'), 'not a url');
});

test('URLs embedded in error text are redacted', () => {
  const msg = 'page.goto: net::ERR_FAILED at https://erp.example/x?token=s3cr3t\nCall log: navigating to "https://erp.example/x?token=s3cr3t"';
  const out = redactText(msg);
  assert.ok(!out.includes('s3cr3t'), out);
  assert.ok(out.includes('net::ERR_FAILED'));
});

test('deep redaction of objects and errors', () => {
  const v = redactValue({ headers: { Authorization: 'Bearer x', accept: '*/*' }, nested: [{ cookie: 'a=b' }], err: new Error('at https://h/?api_key=k') }) as Record<string, any>;
  assert.equal(v.headers.Authorization, REDACTED);
  assert.equal(v.headers.accept, '*/*');
  assert.equal(v.nested[0].cookie, REDACTED);
  assert.ok(!JSON.stringify(v.err).includes('api_key=k'));
});

test('logger output never contains secrets', () => {
  const lines: string[] = [];
  const log = createLogger('debug', { sessionId: 'ses_1' }, (l) => lines.push(l));
  log.info('nav', { url: 'https://h/a?token=zzz', password: 'hunter2', code: 'NAVIGATION_TIMEOUT' });
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.sessionId, 'ses_1');
  assert.equal(rec.password, REDACTED);
  assert.equal(rec.code, 'NAVIGATION_TIMEOUT');
  assert.ok(!lines[0]!.includes('zzz') && !lines[0]!.includes('hunter2'));
});
