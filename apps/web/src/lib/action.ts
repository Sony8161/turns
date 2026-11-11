import 'server-only';
// Part 10: a server action that fails for a reason nobody planned (the
// database is down, a constraint the code did not expect) answers with a
// plain "try again" state instead of the error page, and the log line has the
// action's name and the error's class only: no message, which may quote a
// client's name or phone, and no stack sent to a browser. Next's redirect and
// not-found signals pass through untouched.
import { unstable_rethrow } from 'next/navigation';

export async function guarded<S>(name: string, fail: S, run: () => Promise<S>): Promise<S> {
  try {
    return await run();
  } catch (e) {
    unstable_rethrow(e);
    const kind = e instanceof Error ? e.name : typeof e;
    const code = (e as { code?: unknown } | null)?.code;
    console.error('action failed', {
      action: name,
      kind,
      code: typeof code === 'string' ? code : undefined,
    });
    return fail;
  }
}
