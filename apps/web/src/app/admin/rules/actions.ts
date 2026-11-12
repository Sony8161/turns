'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { serviceCategories, services } from '@turn/db';
import { compareQueue } from '@turn/db/engine';
import {
  activeRules,
  previewBoard,
  RULE_TEMPLATES,
  saveRuleConfig,
  templateConfig,
  validateRuleConfig,
  type RuleConfig,
  type RuleError,
  type RuleTemplate,
} from '@turn/db/rules';
import { revalidatePath } from 'next/cache';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { configFromForm, fieldFor, formValues } from './form';
import { guarded } from '@/lib/action';

export type RulesState = {
  /** Reference shown for an unplanned failure (v0.10.1). */
  ref?: string;
  error?: 'not_allowed' | 'invalid' | 'stale' | 'server';
  /** For 'stale': the version somebody else saved meanwhile. */
  latestVersion?: number;
  /** form field -> problem code, for the form to show under each field. */
  errors?: Record<string, RuleError['problem']>;
  /** What was typed, so an error does not wipe the form. */
  typed?: Record<string, string>;
  /** Today's line now and under the typed rules, side by side (v0.13.0). */
  preview?: { before: PreviewLine[]; after: PreviewLine[] };
  /** The template the form was just filled from. */
  template?: RuleTemplate;
  saved?: number;
};

export type PreviewLine = {
  name: string;
  points: number;
  hadAppointmentLast: boolean;
  status: string;
};

async function previewOf(locationId: string, base: RuleConfig, candidate: RuleConfig) {
  const rows = await previewBoard(db(), locationId, candidate);
  const line = (key: 'points' | 'previewPoints', rules: RuleConfig): PreviewLine[] =>
    [...rows]
      .sort((a, b) =>
        compareQueue(
          rules,
          { points: a[key], hadAppointmentLast: a.hadAppointmentLast, checkedInAt: a.checkedInAt },
          { points: b[key], hadAppointmentLast: b.hadAppointmentLast, checkedInAt: b.checkedInAt },
        ),
      )
      .map((r) => ({
        name: r.displayName,
        points: r[key],
        hadAppointmentLast: r.hadAppointmentLast,
        status: r.status,
      }));
  return { before: line('points', base), after: line('previewPoints', candidate) };
}

function byField(errors: RuleError[], tierSlots: number[]): Record<string, RuleError['problem']> {
  const out: Record<string, RuleError['problem']> = {};
  for (const e of errors) {
    const field = fieldFor(e.path, tierSlots);
    if (!(field in out)) out[field] = e.problem;
  }
  return out;
}

function typedOf(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries())
    if (typeof v === 'string' && k !== 'intent' && k !== 'template') out[k] = v;
  return out;
}

/** Preview re-sorts today's board under the typed rules; Save makes a new
 *  version. Owner only (design doc; Duong: rules edit is owner-only). */
export async function rulesAction(_prev: RulesState, formData: FormData): Promise<RulesState> {
  return guarded('rulesAction', { error: 'server' } as RulesState, () =>
    rulesActionRun(_prev, formData),
  );
}

async function rulesActionRun(_prev: RulesState, formData: FormData): Promise<RulesState> {
  const actor = await requireActor();
  const m = membershipWith(actor, 'manage_rules');
  if (!m) return { error: 'not_allowed' };
  const typed = typedOf(formData);

  const [base, categories, menu] = await Promise.all([
    activeRules(db(), m.locationId),
    db()
      .select({ id: serviceCategories.id })
      .from(serviceCategories)
      .where(eq(serviceCategories.locationId, m.locationId)),
    // v0.16.0: the services the form shows (not archived), for points per service.
    db()
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.locationId, m.locationId), isNull(services.archivedAt))),
  ]);
  const { candidate, tierSlots } = configFromForm(
    formData,
    base,
    categories.map((c) => c.id),
    menu.map((s) => s.id),
  );

  // A template fills the form and shows its preview; nothing is saved.
  // The template buttons submit `template=<id>` (and no intent).
  if (formData.get('template') !== null) {
    const id = String(formData.get('template')) as RuleTemplate;
    if (!RULE_TEMPLATES.includes(id)) return { error: 'invalid', typed };
    const config = templateConfig(id, base);
    return {
      typed: { ...formValues(config), note: typed.note ?? '' },
      template: id,
      preview: await previewOf(m.locationId, base, config),
    };
  }

  if (formData.get('intent') === 'preview') {
    const checked = validateRuleConfig(candidate);
    if (!checked.ok) return { error: 'invalid', errors: byField(checked.errors, tierSlots), typed };
    return { typed, preview: await previewOf(m.locationId, base, checked.config) };
  }

  // The version the form was loaded from: a save on top of someone else's
  // newer version is refused instead of quietly reverting it.
  const basedOn = Number(formData.get('basedOn'));
  const result = await saveRuleConfig(db(), {
    organizationId: m.organizationId,
    locationId: m.locationId,
    config: candidate,
    actor: { userId: actor.userId },
    note: String(formData.get('note') ?? ''),
    expectedVersion: Number.isInteger(basedOn) ? basedOn : undefined,
  });
  if (!result.ok) {
    if (result.reason === 'stale') {
      return { error: 'stale', latestVersion: result.latestVersion, typed };
    }
    return { error: 'invalid', errors: byField(result.errors, tierSlots), typed };
  }
  revalidatePath('/admin/rules');
  revalidatePath('/admin');
  revalidatePath('/me');
  return { saved: result.version };
}
