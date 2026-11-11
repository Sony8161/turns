// The scheduled calendar poll (Part 7). A scheduler (Vercel Cron in the cloud,
// any timer locally) calls this every 15 minutes with the shared secret:
//   Authorization: Bearer <CRON_SECRET>
// Server only. Answers with counts, never a URL or an appointment (T14).
import { timingSafeEqual } from 'node:crypto';
import { pollFeeds } from '@turn/db/feeds';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function authorized(request: NextRequest): boolean {
  const secret = process.env['CRON_SECRET'];
  // No secret configured: the endpoint is off, not open.
  if (!secret || secret.length < 32) return false;
  const given = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function poll(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const result = await pollFeeds(db());
  return NextResponse.json(result);
}

export const GET = poll;
export const POST = poll;
