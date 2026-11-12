import type { VisitLabel } from '@turn/db/clients';
import type { ReadablePart, ReadableValue } from '@turn/db/reports';
import { formatPoints } from '@/components/Board';
import { fill, type Dictionary } from '@/i18n/dictionary';

// v0.16.1: the log's Details column in words (Duong, 2026-11-12: "a salon
// owner can't read visit=uuid"). Pure: the page resolves visits first. The
// CSV keeps the raw fields; this is for the screen only.

export type ReadableContext = {
  t: Dictionary;
  timezone: string;
  lang: 'en' | 'vi';
  visits: Map<string, VisitLabel>;
};

const MAX_LIST = 4;

/** camelCase or snake_case → "Camel case". */
function humanize(key: string): string {
  const words = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function list(items: string[], more: string): string {
  if (items.length <= MAX_LIST) return items.join(', ');
  return `${items.slice(0, MAX_LIST).join(', ')} ${fill(more, { n: items.length - MAX_LIST })}`;
}

function code(group: string, value: string, ctx: ReadableContext): string {
  const { t } = ctx;
  const known =
    group === 'status'
      ? (t.board.status as Record<string, string>)[value]
      : group === 'level'
        ? t.levels.name[value]
        : group === 'deny'
          ? (t.me.call.reasons as Record<string, string>)[value]
          : group === 'role'
            ? (t.roles as Record<string, string>)[value]
            : t.log.detail.codes[group]?.[value];
  return known ?? value.replace(/_/g, ' ');
}

/** One value as the owner reads it. Pure. */
export function formatValue(v: ReadableValue, ctx: ReadableContext): string {
  const d = ctx.t.log.detail;
  switch (v.kind) {
    case 'text':
      return v.text;
    case 'visit': {
      const label = ctx.visits.get(v.id);
      if (!label) return d.aVisit;
      const who = label.client ?? d.walkIn;
      return label.services.length ? `${who} · ${list(label.services, d.more)}` : who;
    }
    case 'services':
      return list(v.names, d.more);
    case 'list':
      return v.items.length ? list(v.items, d.more) : '—';
    case 'points': {
      if (v.n === 0) return '0';
      if (v.n < 0) return `−${formatPoints(Math.abs(v.n))}`;
      return v.signed ? `+${formatPoints(v.n)}` : formatPoints(v.n);
    }
    case 'bool':
      return v.value ? d.yes : d.no;
    case 'seconds':
      return fill(d.seconds, { n: v.n });
    case 'minutes':
      return fill(d.minutes, { n: v.n });
    case 'meters':
      return fill(d.meters, { n: v.n });
    case 'number':
      return String(v.n);
    case 'time':
      return new Intl.DateTimeFormat(ctx.lang === 'vi' ? 'vi-VN' : 'en-US', {
        timeZone: ctx.timezone,
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(v.at));
    case 'code':
      return code(v.group, v.code, ctx);
  }
}

/** Each detail as "Label: value", or "Label: before → after" when it changed. Pure. */
export function formatReadable(parts: ReadablePart[], ctx: ReadableContext): string[] {
  return parts.map((p) => {
    const label = ctx.t.log.detail.keys[p.key] ?? humanize(p.key);
    const now = formatValue(p.value, ctx);
    return p.was ? `${label}: ${formatValue(p.was, ctx)} → ${now}` : `${label}: ${now}`;
  });
}

/** Every visit id the details mention, for one lookup. Pure. */
export function visitIdsOf(rows: { readable: ReadablePart[] }[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    for (const p of r.readable) {
      if (p.value.kind === 'visit') ids.add(p.value.id);
      if (p.was?.kind === 'visit') ids.add(p.was.id);
    }
  }
  return [...ids];
}
