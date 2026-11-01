import { LoginForm } from './LoginForm.jsx';

export const metadata = { title: 'Sign in — Northwind ERP' };

export default async function LoginPage({ searchParams }) {
  const { next } = await searchParams;
  return <LoginForm next={typeof next === 'string' ? next : '/'} />;
}
