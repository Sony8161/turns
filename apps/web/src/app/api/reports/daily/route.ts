// The nightly end-of-day job (Part 8). A scheduler (Vercel Cron in the cloud,
// any timer locally) calls this once a night with the shared secret:
//   Authorization: Bearer <CRON_SECRET>
// It writes yesterday's summary for every location that has none yet. Safe to
// call again: a written day is never rewritten. Answers with counts only.
// Push to the owner's phone waits on the phone app (Part 9); until then the
// owner sees the summary on the admin home.
import { timingSafeEqual } from 'node:crypto';
import { summarizeYesterdayEverywhere } from '@turn/db/reports';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function authorized(request: NextRequest): boolean {
  const secret = process.env['CRON_SECRET'];
  // No secret configured: the endpoint is off, not open.
  if (!secret || secret.length < 32) return false;
  const a = Buffer.from(request.headers.get('authorization') ?? '');
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function run(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json(await summarizeYesterdayEverywhere(db()));
}

export const GET = run;
export const POST = run;
