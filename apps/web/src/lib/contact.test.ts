import { describe, expect, it } from 'vitest';
import { maskContact, parseContact } from './contact';

describe('parseContact', () => {
  it('accepts an email and lowercases it', () => {
    expect(parseContact('  Phu@Example.com ')).toEqual({ kind: 'email', value: 'phu@example.com' });
  });
  it('accepts US phone numbers in common shapes', () => {
    for (const raw of [
      '8135550100',
      '(813) 555-0100',
      '813.555.0100',
      '1 813 555 0100',
      '+1 813-555-0100',
    ]) {
      expect(parseContact(raw)).toEqual({ kind: 'phone', value: '+18135550100' });
    }
  });
  it('strips invisible paste marks and rejects trailing punctuation', () => {
    expect(parseContact('‎phu@example.com')).toEqual({
      kind: 'email',
      value: 'phu@example.com',
    });
    expect(parseContact('phu@example.com,')).toBeNull();
    expect(parseContact("'phu@example.com'")).toBeNull();
  });
  it('rejects numbers outside the North American plan', () => {
    expect(parseContact('1234567890')).toBeNull(); // area code cannot start with 1
    expect(parseContact('813 155 0100')).toBeNull(); // exchange cannot start with 1
    expect(parseContact('+65 6123 4567')).toBeNull();
  });
  it('rejects anything else', () => {
    for (const raw of [
      '',
      'phu',
      'phu@',
      '@example.com',
      '555-0100',
      '+44 20 7946 0958',
      42,
      null,
    ]) {
      expect(parseContact(raw)).toBeNull();
    }
  });
});

describe('maskContact', () => {
  it('never shows a full phone number back', () => {
    expect(maskContact({ kind: 'phone', value: '+18135550100' })).toBe('(•••) •••-0100');
    expect(maskContact({ kind: 'email', value: 'phu@example.com' })).toBe('phu@example.com');
  });
});
