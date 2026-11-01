import Link from 'next/link';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Server component: simulates a database read, then renders breadcrumbs, heading and a table. */
export async function DataPage({ title, trail, delayMs = 150, children }) {
  await sleep(delayMs);
  const rows = Array.from({ length: 3 + (title.length % 4) }, (_, i) => ({ id: i + 1, name: `${title} ${i + 1}`, owner: i % 2 ? 'Mei' : 'Omar' }));
  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs"><ol><li><Link href="/">Home</Link></li>{trail.map((t) => <li key={t}>{t}</li>)}</ol></nav>
      <h1>{title}</h1>
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>Owner</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td>{r.id}</td><td>{r.name}</td><td>{r.owner}</td></tr>)}</tbody>
      </table>
      {children}
    </>
  );
}
