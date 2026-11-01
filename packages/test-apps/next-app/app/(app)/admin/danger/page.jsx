import { resetAllData } from '../../../actions.js';
import { DataPage } from '../../DataPage.jsx';

export const metadata = { title: 'Danger zone — Northwind ERP' };

export default function Danger() {
  return (
    <DataPage title="Danger zone" trail={['Admin', 'Danger zone']}>
      <form action={resetAllData}><button type="submit" className="danger">Reset all data</button></form>
    </DataPage>
  );
}
