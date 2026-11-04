// Operator command: print one new salon setup code.
// Usage: DATABASE_URL=... npm run db:setup-code -- "note for yourself"
import { createDb } from './server';
import { createSetupCode } from './setup';

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  const note = process.argv.slice(2).join(' ') || undefined;
  const db = createDb(url);
  createSetupCode(db, { note })
    .then((c) => {
      console.log(`salon setup code: ${c.code}`);
      console.log(`expires: ${c.expiresAt.toISOString()}${note ? `  note: ${note}` : ''}`);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.$client.end());
}
