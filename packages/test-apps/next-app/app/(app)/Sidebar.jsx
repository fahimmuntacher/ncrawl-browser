'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId, useState } from 'react';
import ROUTES from '../../routes.json';

function Group({ item, pathname }) {
  const [open, setOpen] = useState(false); // collapsed; children not rendered until opened
  const id = useId();
  return (
    <li>
      <button type="button" className="group-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {item.label}
      </button>
      {open && <Tree items={item.children} id={id} nested pathname={pathname} />}
    </li>
  );
}

function Tree({ items, id, nested, pathname }) {
  return (
    <ul id={id} role={nested ? 'group' : undefined}>
      {items.map((i) => i.children
        ? <Group key={i.label} item={i} pathname={pathname} />
        : <li key={i.path}><Link href={i.path} aria-current={pathname === i.path ? 'page' : undefined}>{i.label}</Link></li>)}
    </ul>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  return <nav aria-label="Main navigation"><Tree items={ROUTES.nav} pathname={pathname} /></nav>;
}
