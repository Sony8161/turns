// The skills-and-restrictions form to the profile input. Pure: no database.
// Values that are not what the field asks for are kept as typed so the
// validator (packages/db profile.ts) names the problem.
import type { ProfileInput, Restriction } from '@turn/db/profile';

export function profileFromForm(fd: FormData): ProfileInput {
  const everything = String(fd.get('skillsMode') ?? 'all') !== 'some';
  const skills = fd.getAll('skill').map(String).filter(Boolean);
  const tags = String(fd.get('tags') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const restrictions: Restriction[] = [];
  const on = (name: string) => fd.get(name) === 'on' || fd.get(name) === 'true';
  if (on('r.no_male_clients')) {
    restrictions.push({ type: 'no_male_clients', value: null, note: null });
  }
  if (on('r.no_kids')) restrictions.push({ type: 'no_kids', value: null, note: null });
  if (on('r.no_same_time')) restrictions.push({ type: 'no_same_time', value: null, note: null });
  if (on('r.min_client_age')) {
    const raw = String(fd.get('minAge') ?? '').trim();
    restrictions.push({
      type: 'min_client_age',
      value: /^\d{1,3}$/.test(raw) ? Number(raw) : Number.NaN,
      note: null,
    });
  }
  if (on('r.custom')) {
    restrictions.push({ type: 'custom', value: null, note: String(fd.get('customNote') ?? '') });
  }
  return { skillCategoryIds: everything ? null : skills, tags, restrictions };
}
