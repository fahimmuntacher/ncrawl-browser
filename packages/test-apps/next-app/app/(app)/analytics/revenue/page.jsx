import { DataPage } from '../../DataPage.jsx';

export const metadata = { title: "Revenue \u2014 Northwind ERP" };

export default function Page() {
  return <DataPage title="Revenue" trail={["Analytics", "Revenue"]} />;
}
