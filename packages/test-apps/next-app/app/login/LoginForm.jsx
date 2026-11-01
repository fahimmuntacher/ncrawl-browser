'use client';
import { useActionState } from 'react';
import { login } from '../actions.js';

export function LoginForm({ next }) {
  const [state, action, pending] = useActionState(login, null);
  return (
    <form className="login" action={action}>
      <h1>Sign in to Northwind ERP</h1>
      <input type="hidden" name="next" value={next} />
      <label>Username <input name="username" autoComplete="username" required /></label>
      <label>Password <input name="password" type="password" autoComplete="current-password" required /></label>
      <button type="submit" disabled={pending}>Sign in</button>
      {state?.error && <p role="alert">{state.error}</p>}
    </form>
  );
}
