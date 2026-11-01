// Mock ERP single-page app. Client-side routing via history.pushState.
// Sidebar groups are collapsed by default and their children are NOT in the DOM until expanded,
// so navigation discovery has to expand menus (safely) to find nested routes.

const NAV = [
  { label: 'Dashboard', path: '/app' },
  {
    label: 'HR', children: [
      { label: 'Employees', path: '/app/hr/employees', form: true },
      { label: 'Attendance', path: '/app/hr/attendance' },
      {
        label: 'Payroll', children: [
          { label: 'Payslips', path: '/app/hr/payroll/payslips' },
          { label: 'Salary Structure', path: '/app/hr/payroll/structure' },
          { label: 'Tax Settings', path: '/app/hr/payroll/tax' },
        ],
      },
      { label: 'Leave Requests', path: '/app/hr/leave' },
    ],
  },
  {
    label: 'Inventory', children: [
      { label: 'Products', path: '/app/inventory/products', form: true },
      { label: 'Warehouses', path: '/app/inventory/warehouses' },
      { label: 'Stock Movements', path: '/app/inventory/movements' },
      { label: 'Suppliers', path: '/app/inventory/suppliers' },
    ],
  },
  {
    label: 'Finance', children: [
      { label: 'Invoices', path: '/app/finance/invoices', form: true },
      { label: 'Payments', path: '/app/finance/payments' },
      {
        label: 'Ledger', children: [
          { label: 'General Ledger', path: '/app/finance/ledger/general' },
          { label: 'Trial Balance', path: '/app/finance/ledger/trial-balance' },
        ],
      },
    ],
  },
  {
    label: 'Reports', path: '/app/reports', children: [
      { label: 'Sales Report', path: '/app/reports/sales' },
      { label: 'Inventory Report', path: '/app/reports/inventory', long: true },
    ],
  },
  {
    label: 'Settings', path: '/app/settings', children: [
      { label: 'Users', path: '/app/settings/users' },
      { label: 'Restricted Area', path: '/app/settings/restricted', restricted: true },
    ],
  },
];

const ROUTES = new Map();
(function index(items, trail) {
  for (const item of items) {
    const here = [...trail, item.label];
    if (item.path) ROUTES.set(item.path, { ...item, trail: here });
    if (item.children) index(item.children, here);
  }
})(NAV, []);

const expanded = new Set(JSON.parse(sessionStorage.getItem('erp-expanded') || '[]'));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function renderNav(items, depth, idPrefix) {
  const list = el('ul', { class: `nav-level-${depth}`, role: depth === 0 ? null : 'group' });
  items.forEach((item, i) => {
    const id = `${idPrefix}-${i}`;
    const li = el('li', {});
    if (item.children) {
      const open = expanded.has(item.label);
      const toggle = el('button', {
        type: 'button', class: 'nav-toggle', 'aria-expanded': String(open), 'aria-controls': id, 'data-testid': `toggle-${item.label}`,
        on: { click: () => { open ? expanded.delete(item.label) : expanded.add(item.label); sessionStorage.setItem('erp-expanded', JSON.stringify([...expanded])); render(); } },
      }, `${open ? '▾' : '▸'} ${item.label}`);
      li.append(toggle);
      if (item.path) li.append(el('a', { href: item.path, class: 'nav-link nav-parent-link' }, `${item.label} overview`));
      if (open) li.append(Object.assign(renderNav(item.children, depth + 1, id), { id }));
    } else {
      const current = location.pathname === item.path;
      li.append(el('a', { href: item.path, class: 'nav-link', 'aria-current': current ? 'page' : false }, item.label));
    }
    list.append(li);
  });
  return list;
}

function table(rows) {
  return el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'ID'), el('th', {}, 'Name'), el('th', {}, 'Status'))),
    el('tbody', {}, rows.map((r) => el('tr', {}, el('td', {}, r.id), el('td', {}, r.name), el('td', {}, r.status)))));
}

async function renderMain(route) {
  const main = document.getElementById('main');
  main.replaceChildren();
  if (!route) {
    document.title = 'Not found — Mock ERP';
    main.append(el('h1', {}, 'Page not found'), el('p', { class: 'error' }, 'This route does not exist.'));
    return;
  }
  document.title = `${route.label} — Mock ERP`;
  main.append(el('nav', { 'aria-label': 'Breadcrumb', class: 'breadcrumbs' },
    el('ol', {}, el('li', {}, el('a', { href: '/app' }, 'Home')), route.trail.map((t) => el('li', {}, t)))));
  main.append(el('h1', {}, route.label));
  if (route.restricted) {
    main.append(el('p', { class: 'error', role: 'alert' }, '403 — You do not have permission to view this page.'));
    return;
  }
  main.append(el('p', { class: 'loading' }, 'Loading…'));
  // Authorization header is deliberate: NCrawl must redact it from network metadata.
  const res = await fetch(`/api/data?page=${encodeURIComponent(route.path)}`, {
    headers: { Authorization: 'Bearer mock-secret-token-123' },
  });
  const data = await res.json();
  if (location.pathname !== route.path) return; // navigated away while loading
  main.querySelector('.loading').remove();
  main.append(el('p', {}, `${data.rows.length} records in ${route.trail.join(' / ')}.`), table(data.rows));
  if (route.path === '/app') {
    // Deliberate test fixtures: a token in a query string (must be redacted) and a request that fails.
    fetch('/api/ping?access_token=mock-query-secret&view=dashboard').catch(() => {});
    main.append(el('img', { src: 'http://127.0.0.1:65531/missing-logo.png', alt: 'Partner logo' }));
  }
  if (route.form) {
    main.append(el('h2', {}, 'Create new'),
      el('form', { method: 'post', action: '/api/mutate', class: 'create-form' },
        el('label', {}, 'Name ', el('input', { name: 'name', required: true })),
        el('button', { type: 'submit' }, 'Save')));
  }
  if (route.long) {
    for (let i = 0; i < 60; i++) main.append(el('p', { class: 'filler' }, `Section ${i + 1}: lorem ipsum inventory figures.`));
  }
}

function render() {
  const route = ROUTES.get(location.pathname);
  document.getElementById('sidebar').replaceChildren(renderNav(NAV, 0, 'nav'));
  renderMain(route);
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.target === '_blank' || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin === location.origin && url.pathname.startsWith('/app')) {
    e.preventDefault();
    if (url.pathname !== location.pathname) history.pushState({}, '', url.pathname);
    render();
  }
});
window.addEventListener('popstate', render);
render();
