// Both languages carry the same keys, and every {slot} in English exists in
// Vietnamese, so switching language never drops a string.
import { describe, expect, it } from 'vitest';
import { dictionaries, fill } from './dictionary';

function keys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

function slots(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}

function leaves(obj: unknown, prefix = ''): [string, string][] {
  if (typeof obj === 'string') return [[prefix, obj]];
  if (typeof obj !== 'object' || obj === null) return [];
  return Object.entries(obj).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

describe('dictionary', () => {
  it('has the same keys in English and Vietnamese', () => {
    expect(keys(dictionaries.vi).sort()).toEqual(keys(dictionaries.en).sort());
  });

  it('keeps every placeholder slot in both languages', () => {
    const vi = new Map(leaves(dictionaries.vi));
    for (const [key, en] of leaves(dictionaries.en)) {
      expect({ key, slots: slots(vi.get(key) ?? '') }).toEqual({ key, slots: slots(en) });
    }
  });

  it('has no empty strings', () => {
    for (const lang of ['en', 'vi'] as const) {
      for (const [key, value] of leaves(dictionaries[lang])) {
        expect({ lang, key, empty: value.trim() === '' }).toEqual({ lang, key, empty: false });
      }
    }
  });
});

describe('fill', () => {
  it('fills slots and leaves unknown ones visible', () => {
    expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}');
  });
});
