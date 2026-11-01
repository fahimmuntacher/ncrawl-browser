import { DataPage } from '../../DataPage.jsx';

export const metadata = { title: "Roles \u2014 Northwind ERP" };

export default function Page() {
  return <DataPage title="Roles" trail={["Admin", "Roles"]} />;
}
