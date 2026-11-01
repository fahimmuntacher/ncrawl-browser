import { DataPage } from '../../DataPage.jsx';

export const metadata = { title: "Customers \u2014 Northwind ERP" };

export default function Page() {
  return <DataPage title="Customers" trail={["Sales", "Customers"]} />;
}
