import Link from 'next/link';
import { DataPage } from '../../DataPage.jsx';

export const metadata = { title: 'Items — Northwind ERP' };

export default function Items() {
  return (
    <DataPage title="Items" trail={['Inventory', 'Items']}>
      <h2>Featured SKUs</h2>
      <ul>{[1, 2, 3].map((n) => <li key={n}><Link href={`/inventory/items/SKU-${n}`}>SKU-{n}</Link></li>)}</ul>
    </DataPage>
  );
}
