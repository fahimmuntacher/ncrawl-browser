import Link from 'next/link';
import { logout } from '../actions.js';
import { Sidebar } from './Sidebar.jsx';

// Per-request rendering, like a real ERP behind a login (and so loading.jsx actually streams).
export const dynamic = 'force-dynamic';

export default function AppLayout({ children }) {
  return (
    <>
      <header>
        <span className="brand">Northwind ERP</span>
        <nav aria-label="Top"><Link href="/">Dashboard</Link> · <Link href="/analytics">Analytics</Link></nav>
        <form action={logout}><button type="submit">Log out</button></form>
      </header>
      <div className="shell">
        <aside aria-label="Sidebar"><Sidebar /></aside>
        <main>{children}</main>
      </div>
    </>
  );
}
