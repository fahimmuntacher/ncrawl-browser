import { NextResponse } from 'next/server';

// Next.js 16 "proxy" (formerly middleware): unauthenticated requests go to /login?next=<path>.
export function proxy(request) {
  if (request.cookies.has('nw_session')) return NextResponse.next();
  const url = new URL('/login', request.url);
  url.searchParams.set('next', request.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = { matcher: ['/((?!login|api/stats|_next/|favicon.ico).*)'] };
