// CSV download of the audit log (Part 8). Owner only (permissions table:
// export_data). The rows are the viewer's rows, built by the same function, so
// the file matches the screen row for row. Cells a spreadsheet would run as a
// formula are made text (reports.csvCell).
import { auditEntries, auditTable, toCsv } from '@turn/db/reports';
import { locations } from '@turn/db';
import { eq } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import { getDictionary } from '@/i18n/lang';
import { getActor, membershipWith } from '@/lib/auth';
import { db } from '@/lib/db';
import { parseLogFilters } from '../filters';
import { auditLabels } from '../labels';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const m = membershipWith(actor, 'export_data');
  if (!m) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const [loc] = await db()
    .select({ timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, m.locationId));
  const tz = loc?.timezone ?? 'UTC';
  const filters = parseLogFilters(Object.fromEntries(request.nextUrl.searchParams), tz);
  const rows = await auditEntries(db(), { locationId: m.locationId, ...filters });
  const { t } = await getDictionary();
  const table = auditTable(rows, tz, auditLabels(t));
  const name = `audit-${filters.from}${filters.to !== filters.from ? `-to-${filters.to}` : ''}.csv`;
  return new NextResponse(toCsv(table.header, table.body), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    },
  });
}
