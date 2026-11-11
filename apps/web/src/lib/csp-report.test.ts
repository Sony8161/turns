import { describe, expect, it } from 'vitest';
import { parseCspReport } from './csp-report';

describe('parseCspReport', () => {
  it('reads the older csp-report body, keeping only directive and origin', () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://turn.example/admin/staff/123?phone=8135550100',
        'violated-directive': "script-src-elem 'self'",
        'effective-directive': 'script-src-elem',
        'blocked-uri': 'https://evil.example/x.js?client=Ngoc',
        'script-sample': 'alert("Ngoc 8135550100")',
      },
    };
    const out = parseCspReport(body);
    expect(out).toEqual([{ directive: 'script-src-elem', blocked: 'https://evil.example' }]);
    expect(JSON.stringify(out)).not.toMatch(/Ngoc|8135550100|admin/);
  });

  it('reads the Reporting API list and skips other report types', () => {
    const body = [
      { type: 'csp-violation', body: { effectiveDirective: 'img-src', blockedURL: 'data' } },
      { type: 'deprecation', body: { id: 'x' } },
      { type: 'csp-violation', body: { effectiveDirective: 'script-src', blockedURL: 'inline' } },
    ];
    expect(parseCspReport(body)).toEqual([
      { directive: 'img-src', blocked: 'data' },
      { directive: 'script-src', blocked: 'inline' },
    ]);
  });

  it('drops junk and caps the count', () => {
    expect(parseCspReport(null)).toEqual([]);
    expect(parseCspReport('x')).toEqual([]);
    expect(parseCspReport({ 'csp-report': { 'violated-directive': 'DROP TABLE; --' } })).toEqual(
      [],
    );
    const many = Array.from({ length: 50 }, () => ({
      type: 'csp-violation',
      body: { effectiveDirective: 'img-src', blockedURL: 'not a url' },
    }));
    const out = parseCspReport(many);
    expect(out).toHaveLength(10);
    expect(out[0]).toEqual({ directive: 'img-src', blocked: 'unknown' });
  });
});
