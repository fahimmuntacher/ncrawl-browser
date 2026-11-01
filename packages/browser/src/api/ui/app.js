// NCrawl Browser control UI. Plain DOM; page-derived text is only ever set with textContent.

const TOKEN_KEY = 'ncrawl-api-token';
const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
if (fromHash) {
  sessionStorage.setItem(TOKEN_KEY, fromHash);
  history.replaceState(null, '', location.pathname); // keep the token out of the address bar
}
const token = sessionStorage.getItem(TOKEN_KEY);
const $ = (id) => document.getElementById(id);
let selectedSession = null;
let shotUrl = null;

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'onclick') n.addEventListener('click', v);
    else if (k === 'class') n.className = v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) n.append(c instanceof Node ? c : document.createTextNode(String(c ?? '')));
  return n;
}
const badge = (text) => el('span', { class: `badge ${text}` }, text);
const button = (label, onclick, cls) => el('button', { type: 'button', onclick, ...(cls ? { class: cls } : {}) }, label);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (!json.ok) throw Object.assign(new Error(`${json.error.code}: ${json.error.message}`), { apiError: json.error });
  return json.data;
}

function show(value) {
  $('output').classList.remove('muted');
  $('output').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function act(fn) {
  try {
    const result = await fn();
    if (result !== undefined) show(result);
  } catch (e) {
    show(e.apiError ?? String(e));
  }
  await refresh();
}

async function showImage(path) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return show(await res.json());
  if (shotUrl) URL.revokeObjectURL(shotUrl);
  shotUrl = URL.createObjectURL(await res.blob());
  $('shot').src = shotUrl;
  $('shot').hidden = false;
}

// ------------------------------------------------------------------ render

async function refresh() {
  if (!token) return;
  try {
    const [status, profiles, sessions] = await Promise.all([api('GET', '/v1/status'), api('GET', '/v1/profiles'), api('GET', '/v1/sessions')]);
    $('status').textContent = `${status.sessions.running} running · ${status.sessions.paused} paused · ${status.profiles} profiles`;
    renderProfiles(profiles);
    renderSessions(sessions);
    const sel = sessions.find((s) => s.sessionId === selectedSession);
    if (!sel) selectedSession = null;
    $('session-detail').hidden = !sel;
    if (sel) await renderDetail(sel);
  } catch (e) {
    $('status').textContent = `error: ${e.message}`;
  }
}

function renderProfiles(profiles) {
  $('profiles').replaceChildren(...profiles.map((p) => el('li', {},
    el('span', { class: 'grow' }, `${p.displayName} `, el('code', {}, p.projectId)),
    p.inUse ? badge('open') : '',
    button('Delete', () => confirm(`Delete profile ${p.projectId} and its saved logins?`) && act(() => api('DELETE', `/v1/profiles/${p.projectId}`))),
  )));
  $('session-project').replaceChildren(...profiles.map((p) => el('option', { value: p.projectId }, p.projectId)));
}

function renderSessions(sessions) {
  $('sessions').replaceChildren(...sessions.map((s) => {
    const id = s.sessionId;
    const li = el('li', { class: id === selectedSession ? 'selected' : '' },
      el('span', { class: 'grow' }, el('code', {}, id), ` ${s.kind}${s.projectId ? ` · ${s.projectId}` : ''}${s.headless ? ' · headless' : ''}`),
      badge(s.status), badge(s.control),
      button('Select', () => { selectedSession = id; refresh(); }),
      s.control === 'paused' ? button('Resume', () => act(() => api('POST', `/v1/sessions/${id}/resume`)))
        : button('Pause', () => act(() => api('POST', `/v1/sessions/${id}/pause`))),
      s.status === 'disconnected' ? button('Restart', () => act(() => api('POST', `/v1/sessions/${id}/restart`))) : '',
      button('Stop', () => act(() => api('POST', `/v1/sessions/${id}/stop`)), 'danger'),
      button('Close', () => act(() => api('DELETE', `/v1/sessions/${id}`))),
    );
    return li;
  }));
}

