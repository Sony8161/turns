import { describe, expect, it } from 'vitest';
import { dictionaries } from '@/i18n/dictionary';
import { meStatusLine } from './status-line';

describe("the technician's status line (v0.16.1)", () => {
  it('a waiting call is the status, not "available"', () => {
    expect(meStatusLine(dictionaries.en, 'available', true)).toBe('A call is waiting for you');
    expect(meStatusLine(dictionaries.vi, 'available', true)).toBe('Bạn có lượt gọi đang chờ');
  });

  it('without a call it is the plain status', () => {
    expect(meStatusLine(dictionaries.en, 'available', false)).toBe('You are available');
    expect(meStatusLine(dictionaries.en, 'in_service', false)).toBe('You are in service');
  });
});
