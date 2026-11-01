import { DataPage } from '../../DataPage.jsx';

export const metadata = { title: "Audit log \u2014 Northwind ERP" };

export default function Page() {
  return <DataPage title="Audit log" trail={["Admin", "Audit log"]} />;
}