async function renderDetail(session) {
  const sid = session.sessionId;
  $('sel-session').textContent = sid;
  $('pages').replaceChildren(...session.pages.map((p) => {
    const base = `/v1/sessions/${sid}/pages/${p.pageId}`;
    const url = el('input', { type: 'url', placeholder: 'navigate to…', size: '30' });
    const full = el('input', { type: 'checkbox' });
    return el('li', {},
      el('span', { class: 'grow' }, el('code', {}, p.pageId), ' ', p.url || '(blank)'), badge(p.status),
      url, button('Go', () => act(() => api('POST', `${base}/navigate`, { url: url.value }))),
      button('←', () => act(() => api('POST', `${base}/back`))),
      button('→', () => act(() => api('POST', `${base}/forward`))),
      button('Reload', () => act(() => api('POST', `${base}/reload`))),
      p.status === 'crashed' ? button('Recover', () => act(() => api('POST', `${base}/recover`))) : '',
      el('label', {}, full, ' full page'),
      button('Screenshot', () => act(async () => {
        const shot = await api('POST', `${base}/screenshot`, { mode: full.checked ? 'full_page' : 'viewport' });
        await showImage(`/v1/captures/${shot.file}`);
        return shot;
      })),
      button('Inspect', () => act(async () => {
        const obs = await api('POST', `${base}/inspect`, { screenshot: full.checked ? 'full_page' : 'viewport' });
        if (obs.screenshot) await showImage(`/v1/captures/${obs.screenshot.file}`);
        return summarize(obs);
      })),
      button('History', () => act(() => api('GET', `${base}/history`))),
      button('Close tab', () => act(() => api('DELETE', base))),
    );
  }));
  try {
    const scope = session.projectId ?? '_ephemeral';
    const files = await api('GET', `/v1/captures/${scope}/${sid}`);
    $('captures').replaceChildren(...files.map((f) => el('li', {},
      el('span', { class: 'grow' }, f.file), el('span', { class: 'muted' }, `${Math.round(f.bytes / 1024)} KB`),
      button('View', () => f.kind === 'screenshot'
        ? showImage(`/v1/captures/${scope}/${sid}/${f.file}`)
        : act(() => api('GET', `/v1/captures/${scope}/${sid}/${f.file}`))),
    )));
  } catch {
    $('captures').replaceChildren(el('li', { class: 'muted' }, 'No captures yet.'));
  }
}

function summarize(obs) {
  return {
    status: obs.status, errors: obs.errors, url: obs.metadata?.url, title: obs.metadata?.title, stable: obs.stability?.stable,
    headings: obs.metadata?.text.headings,
    navigationLinks: obs.navigationLinks?.map((l) => `${l.region} | ${[...l.menuPath, l.label].join(' > ')} -> ${l.url}${l.excluded ? ` (excluded: ${l.excluded})` : ''}`),
    expandableGroups: obs.expandableGroups?.map((g) => `${g.label} (${g.expanded ? 'open' : 'closed'})`),
    network: obs.network?.summary,
    file: obs.file,
    accessibilityOutline: obs.accessibility?.outline,
  };
}

// ------------------------------------------------------------------ wiring

$('profile-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  act(() => api('POST', '/v1/profiles', { projectId: f.get('projectId'), ...(f.get('displayName') ? { displayName: f.get('displayName') } : {}) }));
});
$('session-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const kind = f.get('kind');
  act(async () => {
    const s = await api('POST', '/v1/sessions', { kind, headless: f.get('headless') === 'on', ...(kind === 'persistent' ? { projectId: f.get('projectId') } : {}) });
    selectedSession = s.sessionId;
    return s;
  });
});
$('open-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = new FormData(e.target).get('url');
  act(() => api('POST', `/v1/sessions/${selectedSession}/pages`, { url }));
});
$('stop-all').addEventListener('click', () => act(() => api('POST', '/v1/stop')));

if (!token) {
  $('token-missing').hidden = false;
  $('status').textContent = 'no token';
} else {
  refresh();
  // Auto-refresh, but never while the user is typing (re-rendering would wipe the input).
  setInterval(() => {
    const a = document.activeElement;
    if (!(a && (a.tagName === 'INPUT' || a.tagName === 'SELECT'))) refresh();
  }, 5000);
}
