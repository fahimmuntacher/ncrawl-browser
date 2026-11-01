import { DataPage } from '../../DataPage.jsx';

export const metadata = { title: "Purchase orders \u2014 Northwind ERP" };

export default function Page() {
  return <DataPage title="Purchase orders" trail={["Purchasing", "Purchase orders"]} />;
}
