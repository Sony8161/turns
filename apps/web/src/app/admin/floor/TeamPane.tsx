'use client';

// v0.18.0 (B2, B3, B4, B5): the techs once, in turn order, as compact rows.
// Place, name, a status chip (icon and words), her points small, and a
// labelled time. A row a plain call cannot go to now is dimmed and says why.
// Tap a row for her drawer.
import { fill } from '@/i18n/dictionary';
import type { TeamMember } from './types';
import { StatusChip, statusBar, useWords } from './ui';

export function TeamPane({ team, onOpen }: { team: TeamMember[]; onOpen: (id: string) => void }) {
  const w = useWords();
  const f = w.floor;
  return (
    <section aria-labelledby="team-h" className="flex min-h-0 flex-col bg-board">
      <h2 id="team-h" className="px-4 pt-3 pb-2 text-lead font-semibold">
        {f.team}
      </h2>
      {team.length === 0 ? (
        <p className="px-4 pb-4 text-slate/70">{f.nobodyCheckedIn}</p>
      ) : (
        <ol className="min-h-0 flex-1 overflow-y-auto">
          {team.map((m) => (
            <li key={m.id} className="board-row border-t border-pumice">
              <button
                type="button"
                onClick={() => onOpen(m.id)}
                aria-label={[
                  fill(f.place, { n: m.place }),
                  m.name,
                  f.status[m.status],
                  m.time,
                  m.pointsWords,
                  m.isNext ? fill(f.next, { name: m.name }) : null,
                  m.reason,
                ]
                  .filter(Boolean)
                  .join(', ')}
                className={`flex min-h-16 w-full items-stretch gap-3 pr-3 text-left hover:bg-pumice/50 ${m.isNext ? 'bg-teal/10' : ''}`}
              >
                <span aria-hidden className={`w-2 shrink-0 ${statusBar(m.status)}`} />
                <span
                  aria-hidden
                  className="flex w-7 shrink-0 items-center justify-end text-lead font-semibold text-slate/60 tabular-nums"
                >
                  {m.place}
                </span>
                <span
                  className={`flex min-w-0 flex-1 flex-col justify-center py-2 ${m.callable ? '' : 'opacity-60'}`}
                >
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-lead font-semibold">{m.name}</span>
                    <StatusChip s={m.status} />
                  </span>
                  <span
                    className={`text-small font-medium ${m.alert ? 'font-semibold text-polish' : 'text-slate/80'}`}
                  >
                    {m.time}
                    {m.reason ? ` · ${m.reason}` : ''}
                  </span>
                </span>
                <span
                  aria-hidden
                  className="flex w-12 shrink-0 flex-col items-end justify-center leading-none"
                >
                  <span className="text-lead font-semibold tabular-nums">{m.points}</span>
                  <span className="text-[11px] text-slate/60">{f.pointsShort}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
