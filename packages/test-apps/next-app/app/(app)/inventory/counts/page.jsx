import { DataPage } from '../../DataPage.jsx';

export const metadata = { title: "Stock counts \u2014 Northwind ERP" };

export default function Page() {
  return <DataPage title="Stock counts" trail={["Inventory", "Stock counts"]} />;
}
