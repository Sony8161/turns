import type { AuditLabels } from '@turn/db/reports';
import type { Dictionary } from '@/i18n/dictionary';

/** The words the viewer and the CSV share, in the reader's language. */
export function auditLabels(t: Dictionary): AuditLabels {
  return {
    actions: t.log.actions,
    roles: t.roles,
    system: t.log.system,
    headers: t.log.headers,
  };
}
