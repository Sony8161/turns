// The words for one ledger line on a tech card (v0.12.0). Pure, for the test.
import type { TechCard } from '@turn/db/board';
import { formatPoints } from '@/components/Board';
import { fill, type Dictionary } from '@/i18n/dictionary';

/** Signed points for one ledger line: +1, +½, −1. */
export function signedPoints(delta: number): string {
  return delta < 0 ? `−${formatPoints(-delta)}` : `+${formatPoints(delta)}`;
}

/** One ledger line in words. Exported for the test. */
export function lineText(
  line: TechCard['lines'][number],
  t: Dictionary['techBoard'],
  reasons: Record<string, string>,
): string {
  const minutes = line.note?.match(/\d+/)?.[0] ?? '';
  const services = line.services.join(' + ');
  switch (line.kind) {
    case 'visit':
      return fill(
        line.source === 'appointment'
          ? t.line.appointment
          : line.source === 'request'
            ? t.line.request
            : t.line.visit,
        { services },
      );
    case 'deny':
      return fill(t.line.deny, { reason: reasons[line.note ?? 'other'] ?? line.note ?? '' });
    case 'excuse':
      return t.line.excuse;
    case 'late':
      return fill(t.line.late, { minutes });
    case 'out_over':
      return fill(t.line.out_over, { minutes });
    default:
      return t.line.manual;
  }
}
