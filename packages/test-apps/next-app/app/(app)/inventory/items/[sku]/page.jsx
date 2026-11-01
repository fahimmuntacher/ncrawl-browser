import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DataPage } from '../../../DataPage.jsx';

export async function generateMetadata({ params }) {
  const { sku } = await params;
  return { title: `${sku} — Northwind ERP` };
}

export default async function Sku({ params }) {
  const { sku } = await params;
  if (!/^SKU-\d+$/.test(sku)) notFound();
  return <DataPage title={`Item ${sku}`} trail={['Inventory', 'Items', sku]}><Link href="/inventory/items">Back to items</Link></DataPage>;
}
