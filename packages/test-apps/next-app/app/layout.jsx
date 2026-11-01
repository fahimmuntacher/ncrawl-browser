import './style.css';

export const metadata = { title: 'Northwind ERP' };

export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}
