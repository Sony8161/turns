// v0.10.1 (Part 10 review finding 8): where browsers send CSP violation
// reports (report-uri and report-to in lib/csp.ts). Open to anyone, as browsers
// send without a session, so: a small body only, rate limited per address and
// overall, and one log line per violation with the directive and the blocked
// origin only (lib/csp-report.ts). Always answers 204 with nothing in it.
import { consumeRateLimit } from '@turn/db/rate-limit';
import { NextResponse, type NextRequest } from 'next/server';
import { parseCspReport } from '@/lib/csp-report';
import { db } from '@/lib/db';
import { logFailure } from '@/lib/failure';
import { clientIp } from '@/lib/request';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 16_384;
const PER_IP = 20; // per 10 minutes
const OVERALL = 500; // per hour

const done = () => new NextResponse(null, { status: 204 });

export async function POST(request: NextRequest) {
  try {
    const length = Number(request.headers.get('content-length') ?? '0');
    if (length > MAX_BYTES) return done();
    const text = await request.text();
    if (text.length > MAX_BYTES) return done();

    const ip = await clientIp();
    const [byIp, overall] = await Promise.all([
      consumeRateLimit(db(), `csp:ip:${ip}`, PER_IP, 600),
      consumeRateLimit(db(), 'csp:all', OVERALL, 3600),
    ]);
    if (!byIp.allowed || !overall.allowed) return done();

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return done();
    }
    for (const v of parseCspReport(body)) console.warn('csp violation', v);
  } catch (e) {
    logFailure('route:/api/csp-report', e);
  }
  return done();
}
