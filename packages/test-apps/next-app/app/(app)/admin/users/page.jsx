import { DataPage } from '../../DataPage.jsx';

export const metadata = { title: "Users \u2014 Northwind ERP" };

export default function Page() {
  return <DataPage title="Users" trail={["Admin", "Users"]} />;
}
