import { DataPage } from '../../DataPage.jsx';

export const metadata = { title: "Quotes \u2014 Northwind ERP" };

export default function Page() {
  return <DataPage title="Quotes" trail={["Sales", "Quotes"]} />;
}
