// v0.10.1 (Part 10 review finding 1): page renders and route handlers that
// fail outside a guarded action. Next calls onRequestError with the error; we
// log one scrubbed line (lib/failure.ts: where, class, database code, a
// reference), never the message, which for a failed query quotes its
// parameters (a client's name or phone).
//
// Next also prints uncaught errors itself. In production, register() puts a
// filter in front of console.error that swaps a database error for the same
// scrubbed line, so that print quotes nothing either. Other errors pass
// through unchanged.
import type { Instrumentation } from 'next';
import { describeFailure, isDatabaseError, logFailure, newErrorRef } from './lib/failure';

export function register(): void {
  if (process.env['NODE_ENV'] !== 'production') return;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(
      ...args.map((a) => (isDatabaseError(a) ? describeFailure('uncaught', newErrorRef(), a) : a)),
    );
  };
}

export const onRequestError: Instrumentation.onRequestError = (err, _request, context) => {
  // The route pattern (e.g. /admin/staff/[technicianId]), not the URL, which
  // can carry an id or a search.
  logFailure(`${context.routeType}:${context.routePath}`, err);
};
