// Applies every migration in ./drizzle, in order, exactly once.
// Usage: DATABASE_URL=... npm run db:migrate
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

export async function runMigrations(url: string): Promise<void> {
  const client = postgres(url, { max: 1, prepare: false });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end();
  }
}

// import.meta.main (Node 24.2+) avoids a path-string compare that could silently
// turn this into a no-op on Windows or through a symlink.
if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  runMigrations(url).then(
    () => console.log('migrations applied'),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
