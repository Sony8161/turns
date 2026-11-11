'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui';
import type { Dictionary } from '@/i18n/dictionary';
import { saveProfileAction, type ProfileState } from './actions';

type Category = { id: string; name: string };
type Restriction = { type: string; value: number | null; note: string | null };

/** Skills per category, tags, and the five restrictions, for one technician. */
export function ProfileForm({
  technicianId,
  categories,
  skillCategoryIds,
  tags,
  restrictions,
  t,
}: {
  technicianId: string;
  categories: Category[];
  /** Empty = does every category. */
  skillCategoryIds: string[];
  tags: string[];
  restrictions: Restriction[];
  t: Dictionary['profile'];
}) {
  const [state, action, pending] = useActionState<ProfileState, FormData>(saveProfileAction, {});
  const [mode, setMode] = useState<'all' | 'some'>(skillCategoryIds.length ? 'some' : 'all');
  const has = (type: string) => restrictions.some((r) => r.type === type);
  const value = (type: string) => restrictions.find((r) => r.type === type);
  const [minAgeOn, setMinAgeOn] = useState(has('min_client_age'));
  const [customOn, setCustomOn] = useState(has('custom'));
  const field = 'min-h-11 rounded-control border-2 border-slate/30 bg-board px-3 text-lead';

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="technicianId" value={technicianId} />
      {state.error ? <p className="text-polish">{t.errors[state.error] ?? state.error}</p> : null}
      {state.saved ? <p className="font-semibold text-teal">{t.saved}</p> : null}

      <section className="flex flex-col gap-3 bg-board p-5">
        <h2 className="text-heading font-semibold">{t.skills}</h2>
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="radio"
            name="skillsMode"
            value="all"
            checked={mode === 'all'}
            onChange={() => setMode('all')}
            className="h-5 w-5"
          />
          <span>{t.everything}</span>
        </label>
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="radio"
            name="skillsMode"
            value="some"
            checked={mode === 'some'}
            onChange={() => setMode('some')}
            className="h-5 w-5"
          />
          <span>{t.onlyThese}</span>
        </label>
        <div className={`flex flex-col gap-2 pl-8 ${mode === 'all' ? 'opacity-50' : ''}`}>
          {categories.map((c) => (
            <label key={c.id} className="flex min-h-11 items-center gap-3 text-lead">
              <input
                type="checkbox"
                name="skill"
                value={c.id}
                defaultChecked={skillCategoryIds.includes(c.id)}
                disabled={mode === 'all'}
                className="h-6 w-6"
              />
              <span>{c.name}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3 bg-board p-5">
        <h2 className="text-heading font-semibold">{t.restrictions}</h2>
        {(['no_male_clients', 'no_kids', 'no_same_time'] as const).map((type) => (
          <label key={type} className="flex min-h-11 items-center gap-3 text-lead">
            <input
              type="checkbox"
              name={`r.${type}`}
              defaultChecked={has(type)}
              className="h-6 w-6"
            />
            <span>{t.restriction[type]}</span>
          </label>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-h-11 items-center gap-3 text-lead">
            <input
              type="checkbox"
              name="r.min_client_age"
              checked={minAgeOn}
              onChange={(e) => setMinAgeOn(e.target.checked)}
              className="h-6 w-6"
            />
            <span>{t.restriction.min_client_age}</span>
          </label>
          <input
            name="minAge"
            inputMode="numeric"
            maxLength={3}
            defaultValue={value('min_client_age')?.value ?? ''}
            disabled={!minAgeOn}
            aria-label={t.restriction.min_client_age}
            className={`${field} w-24`}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="flex min-h-11 items-center gap-3 text-lead">
            <input
              type="checkbox"
              name="r.custom"
              checked={customOn}
              onChange={(e) => setCustomOn(e.target.checked)}
              className="h-6 w-6"
            />
            <span>{t.restriction.custom}</span>
          </label>
          <textarea
            name="customNote"
            rows={2}
            maxLength={300}
            defaultValue={value('custom')?.note ?? ''}
            disabled={!customOn}
            aria-label={t.restriction.custom}
            className="rounded-control border-2 border-slate/30 bg-board px-3 py-2 text-lead"
          />
        </div>
      </section>

      <section className="flex flex-col gap-3 bg-board p-5">
        <label className="flex flex-col gap-2">
          <span className="text-heading font-semibold">{t.tags}</span>
          <input
            name="tags"
            defaultValue={tags.join(', ')}
            placeholder={t.tagsPlaceholder}
            maxLength={500}
            className={field}
          />
        </label>
      </section>

      <Button type="submit" disabled={pending} className="self-start">
        {t.save}
      </Button>
    </form>
  );
}
