import 'server-only';
import { headers } from 'next/headers';

/** Best-effort client address for rate limiting; "unknown" when no proxy header. */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || h.get('x-real-ip') || 'unknown';
}
