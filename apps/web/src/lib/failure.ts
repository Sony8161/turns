// v0.10.1 (Part 10 review findings 1 and 2): one scrubbed log line for a
// failure nobody planned. It carries where it happened, the error's class and
// the database's error code (Postgres puts it on the cause, not on the error
// Drizzle throws) and a short reference the person can read out to support.
// Never the message: Drizzle's message quotes the query's parameters, which
// can be a client's name or phone. Never the stack. Pure apart from the
// random reference, so the action guard, the request-error hook and the tests
// share it.

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** A short reference for one failure, e.g. "K7Q2MX". Not a secret and not
 *  unique forever; it only has to find one log line in a day. */
export function newErrorRef(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += REF_ALPHABET[b % REF_ALPHABET.length];
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && /^[\w.-]{1,40}$/.test(v) ? v : undefined;
}

export type FailureLine = {
  where: string;
  ref: string;
  kind: string;
  code?: string;
};

/** What may be logged about an error: its class and a code, nothing else. */
export function describeFailure(where: string, ref: string, e: unknown): FailureLine {
  let kind: string = typeof e;
  if (e instanceof Error) {
    const ctor = e.constructor?.name;
    kind = ctor && ctor !== 'Error' ? ctor : e.name || 'Error';
  }
  const err = e as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = str(err?.cause?.code) ?? str(err?.code);
  return code
    ? { where, ref, kind: str(kind) ?? 'Error', code }
    : { where, ref, kind: str(kind) ?? 'Error' };
}

export function logFailure(where: string, e: unknown, ref = newErrorRef()): string {
  console.error('failed', describeFailure(where, ref, e));
  return ref;
}

/** A database error: Drizzle's query error, or anything carrying a Postgres
 *  SQLSTATE code, on itself or its cause. Its message may quote parameters. */
export function isDatabaseError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.constructor?.name === 'DrizzleQueryError' || e.message.startsWith('Failed query'))
    return true;
  const sqlstate = (v: unknown) => typeof v === 'string' && /^[0-9A-Z]{5}$/.test(v);
  const err = e as { code?: unknown; cause?: { code?: unknown } };
  return sqlstate(err.code) || sqlstate(err.cause?.code);
}
