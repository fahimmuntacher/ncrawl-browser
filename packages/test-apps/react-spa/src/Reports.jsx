import { useParams } from 'react-router';
import { Page } from './App.jsx';

export default function Reports() {
  const { kind } = useParams();
  const title = kind === 'sales' ? 'Sales report' : 'Pipeline report';
  return (
    <Page title={title} trail={['Reports', title]}>
      {Array.from({ length: 40 }, (_, i) => <p key={i}>Quarter figure {i + 1}</p>)}
    </Page>
  );
}
