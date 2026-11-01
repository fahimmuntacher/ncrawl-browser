'use server';
import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { stats } from './stats.js';

export async function login(_prev, formData) {
  if (formData.get('username') !== 'demo' || formData.get('password') !== 'demo') return { error: 'Invalid credentials' };
  stats.logins++;
  // Persistent cookie (maxAge) so the login survives a browser restart with the same profile.
  (await cookies()).set('nw_session', randomBytes(18).toString('base64url'), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 86400 });
  const next = String(formData.get('next') || '/');
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}

export async function logout() {
  (await cookies()).delete('nw_session');
  redirect('/login');
}

export async function resetAllData() {
  stats.mutations++;
}
