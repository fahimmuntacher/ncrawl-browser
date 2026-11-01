import { DataPage } from '../../DataPage.jsx';

export const metadata = { title: "Invoices \u2014 Northwind ERP" };

export default function Page() {
  return <DataPage title="Invoices" trail={["Sales", "Invoices"]} />;
}
