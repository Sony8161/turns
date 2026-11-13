// The desk row's line for a called visit (v0.17.1). Pure, so a test pins it.
import { formatClock } from '@/components/Board';
import { fill, type Dictionary } from '@/i18n/dictionary';

/** v0.17.1: "Linh called just now" for the first minute, not "no answer for 0:00". */
export function calledText(
  t: Pick<
    Dictionary['desk'],
    'offeredLine' | 'pickedLine' | 'calledLine' | 'calledJustNow' | 'justNow'
  >,
  kind: string | null | undefined,
  name: string,
  seconds: number,
): string {
  const fresh = seconds < 60;
  const time = fresh ? t.justNow : formatClock(seconds);
  if (kind === 'offer') return fill(t.offeredLine, { name, time });
  if (kind === 'desk_pick') return fill(t.pickedLine, { name, time });
  return fill(fresh ? t.calledJustNow : t.calledLine, { name, time });
}
