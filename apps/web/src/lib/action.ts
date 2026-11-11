import 'server-only';
// Part 10: a server action that fails for a reason nobody planned (the
// database is down, a constraint the code did not expect) answers with a
// plain "try again" state instead of the error page. The log line is scrubbed
// (lib/failure.ts): where, the error's class, the database code and a short
// reference; no message, which may quote a client's name or phone, and no
// stack. The same reference comes back in the state so the screen can show it
// (v0.10.1). Next's redirect and not-found signals pass through untouched.
import { unstable_rethrow } from 'next/navigation';
import { logFailure } from './failure';

export async function guarded<S extends object>(
  name: string,
  fail: S,
  run: () => Promise<S>,
): Promise<S & { ref?: string }> {
  try {
    return await run();
  } catch (e) {
    unstable_rethrow(e);
    const ref = logFailure(`action:${name}`, e);
    return { ...fail, ref };
  }
}

/** The same guard for an action that answers with a redirect, not a state.
 *  A failure still reaches the error page (there is no state to put it in),
 *  but as a plain error naming only the reference, so Next's own log line
 *  quotes nothing from the query. */
export async function guardedVoid(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    unstable_rethrow(e);
    const ref = logFailure(`action:${name}`, e);
    throw new Error(`Action failed (reference ${ref})`);
  }
}
