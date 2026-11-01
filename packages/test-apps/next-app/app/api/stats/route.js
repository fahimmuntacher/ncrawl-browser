import { stats } from '../../stats.js';

export const dynamic = 'force-dynamic';
export function GET() {
  return Response.json(stats);
}
