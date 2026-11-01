import { DataPage } from '../../DataPage.jsx';

export const metadata = { title: "Suppliers \u2014 Northwind ERP" };

export default function Page() {
  return <DataPage title="Suppliers" trail={["Purchasing", "Suppliers"]} />;
}
