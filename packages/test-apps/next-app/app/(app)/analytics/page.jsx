import { DataPage } from '../DataPage.jsx';

export const metadata = { title: 'Analytics overview — Northwind ERP' };

// Slow server component: Next streams loading.jsx first, then this page.
export default function Analytics() {
  return <DataPage title="Analytics overview" trail={['Analytics', 'Analytics overview']} delayMs={900} />;
}
