import { DataPage } from '../../DataPage.jsx';

export const metadata = { title: "Warehouses \u2014 Northwind ERP" };

export default function Page() {
  return <DataPage title="Warehouses" trail={["Inventory", "Warehouses"]} />;
}
