// v0.10.1 (Part 10 review finding 6): what a server component hands the
// browser at run time is not in .next/static. Against a running production
// server (npm run start -w web), fetch the pages anyone can open without
// signing in and scan the HTML they return with the same shapes as the bundle
// scan. A page that answers an error still has its HTML scanned.
// Usage: node scripts/scan-pages.mjs [base URL]   (default http://127.0.0.1:3000)
import { BROWSER_SHAPES } from './secret-shapes.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const PAGES = ['/', '/login', '/join', '/setup', '/kiosk', '/terms', '/privacy', '/no-such-page'];

async function fetchWithRetry(url, tries = 30) {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, { redirect: 'manual' });
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

const problems = [];
for (const page of PAGES) {
  const res = await fetchWithRetry(new URL(page, BASE));
  const text = await res.text();
  for (const shape of BROWSER_SHAPES) {
    for (const m of text.matchAll(new RegExp(shape.re, 'g'))) {
      if (shape.check && !shape.check(m[0])) continue;
      problems.push(`${page} (${res.status}): looks like a ${shape.name}`);
    }
  }
  console.log(`${page}: ${res.status}, ${text.length} bytes`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`pages:scan ok: ${PAGES.length} rendered pages, no secrets`);
