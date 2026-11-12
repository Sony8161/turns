'use client';

import { ErrorRef } from '@/components/ErrorRef';
import { useActionState, type ReactNode } from 'react';
import { formatPoints } from '@/components/Board';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { rulesAction, type RulesState } from './actions';
import { TIER_SLOTS } from './form';

type Category = { id: string; name: string; isFillOrFullSet: boolean };

/** The rule builder: one field per value, Preview and Save. Values are
 *  strings in and out; the server validates and names each problem. */
export function RulesForm({
  values,
  categories,
  version,
  t,
}: {
  values: Record<string, string>;
  categories: Category[];
  /** The newest stored version; the save is refused if it moves meanwhile. */
  version: number;
  t: Dictionary['rules'];
}) {
  const [state, action, pending] = useActionState<RulesState, FormData>(rulesAction, {});
  const v = state.typed ?? values;
  const err = (path: string) => {
    const p = state.errors?.[path];
    return p ? t.problems[p] : undefined;
  };
  const storedTiers = Object.keys(values).filter((k) => /^tier\.\d+\.after$/.test(k)).length;
  const tierSlots = Math.max(TIER_SLOTS, storedTiers + 1);

  const number = (name: string, label: string, hint?: string) => (
    <label key={name} className="flex flex-col gap-1">
      <span className="font-medium">{label}</span>
      {hint ? <span className="text-small text-slate/70">{hint}</span> : null}
      <input
        name={name}
        defaultValue={v[name] ?? ''}
        inputMode="decimal"
        aria-invalid={err(name) ? true : undefined}
        className={`min-h-12 w-40 rounded-control border-2 bg-board px-3 text-lead ${err(name) ? 'border-polish' : 'border-slate/30'}`}
      />
      {err(name) ? <span className="text-polish">{err(name)}</span> : null}
    </label>
  );

  const toggle = (name: string, label: string) => (
    <label key={name} className="flex min-h-11 items-center gap-3">
      <input type="checkbox" name={name} defaultChecked={v[name] === 'on'} className="h-6 w-6" />
      <span>{label}</span>
    </label>
  );

  // React resets the form after each action and re-applies defaults for text
  // and checkbox inputs, but not for a select; keying the select on its value
  // remounts it so the typed choice survives Preview and an error.
  const select = (name: string, label: string, options: { value: string; label: string }[]) => (
    <label key={name} className="flex flex-col gap-1">
      <span className="font-medium">{label}</span>
      <select
        key={`${name}:${v[name] ?? ''}`}
        name={name}
        defaultValue={v[name] ?? options[0]?.value}
        className="min-h-12 w-72 rounded-control border-2 border-slate/30 bg-board px-3 text-lead"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {err(name) ? <span className="text-polish">{err(name)}</span> : null}
    </label>
  );

  const section = (title: string, children: ReactNode) => (
    <section className="flex flex-col gap-4 bg-board p-5">
      <h2 className="text-heading font-semibold">{title}</h2>
      {children}
    </section>
  );

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="basedOn" value={version} />
      {state.saved ? (
        <p className="bg-board p-4 font-semibold text-teal">
          {fill(t.saved, { version: state.saved })}
        </p>
      ) : null}
      {state.error === 'invalid' ? <p className="text-polish">{t.fixErrors}</p> : null}
      {state.error === 'stale' ? (
        <p className="text-polish">{fill(t.stale, { version: state.latestVersion ?? '?' })}</p>
      ) : null}
      {state.error === 'not_allowed' ? <p className="text-polish">{t.notAllowed}</p> : null}
      {state.error === 'server' ? (
        <p role="alert" className="text-polish">
          {t.server}
          <ErrorRef refId={state.ref} />
        </p>
      ) : null}

      <section className="flex flex-col gap-3 bg-board p-5">
        <h2 className="text-heading font-semibold">{t.templatesTitle}</h2>
        <p className="max-w-[70ch] text-slate/80">{t.templatesLead}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(['standard', 'simple_rotation'] as const).map((id) => (
            <div key={id} className="flex flex-col gap-2 border-2 border-pumice p-4">
              <span className="font-semibold">{t.templates[id].name}</span>
              <span className="text-slate/80">{t.templates[id].description}</span>
              <Button type="submit" name="template" value={id} tone="quiet" disabled={pending}>
                {t.useTemplate}
              </Button>
            </div>
          ))}
        </div>
      </section>

      {section(
        t.sections.points,
        <div className="flex flex-wrap gap-5">
          {number('points.default_service', t.fields.default_service)}
          {number('points.fill_or_full_set', t.fields.fill_or_full_set)}
          {number('points.appointment_discount', t.fields.appointment_discount)}
          {number('points.combined_fill_full_cap', t.fields.combined_fill_full_cap)}
        </div>,
      )}

      {section(
        t.sections.categories,
        <div className="flex flex-col gap-3">
          <p className="text-slate/80">{t.categoriesLead}</p>
          <div className="flex flex-wrap gap-5">
            {categories.map((c) =>
              number(
                `category.${c.id}`,
                c.name,
                c.isFillOrFullSet ? t.fields.category_fill : t.fields.category_default,
              ),
            )}
          </div>
          {err('points.by_category') ? (
            <span className="text-polish">{err('points.by_category')}</span>
          ) : null}
        </div>,
      )}

      {section(
        t.sections.penalties,
        <div className="flex flex-wrap gap-5">
          {number('penalties.deny', t.fields.deny)}
          {number('penalties.out_over_minutes', t.fields.out_over_minutes)}
          {number('penalties.out_over_penalty', t.fields.out_over_penalty)}
        </div>,
      )}

      {section(
        t.sections.late,
        <div className="flex flex-col gap-3">
          <p className="text-slate/80">{t.lateLead}</p>
          {Array.from({ length: tierSlots }, (_, i) => (
            <div key={i} className="flex flex-wrap items-end gap-4">
              {number(`tier.${i}.after`, t.fields.tier_after)}
              {number(`tier.${i}.start`, t.fields.tier_start)}
            </div>
          ))}
          {err('penalties.late_tiers') ? (
            <span className="text-polish">{err('penalties.late_tiers')}</span>
          ) : null}
        </div>,
      )}

      {section(t.sections.queue, toggle('queue.auto_pass', t.fields.auto_pass))}

      {section(
        t.sections.eligibility,
        <div className="flex flex-col gap-3">
          {toggle('eligibility.require_on_site', t.fields.require_on_site)}
          {toggle('eligibility.require_ready_checklist', t.fields.require_ready_checklist)}
          {toggle('eligibility.honor_restrictions', t.fields.honor_restrictions)}
          {number(
            'eligibility.upcoming_appointment_buffer_min',
            t.fields.upcoming_appointment_buffer_min,
          )}
          {select(
            'eligibility.skill_match',
            t.fields.skill_match,
            (['required', 'preferred', 'off'] as const).map((k) => ({
              value: k,
              label: t.fields.skill[k],
            })),
          )}
        </div>,
      )}

      {section(
        t.sections.requests,
        <div className="flex flex-col gap-3">
          {toggle('requests.requested_tech_bypasses_queue', t.fields.requested_tech_bypasses_queue)}
          {select(
            'requests.requested_counts_points',
            t.fields.requested_counts_points,
            (['unset', 'full', 'half', 'none'] as const).map((k) => ({
              value: k,
              label: t.fields.counts[k],
            })),
          )}
        </div>,
      )}

      {section(
        t.sections.attention,
        <div className="flex flex-wrap gap-5">
          {number('attention.unanswered_call_min', t.fields.unanswered_call_min)}
          {number('attention.long_wait_min', t.fields.long_wait_min)}
          {number('attention.default_service_min', t.fields.default_service_min)}
        </div>,
      )}

      {state.preview ? (
        <section aria-live="polite" className="flex flex-col gap-3 bg-board p-5">
          <h2 className="text-heading font-semibold">{t.previewTitle}</h2>
          {state.template ? (
            <p className="font-semibold text-teal">
              {fill(t.templateLoaded, { name: t.templates[state.template].name })}
            </p>
          ) : null}
          {state.preview.before.length === 0 ? (
            <p className="text-slate/70">{t.previewEmpty}</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {(['before', 'after'] as const).map((side) => (
                <div key={side} className="flex flex-col gap-2">
                  <h3 className="font-semibold">
                    {side === 'before' ? t.previewNow : t.previewThen}
                  </h3>
                  <ol className="flex flex-col gap-1">
                    {state.preview![side].map((r, i) => {
                      const moved =
                        side === 'after' &&
                        state.preview!.before.findIndex((b) => b.name === r.name) !== i;
                      return (
                        <li
                          key={`${side}-${r.name}`}
                          className={`flex min-h-11 items-center justify-between gap-3 border-b border-pumice text-lead ${moved ? 'font-semibold text-navy' : ''}`}
                        >
                          <span>
                            {i + 1}. {r.name}
                          </span>
                          <span className="tabular-nums">
                            {formatPoints(r.points, r.hadAppointmentLast)}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              ))}
            </div>
          )}
          <p className="text-small text-slate/70">{t.previewNote}</p>
        </section>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="font-medium">{t.fields.note}</span>
        <input
          name="note"
          maxLength={300}
          defaultValue={v['note'] ?? ''}
          className="min-h-12 rounded-control border-2 border-slate/30 bg-board px-3 text-lead"
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" name="intent" value="preview" tone="quiet" disabled={pending}>
          {t.preview}
        </Button>
        <Button type="submit" name="intent" value="save" disabled={pending}>
          {fill(t.save, { version: version + 1 })}
        </Button>
      </div>
    </form>
  );
}
