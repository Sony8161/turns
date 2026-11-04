'use server';

import { eq } from 'drizzle-orm';
import { serviceCategories } from '@turn/db';
import {
  activeRules,
  previewBoard,
  saveRuleConfig,
  validateRuleConfig,
  type RuleError,
} from '@turn/db/rules';
import { revalidatePath } from 'next/cache';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { configFromForm, fieldFor } from './form';

export type RulesState = {
  error?: 'not_allowed' | 'invalid' | 'stale';
  /** For 'stale': the version somebody else saved meanwhile. */
  latestVersion?: number;
  /** form field -> problem code, for the form to show under each field. */
  errors?: Record<string, RuleError['problem']>;
  /** What was typed, so an error does not wipe the form. */
  typed?: Record<string, string>;
  preview?: { name: string; points: number; previewPoints: number }[];
  saved?: number;
};

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
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && k !== 'intent') out[k] = v;
  return out;
}

/** Preview re-sorts today's board under the typed rules; Save makes a new
 *  version. Owner only (design doc; Duong: rules edit is owner-only). */
export async function rulesAction(_prev: RulesState, formData: FormData): Promise<RulesState> {
  const actor = await requireActor();
  const m = membershipWith(actor, 'manage_rules');
  if (!m) return { error: 'not_allowed' };
  const typed = typedOf(formData);

  const [base, categories] = await Promise.all([
    activeRules(db(), m.locationId),
    db()
      .select({ id: serviceCategories.id })
      .from(serviceCategories)
      .where(eq(serviceCategories.locationId, m.locationId)),
  ]);
  const { candidate, tierSlots } = configFromForm(
    formData,
    base,
    categories.map((c) => c.id),
  );

  if (formData.get('intent') === 'preview') {
    const checked = validateRuleConfig(candidate);
    if (!checked.ok) return { error: 'invalid', errors: byField(checked.errors, tierSlots), typed };
    const rows = await previewBoard(db(), m.locationId, checked.config);
    return {
      typed,
      preview: rows.map((r) => ({
        name: r.displayName,
        points: r.points,
        previewPoints: r.previewPoints,
      })),
    };
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
