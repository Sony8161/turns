// v0.10.1 (Part 10 review finding 8): the CSP is enforced, so a page it
// breaks in production must be noticed. Browsers send violation reports in
// two shapes: the older application/csp-report body and the Reporting API's
// application/reports+json list. From either we keep only the directive and
// the origin of what was blocked (or a keyword such as "inline"), never the
// page URL, the full blocked URL, the sample or the source line: a URL can
// carry an id or a phone in its search. Pure, so the tests read it.

export type CspViolation = { directive: string; blocked: string };

// A fetch directive (script-src, script-src-elem, img-src...) or one of the
// others this policy sets. Anything else is not a real report.
const DIRECTIVE =
  /^([a-z]+-)?src(-elem|-attr)?$|^[a-z]+-src(-elem|-attr)?$|^(frame-ancestors|form-action|base-uri|upgrade-insecure-requests|require-trusted-types-for|trusted-types)$/;
const KEYWORDS = new Set([
  'inline',
  'eval',
  'data',
  'blob',
  'self',
  'wasm-eval',
  'trusted-types-policy',
  'trusted-types-sink',
]);

function directiveOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // "script-src-elem 'self'" (older browsers send the whole directive).
  const name = v.trim().split(/\s+/)[0] ?? '';
  return name.length <= 40 && DIRECTIVE.test(name) ? name : null;
}

function blockedOf(v: unknown): string {
  if (typeof v !== 'string' || v === '') return 'unknown';
  const k = v.toLowerCase();
  if (KEYWORDS.has(k)) return k;
  try {
    const u = new URL(v);
    if (
      u.protocol === 'http:' ||
      u.protocol === 'https:' ||
      u.protocol === 'wss:' ||
      u.protocol === 'ws:'
    ) {
      return u.origin;
    }
    return u.protocol.replace(/:$/, '').slice(0, 20) || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The violations in a report body, at most 10. Anything unreadable is dropped. */
export function parseCspReport(body: unknown): CspViolation[] {
  const out: CspViolation[] = [];
  const add = (directive: unknown, blocked: unknown) => {
    const d = directiveOf(directive);
    if (d && out.length < 10) out.push({ directive: d, blocked: blockedOf(blocked) });
  };
  if (Array.isArray(body)) {
    for (const r of body) {
      const b = (r as { type?: unknown; body?: Record<string, unknown> } | null) ?? {};
      if (b.type !== 'csp-violation' || !b.body) continue;
      add(b.body['effectiveDirective'], b.body['blockedURL']);
    }
  } else if (body && typeof body === 'object') {
    const r = (body as Record<string, unknown>)['csp-report'] as
      Record<string, unknown> | undefined;
    if (r && typeof r === 'object') {
      add(r['effective-directive'] ?? r['violated-directive'], r['blocked-uri']);
    }
  }
  return out;
}
