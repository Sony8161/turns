// Demo day seed (v0.12.0): the sample accounts plus three more technicians,
// then a morning built by the engine (demo.ts), then the cheat sheet
// docs/DEMO-EXPECTED.md written from the engine's own answers.
// Local only, and on an empty day: `npm run up -- -Demo` resets the local
// database first. Usage: DATABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run db:seed:demo
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoDay, demoReport, renderDemoExpected } from './demo';
import { HEAVENLY } from './seed';
import { KIOSK_PIN, seedDev } from './seed-dev';
import { createDb } from './server';

export async function seedDemo(url: string): Promise<string> {
  const base = await seedDev(url, { demo: true });
  const db = createDb(url);
  try {
    await buildDemoDay(db, {
      organizationId: HEAVENLY.organizationId,
      locationId: HEAVENLY.locationId,
      ownerUserId: base.ownerId,
      receptionistUserId: base.receptionistId,
      kioskPin: KIOSK_PIN,
    });
    const sheet = renderDemoExpected(await demoReport(db, HEAVENLY.locationId));
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    writeFileSync(join(root, 'docs', 'DEMO-EXPECTED.md'), sheet, 'utf8');
    appendFileSync(
      join(root, 'dev-codes.txt'),
      '\nDemo day loaded. Cheat sheet: docs/DEMO-EXPECTED.md\n',
      'utf8',
    );
    return `${base.notes}\n\nDemo day loaded. Cheat sheet: docs/DEMO-EXPECTED.md`;
  } finally {
    await db.$client.end();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  seedDemo(url).then(
    (notes) => console.log(notes),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
