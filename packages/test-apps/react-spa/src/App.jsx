import { createContext, lazy, Suspense, useContext, useEffect, useId, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router';
import ROUTES from '../routes.json';

// ---------------------------------------------------------------- auth (token in localStorage, not a cookie)

const AuthContext = createContext(null);
const TOKEN_KEY = 'acme-crm-token';

function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const value = {
    token,
    login: (t) => { localStorage.setItem(TOKEN_KEY, t); setToken(t); },
    logout: () => { localStorage.removeItem(TOKEN_KEY); setToken(null); },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
const useAuth = () => useContext(AuthContext);

function RequireAuth({ children }) {
  const { token } = useAuth();
  const location = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState('');
  async function onSubmit(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
    });
    if (!res.ok) return setError('Invalid credentials');
    login((await res.json()).token);
    navigate(location.state?.from ?? '/', { replace: true });
  }
  return (
    <form className="login" onSubmit={onSubmit}>
      <h1>Sign in to Acme CRM</h1>
      <label>Username <input name="username" autoComplete="username" required /></label>
      <label>Password <input name="password" type="password" autoComplete="current-password" required /></label>
      <button type="submit">Sign in</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------- layout

function Group({ item, trail }) {
  const [open, setOpen] = useState(false); // collapsed by default; children are not rendered until opened
  const id = useId();
  return (
    <li>
      <button type="button" className="group-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {item.label}
      </button>
      {open && <NavTree items={item.children} id={id} trail={[...trail, item.label]} />}
    </li>
  );
}

function NavTree({ items, id, trail = [] }) {
  return (
    <ul id={id} role={trail.length ? 'group' : undefined}>
      {items.map((item) => item.children
        ? <Group key={item.label} item={item} trail={trail} />
        : <li key={item.path}><NavLink to={item.path} end>{item.label}</NavLink></li>)}
    </ul>
  );
}

function Layout({ children }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <header>
        <span className="brand">Acme CRM</span>
        <nav aria-label="Top"><Link to="/">Dashboard</Link> · <Link to="/reports/sales">Reports</Link></nav>
        <button type="button" onClick={() => { logout(); navigate('/login'); }}>Sign out</button>
      </header>
      <div className="shell">
        <aside aria-label="Sidebar"><nav aria-label="Main navigation"><NavTree items={ROUTES.nav} /></nav></aside>
        <main>{children}</main>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- pages

function useItems(route) {
  const { token } = useAuth();
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let live = true;
    setRows(null);
    fetch(`/api/items?route=${encodeURIComponent(route)}`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((d) => live && setRows(d.rows));
    return () => { live = false; };
  }, [route, token]);
  return rows;
}

function Page({ title, trail, children }) {
  const location = useLocation();
  const rows = useItems(location.pathname);
  useEffect(() => { document.title = `${title} — Acme CRM`; }, [title]);
  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs"><ol><li><Link to="/">Home</Link></li>{trail.map((t) => <li key={t}>{t}</li>)}</ol></nav>
      <h1>{title}</h1>
      {rows === null ? <p>Loading…</p> : (
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Owner</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td>{r.id}</td><td>{r.name}</td><td>{r.owner}</td></tr>)}</tbody>
        </table>
      )}
      {children}
    </>
  );
}

function Deals() {
  return (
    <Page title="Deals" trail={['CRM', 'Deals']}>
      <h2>Open deals</h2>
      <ul>{[101, 102, 103].map((id) => <li key={id}><Link to={`/crm/deals/${id}`}>Deal #{id}</Link></li>)}</ul>
    </Page>
  );
}

function DealDetail() {
  const { id } = useParams();
  return <Page title={`Deal #${id}`} trail={['CRM', 'Deals', `#${id}`]}><Link to="/crm/deals">Back to deals</Link></Page>;
}

function Billing() {
  const { token } = useAuth();
  const mutate = () => fetch('/api/mutate', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  return (
    <Page title="Billing" trail={['Settings', 'Billing']}>
      <form onSubmit={(e) => { e.preventDefault(); mutate(); }}>
        <label>Card number <input name="card" /></label> <button type="submit">Update card</button>
      </form>
      <p><button type="button" className="danger" onClick={mutate}>Delete workspace</button></p>
    </Page>
  );
}

// Code-split route: exercises React.lazy + Suspense.
const Reports = lazy(() => import('./Reports.jsx'));

const flat = [];
(function walk(items, trail) {
  for (const i of items) i.children ? walk(i.children, [...trail, i.label]) : flat.push({ ...i, trail: [...trail, i.label] });
})(ROUTES.nav, []);

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={
          <RequireAuth>
            <Layout>
              <Routes>
                <Route path="/crm/deals" element={<Deals />} />
                <Route path="/crm/deals/:id" element={<DealDetail />} />
                <Route path="/settings/billing" element={<Billing />} />
                <Route path="/reports/:kind" element={<Suspense fallback={<p>Loading report…</p>}><Reports /></Suspense>} />
                {flat.filter((r) => !['/crm/deals', '/settings/billing'].includes(r.path) && !r.path.startsWith('/reports/')).map((r) =>
                  <Route key={r.path} path={r.path} element={<Page title={r.label} trail={r.trail} />} />)}
                <Route path="*" element={<><h1>Not found</h1><Link to="/">Go home</Link></>} />
              </Routes>
            </Layout>
          </RequireAuth>
        } />
      </Routes>
    </AuthProvider>
  );
}

export { Page };
