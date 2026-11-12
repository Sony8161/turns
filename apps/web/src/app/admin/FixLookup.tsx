'use client';

// v0.16.0: inside the walk-in form when "Nail fix / repair" is ticked. The desk
// types a phone or a name and sees the client's visits inside the fix window
// (date, services, technician); picking one links the fix to it, so the
// technician who did the work is offered first. Nothing found is a warning,
// not a stop: a manager can still approve the fix.
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { lookupFixVisits, type FixLookup as Found } from './actions';

export function FixLookup({
  t,
  windowDays,
  needsApproval,
}: {
  t: Dictionary['desk'];
  windowDays: number;
  /** The person at the desk is a receptionist and the rules want approval. */
  needsApproval: boolean;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const field = 'min-h-12 rounded-control border-2 border-slate/30 bg-board px-3 text-lead';

  const look = () =>
    start(async () => {
      const r = await lookupFixVisits(query);
      if ('error' in r) {
        setError(t.errors[r.error] ?? r.error);
        setFound(null);
      } else {
        setError(null);
        setFound(r);
      }
    });

  return (
    <fieldset className="flex flex-col gap-3 border-l-[12px] border-navy bg-pumice/40 p-4">
      <legend className="sr-only">{t.fixLookupTitle}</legend>
      {/* The legend is for screen readers; this is the same title on screen. */}
      <span aria-hidden className="font-semibold">
        {t.fixLookupTitle}
      </span>
      <span className="text-small text-slate/80">
        {fill(t.fixLookupLead, { days: found?.windowDays ?? windowDays })}
      </span>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-small font-medium">{t.fixLookupLabel}</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                look();
              }
            }}
            maxLength={60}
            className={`${field} w-56`}
          />
        </label>
        <Button
          type="button"
          tone="quiet"
          disabled={pending || query.trim().length < 2}
          onClick={look}
        >
          {t.fixLookupButton}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-polish">
          {error}
        </p>
      ) : null}
      {found ? (
        found.visits.length === 0 ? (
          <p role="status" className="font-semibold text-polish">
            {fill(t.fixLookupNone, { days: found.windowDays })}
          </p>
        ) : (
          <div role="radiogroup" aria-label={t.fixLookupTitle} className="flex flex-col gap-2">
            {found.visits.map((v, i) => (
              <label key={v.visitId} className="flex min-h-11 items-center gap-3">
                <input
                  type="radio"
                  name="fixOfVisit"
                  value={v.visitId}
                  defaultChecked={i === 0}
                  className="h-5 w-5"
                />
                <span>
                  {v.client ? <span className="font-semibold">{v.client}: </span> : null}
                  {fill(t.fixVisitLine, {
                    date: v.date,
                    services: v.services.join(' + '),
                    tech: v.technician ?? t.fixNoTech,
                  })}
                </span>
              </label>
            ))}
            <label className="flex min-h-11 items-center gap-3">
              <input type="radio" name="fixOfVisit" value="" className="h-5 w-5" />
              <span>{t.fixNotThis}</span>
            </label>
          </div>
        )
      ) : null}
      {needsApproval ? <p className="text-small text-slate/80">{t.fixApprovalNote}</p> : null}
    </fieldset>
  );
}
